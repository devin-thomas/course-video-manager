import { Data, Duration, Effect, Schedule } from "effect";
import { open as fsOpen, type FileHandle } from "node:fs/promises";
import { driveUploadChunkSizeBytes } from "./google-drive-upload-config";

export class GoogleDriveApiError extends Data.TaggedError(
  "GoogleDriveApiError"
)<{
  message: string;
  status?: number;
  endpoint?: string;
}> {}

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/** The fields every call asks for, so a file is always described the same way. */
export const FILE_FIELDS =
  "id,name,mimeType,size,sha256Checksum,createdTime,parents";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  sha256Checksum?: string;
  createdTime?: string;
  parents?: string[];
};

const isTransient = (status: number) =>
  status === 429 || (status >= 500 && status <= 599);

const retrySchedule = Schedule.intersect(
  Schedule.exponential(Duration.seconds(1)),
  Schedule.recurs(5)
);

class TransientDriveError extends Data.TaggedError("TransientDriveError")<{
  error: GoogleDriveApiError;
}> {}

/**
 * One request, retried in place on 429 and 5xx. Google also signals rate
 * limiting as 403 `userRateLimitExceeded` / `rateLimitExceeded`, which is
 * retried the same way.
 */
const driveFetch = Effect.fn("googleDriveFetch")(function* (
  url: string,
  init: RequestInit,
  endpoint: string,
  okStatuses: ReadonlyArray<number> = []
) {
  return yield* Effect.tryPromise({
    try: () => fetch(url, init),
    catch: (e) =>
      new GoogleDriveApiError({
        message: e instanceof Error ? e.message : "Network error",
        endpoint,
      }),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.ok || okStatuses.includes(response.status)) {
        return Effect.succeed(response);
      }
      return Effect.promise(() => response.text()).pipe(
        Effect.flatMap(
          (
            text
          ): Effect.Effect<
            never,
            GoogleDriveApiError | TransientDriveError
          > => {
            const error = new GoogleDriveApiError({
              message: `Google Drive ${endpoint} ${response.status}: ${text}`,
              status: response.status,
              endpoint,
            });
            const rateLimited =
              response.status === 403 && /rateLimitExceeded/i.test(text);
            return isTransient(response.status) || rateLimited
              ? Effect.fail(new TransientDriveError({ error }))
              : Effect.fail(error);
          }
        )
      );
    }),
    Effect.retry({
      schedule: retrySchedule,
      while: (e) => e._tag === "TransientDriveError",
    }),
    Effect.catchTag("TransientDriveError", (e) => Effect.fail(e.error))
  );
});

const json = <T>(response: Response, endpoint: string) =>
  Effect.tryPromise({
    try: () => response.json() as Promise<T>,
    catch: (e) =>
      new GoogleDriveApiError({
        message: `Failed to parse ${endpoint} response: ${e}`,
        endpoint,
      }),
  });

const authHeaders = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
});

/** Drive query literals are single-quoted; quotes and backslashes escape. */
export const quoteQueryValue = (value: string) =>
  `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** Every non-trashed child of a folder, across pages. */
export const listChildren = Effect.fn("googleDriveListChildren")(
  function* (opts: {
    accessToken: string;
    folderId: string;
    /** Extra `q` clause, ANDed with the parent filter. */
    where?: string;
  }) {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${DRIVE_API}/files`);
      const q = [
        `${quoteQueryValue(opts.folderId)} in parents`,
        "trashed = false",
        ...(opts.where ? [opts.where] : []),
      ].join(" and ");
      url.searchParams.set("q", q);
      url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("orderBy", "createdTime");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = yield* driveFetch(
        url.toString(),
        { method: "GET", headers: authHeaders(opts.accessToken) },
        "files.list"
      );
      const page = yield* json<{ nextPageToken?: string; files: DriveFile[] }>(
        response,
        "files.list"
      );
      files.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }
);

export const createFolder = Effect.fn("googleDriveCreateFolder")(
  function* (opts: { accessToken: string; parentId: string; name: string }) {
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set("fields", FILE_FIELDS);
    url.searchParams.set("supportsAllDrives", "true");
    const response = yield* driveFetch(
      url.toString(),
      {
        method: "POST",
        headers: {
          ...authHeaders(opts.accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: opts.name,
          mimeType: FOLDER_MIME_TYPE,
          parents: [opts.parentId],
        }),
      },
      "files.create(folder)"
    );
    return yield* json<DriveFile>(response, "files.create(folder)");
  }
);

