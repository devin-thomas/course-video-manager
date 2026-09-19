import { Config, Effect } from "effect";
import {
  FOLDER_MIME_TYPE,
  GoogleDriveApiError,
  copyFile,
  createFolder,
  createSmallFile,
  downloadFile,
  getFile,
  listChildren,
  quoteQueryValue,
  replaceFileContent,
  uploadFileFromDisk,
  type DriveFile,
} from "./google-drive-http-client";
import { getValidGoogleDriveAccessToken } from "./google-drive-auth-service";
import { driveUploadConcurrency } from "./google-drive-upload-config";
import {
  splitRelativePath,
  type CourseStorage,
  type RemoteFile,
} from "./course-storage";

const RECEIPT_NAME = "course.json";
const COPY_CONCURRENCY = 4;

const mimeTypeFor = (name: string) =>
  name.endsWith(".json")
    ? "application/json"
    : name.endsWith(".mp4")
      ? "video/mp4"
      : "application/octet-stream";

/**
 * The Course's Bundles as Google Drive holds them: a folder named after the
 * Course inside `GOOGLE_DRIVE_COURSES_FOLDER_ID`, and beneath it the same
 * `versions/{fp}/{section}/{lesson}/{title}.mp4` tree a Dropbox Bundle has.
 *
 * Drive addresses everything by ID and allows several items of one name in a
 * folder, so two rules keep the tree deterministic: when a name is looked up,
 * the OLDEST match wins; and folders are only ever created one at a time,
 * behind a lock, after looking again — so parallel uploads into one lesson
 * folder never race each other into duplicates.
 *
 * The Byte Hash is the file's SHA256, which Drive computes and reports itself
 * (`sha256Checksum`). That is also what the manifest records, so on this
 * backend the receipt and the verification speak the same number.
 *
 * The Commit receipt is `course.json` in the Course folder and keeps ONE file
 * ID for its whole life: the first commit creates it, and every later commit
 * replaces its content in place (`files.update`, `uploadType=media`). Drive
 * swaps the head revision atomically, so a consumer reading that file sees
 * the previous receipt or the new one — never a partial file, never neither.
 * A consumer resolves it the same way this code does: the oldest non-trashed
 * `course.json` in the Course folder. See ADR 0029.
 */
