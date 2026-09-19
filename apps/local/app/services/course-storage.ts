import { Config, ConfigError, Effect } from "effect";
import type { ExportDigest } from "./export-sha256-sidecar";
import type { DropboxApiError } from "./dropbox-http-client";
import type { GoogleDriveApiError } from "./google-drive-http-client";

/**
 * Where a Course's Bundles and its Commit receipt live, seen from the Publish.
 *
 * Every path here is COURSE-RELATIVE (`versions/{fp}/{section}/{lesson}/x.mp4`,
 * `course.json`). How a backend turns that into its own addressing — a Dropbox
 * path under `DROPBOX_REMOTE_PATH`, or a chain of Google Drive folder IDs under
 * `GOOGLE_DRIVE_COURSES_FOLDER_ID` — is its own business.
 *
 * The one backend-specific idea the Publish leans on is the BYTE HASH: the
 * checksum the backend itself reports for a stored file. It is what a landed
 * file is verified against, what the reuse plan is indexed by, and what a
 * server-side copy is checked with. Dropbox's is its block-based `content_hash`;
 * Google Drive's is the file's SHA256. Both are always computed locally (see
 * the Export Digest), so a backend only has to say which one is its own.
 */
export type RemoteFile = {
  /** Course-relative path, lowercased — the key a listing is indexed by. */
  key: string;
  /** Course-relative path as the backend displays it. */
  relativePath: string;
  byteHash: string;
  bytes: number;
  /** The backend's own locator: a Dropbox path, or a Drive file ID. */
  handle: string;
};

export type CopyResult =
  { ok: true; file: RemoteFile } | { ok: false; message: string };

export type CommitReceipt =
  { state: "absent" } | { state: "present"; content: Buffer };

export type RemoteStorageError = DropboxApiError | GoogleDriveApiError;

export const isRemoteStorageError = (e: unknown): e is RemoteStorageError =>
  typeof e === "object" &&
  e !== null &&
  "_tag" in e &&
  (e._tag === "DropboxApiError" || e._tag === "GoogleDriveApiError");

export type CourseStorage = {
  backend: CourseStorageBackend;
  /** Human-readable location of the Course, for logs and messages. */
  location: string;
  /** How many Videos may stream at once for this backend. */
  uploadConcurrency: number;
  /** Which of an export's local digests is this backend's Byte Hash. */
  byteHashOf: (digest: Pick<ExportDigest, "sha256" | "contentHash">) => string;
  /** Every file under a course-relative directory, recursively. Empty if absent. */
  listFiles: (
    relativeDir: string
  ) => Effect.Effect<RemoteFile[], RemoteStorageError>;
  /** The current Commit receipt (`course.json`), if one has been written. */
  readCommitReceipt: () => Effect.Effect<CommitReceipt, RemoteStorageError>;
  /**
   * Stream a file from disk to a new course-relative path. `onChunk` sees every
   * byte exactly once, in order, so the caller can digest off the same pass.
   */
  uploadFromDisk: (opts: {
    relativePath: string;
    filePath: string;
    fileSize: number;
    onChunk?: (chunk: Buffer) => void;
    onProgress?: (uploaded: number, total: number) => void;
  }) => Effect.Effect<RemoteFile, RemoteStorageError | ConfigError.ConfigError>;
  /** Write a small file that must not already exist (schema, manifest). */
  writeNewFile: (
    relativePath: string,
    content: Buffer
  ) => Effect.Effect<void, RemoteStorageError | ConfigError.ConfigError>;
  /**
   * Duplicate files inside the backend's own storage. Per entry, in order: one
   * unreachable source must not fail its siblings.
   */
  copyFiles: (
    entries: ReadonlyArray<{ from: RemoteFile; toRelativePath: string }>
  ) => Effect.Effect<CopyResult[], RemoteStorageError>;
  /**
   * Replace `course.json` — the sole commit marker, and the last write of a
   * Publish. A consumer must see either the previous receipt or this one,
   * never a partial file and never neither.
   */
  commitReceipt: (
    content: Buffer
  ) => Effect.Effect<void, RemoteStorageError | ConfigError.ConfigError>;
};

export type CourseStorageBackend = "dropbox" | "google-drive";

export const courseStorageBackend = Config.literal(
  "dropbox",
  "google-drive"
)("COURSE_STORAGE_BACKEND").pipe(Config.withDefault("dropbox" as const));

/** Split a course-relative path into its folder segments and its file name. */
export const splitRelativePath = (relativePath: string) => {
  const segments = relativePath.split("/").filter((s) => s.length > 0);
  const name = segments.pop() ?? "";
  return { folders: segments, name };
};