const MULTIPART_BOUNDARY = "cvm-drive-multipart-boundary";

/** A small file in one request: metadata and bytes together. */
export const createSmallFile = Effect.fn("googleDriveCreateSmallFile")(
  function* (opts: {
    accessToken: string;
    parentId: string;
    name: string;
    content: Buffer;
    mimeType?: string;
  }) {
    const url = new URL(`${DRIVE_UPLOAD_API}/files`);
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("fields", FILE_FIELDS);
    url.searchParams.set("supportsAllDrives", "true");
    const mimeType = opts.mimeType ?? "application/octet-stream";
    const body = Buffer.concat([
      Buffer.from(
        `--${MULTIPART_BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
          JSON.stringify({ name: opts.name, parents: [opts.parentId] }) +
          `\r\n--${MULTIPART_BOUNDARY}\r\nContent-Type: ${mimeType}\r\n\r\n`
      ),
      opts.content,
      Buffer.from(`\r\n--${MULTIPART_BOUNDARY}--`),
    ]);
    const response = yield* driveFetch(
      url.toString(),
      {
        method: "POST",
        headers: {
          ...authHeaders(opts.accessToken),
          "Content-Type": `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
        },
        body: new Uint8Array(body),
      },
      "files.create(multipart)"
    );
    return yield* json<DriveFile>(response, "files.create(multipart)");
  }
);

/**
 * Replace an existing file's bytes. Drive makes the new content the file's
 * head revision in one step, so a reader of this file ID sees the old bytes
 * or the new ones and never a mixture — the property the Commit receipt needs.
 */
export const replaceFileContent = Effect.fn("googleDriveReplaceFileContent")(
  function* (opts: {
    accessToken: string;
    fileId: string;
    content: Buffer;
    mimeType?: string;
  }) {
    const url = new URL(`${DRIVE_UPLOAD_API}/files/${opts.fileId}`);
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("fields", FILE_FIELDS);
    url.searchParams.set("supportsAllDrives", "true");
    const response = yield* driveFetch(
      url.toString(),
      {
        method: "PATCH",
        headers: {
          ...authHeaders(opts.accessToken),
          "Content-Type": opts.mimeType ?? "application/octet-stream",
        },
        body: new Uint8Array(opts.content),
      },
      "files.update(media)"
    );
    return yield* json<DriveFile>(response, "files.update(media)");
  }
);