export const openGoogleDriveCourseStorage = Effect.fn(
  "openGoogleDriveCourseStorage"
)(function* (courseName: string) {
  const coursesRootId = yield* Config.string("GOOGLE_DRIVE_COURSES_FOLDER_ID");
  const accessToken = yield* getValidGoogleDriveAccessToken;
  const concurrency = yield* driveUploadConcurrency;
  const folderLock = yield* Effect.makeSemaphore(1);

  /** Lowercased course-relative folder path ("" is the Course folder) → ID. */
  const folderIds = new Map<string, string>();

  const findChildFolder = (parentId: string, name: string) =>
    listChildren({
      accessToken,
      folderId: parentId,
      where: `name = ${quoteQueryValue(name)} and mimeType = ${quoteQueryValue(FOLDER_MIME_TYPE)}`,
    }).pipe(Effect.map((matches) => matches[0] ?? null));

  const courseFolderId = (create: boolean) =>
    Effect.gen(function* () {
      const cached = folderIds.get("");
      if (cached) return cached;
      const found = yield* findChildFolder(coursesRootId, courseName);
      if (found) {
        folderIds.set("", found.id);
        return found.id;
      }
      if (!create) return null;
      const created = yield* createFolder({
        accessToken,
        parentId: coursesRootId,
        name: courseName,
      });
      folderIds.set("", created.id);
      return created.id;
    });

  /**
   * The folder at a course-relative path, or null when it does not exist and
   * `create` is false. Creation runs under the lock and looks before it
   * creates, so concurrent callers converge on one folder.
   */
  const resolveFolder = (relativeDir: string, create: boolean) =>
    Effect.gen(function* () {
      const segments = relativeDir.split("/").filter((s) => s.length > 0);
      const fullKey = segments.join("/").toLowerCase();
      const cached = folderIds.get(fullKey);
      if (cached) return cached;

      const walk = Effect.gen(function* () {
        const root = yield* courseFolderId(create);
        if (!root) return null;
        let parentId: string = root;
        for (let depth = 0; depth < segments.length; depth++) {
          const key = segments
            .slice(0, depth + 1)
            .join("/")
            .toLowerCase();
          const known = folderIds.get(key);
          if (known) {
            parentId = known;
            continue;
          }
          const name = segments[depth]!;
          const found: DriveFile | null = yield* findChildFolder(
            parentId,
            name
          );
          if (found) {
            folderIds.set(key, found.id);
            parentId = found.id;
            continue;
          }
          if (!create) return null;
          const created: DriveFile = yield* createFolder({
            accessToken,
            parentId,
            name,
          });
          folderIds.set(key, created.id);
          parentId = created.id;
        }
        return parentId;
      });

      return create ? yield* folderLock.withPermits(1)(walk) : yield* walk;
    });

  /**
   * Upload and copy responses normally carry the checksum; a file whose
   * checksum is not yet populated is read back once.
   */
  const withChecksum = (file: DriveFile) =>
    file.sha256Checksum
      ? Effect.succeed(file)
      : getFile({ accessToken, fileId: file.id });

  const toRemoteFile = (relativePath: string, file: DriveFile): RemoteFile => ({
    key: relativePath.toLowerCase(),
    relativePath,
    byteHash: file.sha256Checksum ?? "",
    bytes: Number(file.size ?? 0),
    handle: file.id,
  });

  const findReceipt = Effect.gen(function* () {
    const folderId = yield* courseFolderId(false);
    if (!folderId) return null;
    const matches = yield* listChildren({
      accessToken,
      folderId,
      where: `name = ${quoteQueryValue(RECEIPT_NAME)} and mimeType != ${quoteQueryValue(FOLDER_MIME_TYPE)}`,
    });
    return matches[0] ?? null;
  });

  const listTree = (
    folderId: string,
    prefix: string
  ): Effect.Effect<RemoteFile[], GoogleDriveApiError> =>
    Effect.gen(function* () {
      const children: DriveFile[] = yield* listChildren({
        accessToken,
        folderId,
      });
      const files: RemoteFile[] = [];
      const seen = new Set<string>();
      for (const child of children) {
        const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
        if (child.mimeType === FOLDER_MIME_TYPE) {
          folderIds.set(relativePath.toLowerCase(), child.id);
          const nested: RemoteFile[] = yield* listTree(child.id, relativePath);
          files.push(...nested);
          continue;
        }
        // Oldest first (the listing is ordered by createdTime): a duplicate
        // left by an interrupted attempt never shadows the original.
        if (seen.has(relativePath.toLowerCase())) continue;
        seen.add(relativePath.toLowerCase());
        files.push(toRemoteFile(relativePath, child));
      }
      return files;
    });

  const storage: CourseStorage = {
    backend: "google-drive",
    location: `drive:${coursesRootId}/${courseName}`,
    uploadConcurrency: concurrency,
    byteHashOf: (digest) => digest.sha256,

    listFiles: (relativeDir) =>
      Effect.gen(function* () {
        const folderId = yield* resolveFolder(relativeDir, false);
        if (!folderId) return [];
        return yield* listTree(folderId, relativeDir.replace(/\/+$/, ""));
      }),

    readCommitReceipt: () =>
      Effect.gen(function* () {
        const receipt = yield* findReceipt;
        if (!receipt) return { state: "absent" as const };
        const content = yield* downloadFile({
          accessToken,
          fileId: receipt.id,
        });
        return { state: "present" as const, content };
      }),

    uploadFromDisk: (opts) =>
      Effect.gen(function* () {
        const { folders, name } = splitRelativePath(opts.relativePath);
        const parentId = yield* resolveFolder(folders.join("/"), true);
        const uploaded = yield* uploadFileFromDisk({
          accessToken,
          parentId: parentId!,
          name,
          filePath: opts.filePath,
          fileSize: opts.fileSize,
          onChunk: opts.onChunk,
          onProgress: opts.onProgress,
        });
        return toRemoteFile(opts.relativePath, yield* withChecksum(uploaded));
      }),

    writeNewFile: (relativePath, content) =>
      Effect.gen(function* () {
        const { folders, name } = splitRelativePath(relativePath);
        const parentId = yield* resolveFolder(folders.join("/"), true);
        yield* createSmallFile({
          accessToken,
          parentId: parentId!,
          name,
          content,
          mimeType: mimeTypeFor(name),
        });
      }),

    copyFiles: (entries) =>
      Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const { folders, name } = splitRelativePath(entry.toRelativePath);
            const parentId = yield* resolveFolder(folders.join("/"), true);
            const copied = yield* copyFile({
              accessToken,
              fileId: entry.from.handle,
              parentId: parentId!,
              name,
            });
            return {
              ok: true as const,
              file: toRemoteFile(
                entry.toRelativePath,
                yield* withChecksum(copied)
              ),
            };
          }).pipe(
            // Per entry: one unreachable source must not fail its siblings.
            Effect.catchTag("GoogleDriveApiError", (error) =>
              Effect.succeed({ ok: false as const, message: error.message })
            )
          ),
        { concurrency: COPY_CONCURRENCY }
      ),

    commitReceipt: (content) =>
      Effect.gen(function* () {
        const existing = yield* findReceipt;
        if (existing) {
          yield* replaceFileContent({
            accessToken,
            fileId: existing.id,
            content,
            mimeType: "application/json",
          });
          return;
        }
        const folderId = yield* courseFolderId(true);
        yield* createSmallFile({
          accessToken,
          parentId: folderId!,
          name: RECEIPT_NAME,
          content,
          mimeType: "application/json",
        });
      }),
  };
  return storage;
});
