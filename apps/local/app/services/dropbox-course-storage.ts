import { Config, Effect } from "effect";
import {
  copyBatch,
  download,
  getMetadata,
  listFolder,
  uploadFile,
  uploadFileFromDisk,
  type DropboxFileMetadata,
} from "./dropbox-http-client";
import { getValidDropboxAccessToken } from "./dropbox-auth-service";
import { uploadConcurrency } from "./dropbox-upload-config";
import type { CourseStorage, RemoteFile } from "./course-storage";

/**
 * The Course's Bundles as Dropbox holds them, under
 * `{DROPBOX_REMOTE_PATH}/{courseName}`. Dropbox paths are case-insensitive, so
 * a listing is keyed by the lowercased path exactly as it always was.
 */
export const openDropboxCourseStorage = Effect.fn("openDropboxCourseStorage")(
  function* (courseName: string) {
    const remotePath = yield* Config.string("DROPBOX_REMOTE_PATH");
    const accessToken = yield* getValidDropboxAccessToken;
    const concurrency = yield* uploadConcurrency;
    const courseDir = `${remotePath}/${courseName}`;
    const prefix = `${courseDir}/`.toLowerCase();

    const toRemoteFile = (metadata: DropboxFileMetadata): RemoteFile => {
      const lower = metadata.path_display.toLowerCase();
      const relativePath = lower.startsWith(prefix)
        ? metadata.path_display.slice(prefix.length)
        : metadata.path_display;
      return {
        key: relativePath.toLowerCase(),
        relativePath,
        byteHash: metadata.content_hash,
        bytes: metadata.size,
        handle: metadata.path_display,
      };
    };

    const absolute = (relativePath: string) => `${courseDir}/${relativePath}`;

    const storage: CourseStorage = {
      backend: "dropbox",
      location: courseDir,
      uploadConcurrency: concurrency,
      byteHashOf: (digest) => digest.contentHash,

      listFiles: (relativeDir) =>
        Effect.gen(function* () {
          const dir = absolute(relativeDir);
          const existing = yield* getMetadata({ accessToken, path: dir }).pipe(
            Effect.catchTag("DropboxApiError", () => Effect.succeed(null))
          );
          if (!existing || existing[".tag"] !== "folder") return [];
          const entries = yield* listFolder({
            accessToken,
            path: dir,
            recursive: true,
          });
          return entries
            .filter((entry) => entry[".tag"] === "file")
            .map((entry) => toRemoteFile(entry as DropboxFileMetadata));
        }),

      readCommitReceipt: () =>
        download({ accessToken, path: absolute("course.json") }).pipe(
          Effect.map((content) => ({ state: "present" as const, content })),
          // 409 is Dropbox's "path/not_found"; anything else is a real failure
          // the caller must not mistake for "never committed".
          Effect.catchIf(
            (error) => error.status === 409,
            () => Effect.succeed({ state: "absent" as const })
          )
        ),

      uploadFromDisk: (opts) =>
        uploadFileFromDisk({
          accessToken,
          path: absolute(opts.relativePath),
          filePath: opts.filePath,
          fileSize: opts.fileSize,
          onChunk: opts.onChunk,
          onProgress: opts.onProgress,
        }).pipe(Effect.map(toRemoteFile)),

      writeNewFile: (relativePath, content) =>
        uploadFile({ accessToken, path: absolute(relativePath), content }).pipe(
          Effect.asVoid
        ),

      copyFiles: (entries) =>
        copyBatch({
          accessToken,
          entries: entries.map((entry) => ({
            fromPath: entry.from.handle,
            toPath: absolute(entry.toRelativePath),
          })),
        }).pipe(
          Effect.map((results) =>
            results.map((result) =>
              result.ok
                ? { ok: true as const, file: toRemoteFile(result.metadata) }
                : { ok: false as const, message: result.message }
            )
          )
        ),

      // Dropbox replaces a file's contents in one step on an overwrite-mode
      // upload, which is what made this the commit marker in the first place.
      commitReceipt: (content) =>
        uploadFile({
          accessToken,
          path: absolute("course.json"),
          content,
          mode: "overwrite",
        }).pipe(Effect.asVoid),
    };
    return storage;
  }
);