export const downloadFile = Effect.fn("googleDriveDownloadFile")(
  function* (opts: { accessToken: string; fileId: string }) {
    const url = new URL(`${DRIVE_API}/files/${opts.fileId}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    const response = yield* driveFetch(
      url.toString(),
      { method: "GET", headers: authHeaders(opts.accessToken) },
      "files.get(media)"
    );
    return yield* Effect.tryPromise({
      try: async () => Buffer.from(await response.arrayBuffer()),
      catch: (e) =>
        new GoogleDriveApiError({
          message: `Failed to read download: ${e}`,
          endpoint: "files.get(media)",
        }),
    });
  }
);

export const getFile = Effect.fn("googleDriveGetFile")(function* (opts: {
  accessToken: string;
  fileId: string;
}) {
  const url = new URL(`${DRIVE_API}/files/${opts.fileId}`);
  url.searchParams.set("fields", FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  const response = yield* driveFetch(
    url.toString(),
    { method: "GET", headers: authHeaders(opts.accessToken) },
    "files.get"
  );
  return yield* json<DriveFile>(response, "files.get");
});

/** Server-side duplicate: no bytes cross the wire. */
export const copyFile = Effect.fn("googleDriveCopyFile")(function* (opts: {
  accessToken: string;
  fileId: string;
  parentId: string;
  name: string;
}) {
  const url = new URL(`${DRIVE_API}/files/${opts.fileId}/copy`);
  url.searchParams.set("fields", FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  const response = yield* driveFetch(
    url.toString(),
    {
      method: "POST",
      headers: {
        ...authHeaders(opts.accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: opts.name, parents: [opts.parentId] }),
    },
    "files.copy"
  );
  return yield* json<DriveFile>(response, "files.copy");
});

/** Drive requires every chunk but the last to be a multiple of 256 KiB. */
const CHUNK_GRANULARITY = 256 * 1024;

const readChunk = (fh: FileHandle, position: number, size: number) =>
  Effect.tryPromise({
    try: async () => {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, position);
      return bytesRead < size ? buf.subarray(0, bytesRead) : buf;
    },
    catch: (e) =>
      new GoogleDriveApiError({
        message: `Failed to read file chunk at offset ${position}: ${e}`,
        endpoint: "files.create(resumable)",
      }),
  });

/** `Range: bytes=0-N` on a 308 → N + 1 bytes are safely stored. */
const committedBytes = (response: Response) => {
  const range = response.headers.get("Range");
  const match = range?.match(/bytes=0-(\d+)/);
  return match ? Number(match[1]) + 1 : 0;
};

/**
 * Stream a file from disk through a resumable upload session.
 *
 * `onChunk` sees every byte exactly once, in file order. If Drive reports that
 * it kept fewer bytes than were sent, the rest are sent again from disk, but
 * only bytes beyond everything already handed to `onChunk` are handed over,
 * so a digest built there stays correct.
 */
export const uploadFileFromDisk = Effect.fn("googleDriveUploadFileFromDisk")(
  function* (opts: {
    accessToken: string;
    parentId: string;
    name: string;
    filePath: string;
    fileSize: number;
    onChunk?: (chunk: Buffer) => void;
    onProgress?: (uploaded: number, total: number) => void;
  }) {
    const configured = yield* driveUploadChunkSizeBytes;
    const chunkSize = Math.max(
      CHUNK_GRANULARITY,
      Math.floor(configured / CHUNK_GRANULARITY) * CHUNK_GRANULARITY
    );

    const start = new URL(`${DRIVE_UPLOAD_API}/files`);
    start.searchParams.set("uploadType", "resumable");
    start.searchParams.set("fields", FILE_FIELDS);
    start.searchParams.set("supportsAllDrives", "true");
    const session = yield* driveFetch(
      start.toString(),
      {
        method: "POST",
        headers: {
          ...authHeaders(opts.accessToken),
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(opts.fileSize),
        },
        body: JSON.stringify({ name: opts.name, parents: [opts.parentId] }),
      },
      "files.create(resumable)"
    );
    const sessionUri = session.headers.get("Location");
    if (!sessionUri) {
      return yield* new GoogleDriveApiError({
        message: "Resumable upload session returned no Location",
        endpoint: "files.create(resumable)",
      });
    }

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => fsOpen(opts.filePath, "r"),
        catch: (e) =>
          new GoogleDriveApiError({
            message: `Failed to open file for upload: ${e}`,
            endpoint: "files.create(resumable)",
          }),
      }),
      (fh) =>
        Effect.gen(function* () {
          let offset = 0;
          let digestedUpTo = 0;
          // A zero-byte file is still one (empty) request.
          while (true) {
            const size = Math.min(chunkSize, opts.fileSize - offset);
            const chunk =
              size > 0 ? yield* readChunk(fh, offset, size) : Buffer.alloc(0);
            const chunkEnd = offset + chunk.byteLength;
            if (chunkEnd > digestedUpTo) {
              opts.onChunk?.(chunk.subarray(digestedUpTo - offset));
              digestedUpTo = chunkEnd;
            }
            const contentRange =
              chunk.byteLength === 0
                ? `bytes */${opts.fileSize}`
                : `bytes ${offset}-${chunkEnd - 1}/${opts.fileSize}`;
            const response = yield* driveFetch(
              sessionUri,
              {
                method: "PUT",
                headers: {
                  ...authHeaders(opts.accessToken),
                  "Content-Length": String(chunk.byteLength),
                  "Content-Range": contentRange,
                },
                body: new Uint8Array(chunk),
              },
              "files.create(resumable chunk)",
              [308]
            );
            if (response.status !== 308) {
              opts.onProgress?.(opts.fileSize, opts.fileSize);
              return yield* json<DriveFile>(
                response,
                "files.create(resumable)"
              );
            }
            offset = committedBytes(response);
            opts.onProgress?.(offset, opts.fileSize);
          }
        }),
      (fh) => Effect.promise(() => fh.close())
    );
  }
);

/** Move a file to Drive's trash — recoverable for 30 days, never a hard delete. */
export const trashFile = Effect.fn("googleDriveTrashFile")(function* (opts: {
  accessToken: string;
  fileId: string;
}) {
  const url = new URL(`${DRIVE_API}/files/${opts.fileId}`);
  url.searchParams.set("supportsAllDrives", "true");
  yield* driveFetch(
    url.toString(),
    {
      method: "PATCH",
      headers: {
        ...authHeaders(opts.accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
    },
    "files.update(trash)"
  );
});
