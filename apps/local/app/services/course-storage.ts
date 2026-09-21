import { ConfigError, Effect } from "effect";
import type { GoogleDriveApiError } from "./google-drive-http-client";

/**
 * Where a Course's Bundles and its Commit receipt live, seen from the Publish.
 *
 * Google Drive is the only implementation (`google-drive-course-storage.ts`,
 * ADR 0029). The boundary stays because it names exactly what a Publish needs
 * from a store, and nothing about how Drive provides it.
 *
 * Every path here is COURSE-RELATIVE (`versions/{fp}/{section}/{lesson}/x.mp4`,
 * `course.json`). How a backend turns that into its own addressing — for
 * Drive, a chain of folder IDs under `GOOGLE_DRIVE_COURSES_FOLDER_ID` — is its
 * own business.
 *
 * The one idea the Publish leans on is the BYTE HASH: the checksum the backend
 * itself reports for a stored file. It is what a landed file is verified
 * against, what the reuse plan is indexed by, and what a server-side copy is
 * checked with. It must be the file's SHA256 — the same digest the Export
 * Digest sidecar caches and the manifest records — so a local file and a
 * stored one are compared without any translation.
 */
export type RemoteFile = {
  /** Course-relative path, lowercased — the key a listing is indexed by. */
  key: string;
  /** Course-relative path as the backend displays it. */
  relativePath: string;
  /** The SHA256 the backend reports for the stored bytes. */
  byteHash: string;
  bytes: number;
  /** The backend's own locator (a Drive file ID). */
  handle: string;
};

export type CopyResult =
  { ok: true; file: RemoteFile } | { ok: false; message: string };

export type CommitReceipt =
  { state: "absent" } | { state: "present"; content: Buffer };

export type RemoteStorageError = GoogleDriveApiError;

export const isRemoteStorageError = (e: unknown): e is RemoteStorageError =>
  typeof e === "object" &&
  e !== null &&
  "_tag" in e &&
  e._tag === "GoogleDriveApiError";

export type CourseStorage = {
  /** Human-readable location of the Course, for logs and messages. */
  location: string;
  /** How many Videos may stream at once. */
  uploadConcurrency: number;
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

/** Split a course-relative path into its folder segments and its file name. */
export const splitRelativePath = (relativePath: string) => {
  const segments = relativePath.split("/").filter((s) => s.length > 0);
  const name = segments.pop() ?? "";
  return { folders: segments, name };
};
