import { Config } from "effect";

/**
 * Tunables for the Google Drive leg of a Publish. Resident memory is roughly
 * `GOOGLE_DRIVE_UPLOAD_CONCURRENCY × GOOGLE_DRIVE_UPLOAD_CHUNK_SIZE_MB`, since
 * each in-flight resumable session holds one chunk at a time.
 */
export const DEFAULT_DRIVE_UPLOAD_CONCURRENCY = 4;
export const DEFAULT_DRIVE_UPLOAD_CHUNK_SIZE_MB = 16;

export const driveUploadConcurrency = Config.integer(
  "GOOGLE_DRIVE_UPLOAD_CONCURRENCY"
).pipe(
  Config.withDefault(DEFAULT_DRIVE_UPLOAD_CONCURRENCY),
  Config.validate({
    message: "GOOGLE_DRIVE_UPLOAD_CONCURRENCY must be at least 1",
    validation: (value) => value >= 1,
  })
);

export const driveUploadChunkSizeBytes = Config.integer(
  "GOOGLE_DRIVE_UPLOAD_CHUNK_SIZE_MB"
).pipe(
  Config.withDefault(DEFAULT_DRIVE_UPLOAD_CHUNK_SIZE_MB),
  Config.validate({
    message: "GOOGLE_DRIVE_UPLOAD_CHUNK_SIZE_MB must be at least 1",
    validation: (value) => value >= 1,
  }),
  Config.map((megabytes) => megabytes * 1024 * 1024)
);
