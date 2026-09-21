import { vi } from "vitest";
import { createHash } from "node:crypto";

export const FAKE_DRIVE_ACCESS_TOKEN = "fake-google-drive-access-token";
export const FAKE_COURSES_FOLDER_ID = "fake-courses-root";

const FOLDER = "application/vnd.google-apps.folder";

type StoredItem = {
  id: string;
  name: string;
  mimeType: string;
  parentId: string;
  content: Buffer;
  createdAt: number;
  trashed: boolean;
  revisions: number;
};

export type DriveRequestMatcher = (url: URL, init: RequestInit) => boolean;
type Matcher = DriveRequestMatcher;

/** A request's lifetime on a logical clock, so overlap is computable. */
type RequestSpan = { url: URL; init: RequestInit; start: number; end: number };

const json = (status: number, body: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const requestMethod = (init: RequestInit) =>
  (init.method ?? "GET").toUpperCase();

/** The start of a resumable upload session — one per Video a Publish sends. */
export const isVideoUploadStart: DriveRequestMatcher = (url, init) =>
  requestMethod(init) === "POST" &&
  url.pathname === "/upload/drive/v3/files" &&
  url.searchParams.get("uploadType") === "resumable";

/** A server-side `files.copy` — one per reused Video. */
export const isCopyRequest: DriveRequestMatcher = (url, init) =>
  requestMethod(init) === "POST" &&
  /^\/drive\/v3\/files\/[^/]+\/copy$/.test(url.pathname);

/** The in-place `files.update` that replaces `course.json` on a commit. */
export const isReceiptReplace: DriveRequestMatcher = (url, init) =>
  requestMethod(init) === "PATCH" &&
  url.pathname.startsWith("/upload/drive/v3/files/") &&
  url.searchParams.get("uploadType") === "media";

/** A multipart create — a small file: schema, manifest, first receipt. */
export const isSmallFileCreate: DriveRequestMatcher = (url, init) =>
  requestMethod(init) === "POST" &&
  url.pathname === "/upload/drive/v3/files" &&
  url.searchParams.get("uploadType") === "multipart";

const bodyBuffer = (init: RequestInit) => {
  const body = init.body;
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body, "utf-8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error("fake-google-drive: unsupported request body");
};

/**
 * An in-memory Google Drive, reached through a stubbed `fetch`: the v3 file
 * list/get/create/copy/update calls and the multipart, media and resumable
 * upload protocols the Drive course storage uses. Checksums are real SHA256s
 * of the stored bytes, so verification genuinely compares bytes.
 */
export const createFakeGoogleDrive = () => {
  const items = new Map<string, StoredItem>();
  const sessions = new Map<
    string,
    { name: string; parentId: string; total: number; received: Buffer[] }
  >();
  const calls: Array<{ method: string; url: URL; init: RequestInit }> = [];
  let counter = 0;
  const baseTime = Date.now();
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  const failures: Array<{
    match: Matcher;
    remaining: number;
    status: number;
    body?: string;
  }> = [];
  /** A resumable PUT that keeps only this many bytes of its chunk, once. */
  const partialAccepts: Array<{ keepBytes: number; remaining: number }> = [];

  // ── In-flight instrumentation ──────────────────────────────────────
  // Requests are timestamped on a logical clock rather than a wall clock, so
  // peak-concurrency assertions never depend on timing.
  const requestSpans: RequestSpan[] = [];
  let logicalClock = 0;

  /** The most matching requests that were ever in flight at once. */
  const peakConcurrentRequests = (match: Matcher = () => true) => {
    const events: Array<{ at: number; delta: number }> = [];
    for (const span of requestSpans) {
      if (!match(span.url, span.init)) continue;
      events.push({ at: span.start, delta: 1 });
      events.push({ at: span.end, delta: -1 });
    }
    events.sort((a, b) => a.at - b.at || a.delta - b.delta);
    let current = 0;
    let peak = 0;
    for (const event of events) {
      current += event.delta;
      peak = Math.max(peak, current);
    }
    return peak;
  };

  // ── Deterministic concurrency barrier ──────────────────────────────
  let barrier: {
    count: number;
    match: Matcher;
    waiting: Array<() => void>;
  } | null = null;

  const releaseBarrier = () => {
    const pending = barrier;
    barrier = null;
    for (const resolve of pending?.waiting ?? []) resolve();
  };

  /**
   * Hold every matching request open until `count` of them are in flight at
   * once, then release them all and stop holding. No timers are involved, so
   * a caller that sends serially never trips the barrier and the test hangs
   * to its timeout rather than passing by accident.
   */
  const holdUntilInFlight = (count: number, match: Matcher = () => true) => {
    barrier = { count, match, waiting: [] };
    return releaseBarrier;
  };

  // ── Arrival watchers ───────────────────────────────────────────────
  const requestWatchers: Array<{ match: Matcher; resolve: () => void }> = [];

  /**
   * Resolves the moment a matching request ARRIVES — before any barrier,
   * injected failure or dispatch — so a test can wait on "this Video started
   * uploading" without polling or sleeping.
   */
  const waitForRequest = (match: Matcher = () => true) =>
    new Promise<void>((resolve) => {
      requestWatchers.push({ match, resolve });
    });

  const notifyWatchers = (url: URL, init: RequestInit) => {
    for (let index = requestWatchers.length - 1; index >= 0; index--) {
      if (!requestWatchers[index]!.match(url, init)) continue;
      requestWatchers.splice(index, 1)[0]!.resolve();
    }
  };

  items.set(FAKE_COURSES_FOLDER_ID, {
    id: FAKE_COURSES_FOLDER_ID,
    name: "courses",
    mimeType: FOLDER,
    parentId: "root",
    content: Buffer.alloc(0),
    createdAt: 0,
    trashed: false,
    revisions: 1,
  });

  const describe = (item: StoredItem) => ({
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    parents: [item.parentId],
    createdTime: new Date(item.createdAt).toISOString(),
    ...(item.mimeType === FOLDER
      ? {}
      : {
          size: String(item.content.byteLength),
          sha256Checksum: createHash("sha256")
            .update(item.content)
            .digest("hex"),
        }),
  });

  const store = (opts: {
    name: string;
    mimeType: string;
    parentId: string;
    content?: Buffer;
    createdAt?: number;
  }) => {
    const item: StoredItem = {
      id: nextId(opts.mimeType === FOLDER ? "folder" : "file"),
      name: opts.name,
      mimeType: opts.mimeType,
      parentId: opts.parentId,
      content: opts.content ?? Buffer.alloc(0),
      createdAt: opts.createdAt ?? baseTime + ++counter,
      trashed: false,
      revisions: 1,
    };
    items.set(item.id, item);
    return item;
  };

  const unquote = (value: string) =>
    value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");

  /** Just enough of Drive's `q` grammar for the clauses the client emits. */
  const matchesQuery = (item: StoredItem, q: string) => {
    for (const clause of q.split(" and ")) {
      const parent = clause.match(/^('(?:[^'\\]|\\.)*') in parents$/);
      if (parent) {
        if (item.parentId !== unquote(parent[1]!)) return false;
        continue;
      }
      if (clause === "trashed = false") {
        if (item.trashed) return false;
        continue;
      }
      const created = clause.match(/^createdTime < '([^']+)'$/);
      if (created) {
        if (!(item.createdAt < Date.parse(created[1]!))) return false;
        continue;
      }
      const cmp = clause.match(/^(name|mimeType) (=|!=) ('(?:[^'\\]|\\.)*')$/);
      if (cmp) {
        const actual = cmp[1] === "name" ? item.name : item.mimeType;
        const equal = actual === unquote(cmp[3]!);
        if (cmp[2] === "=" ? !equal : equal) return false;
        continue;
      }
      throw new Error(`fake-google-drive: unsupported query clause: ${clause}`);
    }
    return true;
  };

  const parseMultipart = (init: RequestInit) => {
    const contentType = new Headers(init.headers).get("Content-Type") ?? "";
    const boundary = contentType.match(/boundary=(.+)$/)![1]!;
    const raw = bodyBuffer(init);
    const delimiter = Buffer.from(`--${boundary}`);
    const parts: Buffer[] = [];
    let cursor = raw.indexOf(delimiter);
    while (cursor !== -1) {
      const start = cursor + delimiter.length;
      const next = raw.indexOf(delimiter, start);
      if (next === -1) break;
      parts.push(raw.subarray(start, next));
      cursor = next;
    }
    const partBody = (part: Buffer) => {
      const split = part.indexOf("\r\n\r\n");
      let body = part.subarray(split + 4);
      if (body.subarray(-2).toString() === "\r\n") body = body.subarray(0, -2);
      return body;
    };
    const metadata = JSON.parse(partBody(parts[0]!).toString("utf-8"));
    return { metadata, content: partBody(parts[1]!) };
  };

  const dispatch = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = requestMethod(init);

    const auth = new Headers(init.headers).get("Authorization");
    if (auth !== `Bearer ${FAKE_DRIVE_ACCESS_TOKEN}`) {
      return json(401, { error: { message: "bad token" } });
    }

    const failure = failures.find((f) => f.remaining > 0 && f.match(url, init));
    if (failure) {
      failure.remaining--;
      return new Response(failure.body ?? "injected failure", {
        status: failure.status,
      });
    }

    const path = url.pathname;

    // Resumable session chunks.
    if (method === "PUT" && url.searchParams.has("upload_id")) {
      const session = sessions.get(url.searchParams.get("upload_id")!);
      if (!session) return json(404, { error: { message: "no session" } });
      const range = new Headers(init.headers).get("Content-Range")!;
      const chunk = bodyBuffer(init);
      const have = Buffer.concat(session.received).byteLength;
      const m = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (m) {
        const start = Number(m[1]);
        if (start > have) return json(400, { error: { message: "gap" } });
        let fresh = chunk.subarray(have - start);
        const partial = partialAccepts.find((p) => p.remaining > 0);
        if (partial && fresh.byteLength > partial.keepBytes) {
          partial.remaining--;
          fresh = fresh.subarray(0, partial.keepBytes);
        }
        session.received.push(fresh);
      }
      const received = Buffer.concat(session.received);
      if (received.byteLength < session.total) {
        return new Response(null, {
          status: 308,
          headers:
            received.byteLength > 0
              ? { Range: `bytes=0-${received.byteLength - 1}` }
              : {},
        });
      }
      const item = store({
        name: session.name,
        mimeType: "video/mp4",
        parentId: session.parentId,
        content: received,
      });
      return json(200, describe(item));
    }

    if (path === "/upload/drive/v3/files" && method === "POST") {
      const uploadType = url.searchParams.get("uploadType");
      if (uploadType === "resumable") {
        const metadata = JSON.parse(bodyBuffer(init).toString("utf-8"));
        const uploadId = nextId("session");
        sessions.set(uploadId, {
          name: metadata.name,
          parentId: metadata.parents[0],
          total: Number(
            new Headers(init.headers).get("X-Upload-Content-Length")
          ),
          received: [],
        });
        return new Response(null, {
          status: 200,
          headers: {
            Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}`,
          },
        });
      }
      if (uploadType === "multipart") {
        const { metadata, content } = parseMultipart(init);
        const item = store({
          name: metadata.name,
          mimeType: "application/octet-stream",
          parentId: metadata.parents[0],
          content,
        });
        return json(200, describe(item));
      }
    }

    const media = path.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (media && method === "PATCH") {
      const item = items.get(media[1]!);
      if (!item) return json(404, { error: { message: "not found" } });
      item.content = bodyBuffer(init);
      item.revisions++;
      return json(200, describe(item));
    }

    if (path === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const files = Array.from(items.values())
        .filter((item) => item.id !== FAKE_COURSES_FOLDER_ID)
        .filter((item) => matchesQuery(item, q))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(describe);
      return json(200, { files });
    }

    if (path === "/drive/v3/files" && method === "POST") {
      const metadata = JSON.parse(bodyBuffer(init).toString("utf-8"));
      const item = store({
        name: metadata.name,
        mimeType: metadata.mimeType,
        parentId: metadata.parents[0],
      });
      return json(200, describe(item));
    }

    const copy = path.match(/^\/drive\/v3\/files\/([^/]+)\/copy$/);
    if (copy && method === "POST") {
      const source = items.get(copy[1]!);
      if (!source || source.trashed) {
        return json(404, { error: { message: "File not found" } });
      }
      const metadata = JSON.parse(bodyBuffer(init).toString("utf-8"));
      const item = store({
        name: metadata.name,
        mimeType: source.mimeType,
        parentId: metadata.parents[0],
        content: Buffer.from(source.content),
      });
      return json(200, describe(item));
    }

    const patch = path.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (patch && method === "PATCH") {
      const item = items.get(patch[1]!);
      if (!item) return json(404, { error: { message: "File not found" } });
      const body = JSON.parse(bodyBuffer(init).toString("utf-8"));
      if (body.trashed === true) item.trashed = true;
      return json(200, describe(item));
    }

    const get = path.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (get && method === "GET") {
      const item = items.get(get[1]!);
      if (!item || item.trashed) {
        return json(404, { error: { message: "File not found" } });
      }
      if (url.searchParams.get("alt") === "media") {
        return new Response(new Uint8Array(item.content), { status: 200 });
      }
      return json(200, describe(item));
    }

    throw new Error(`fake-google-drive: unhandled ${method} ${url}`);
  };

  const handleFetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    );
    calls.push({ method: requestMethod(init), url, init });

    const span: RequestSpan = {
      url,
      init,
      start: ++logicalClock,
      end: Number.POSITIVE_INFINITY,
    };
    requestSpans.push(span);
    notifyWatchers(url, init);

    try {
      if (barrier?.match(url, init)) {
        const held = barrier;
        const wait = new Promise<void>((resolve) => held.waiting.push(resolve));
        if (held.waiting.length >= held.count) releaseBarrier();
        await wait;
      }
      return await dispatch(url, init);
    } finally {
      span.end = ++logicalClock;
    }
  };

  /** Every non-trashed item under the courses root, by `a/b/c` path. */
  const pathOfItem = (item: StoredItem): string => {
    if (item.parentId === FAKE_COURSES_FOLDER_ID) return item.name;
    const parent = items.get(item.parentId);
    return parent ? `${pathOfItem(parent)}/${item.name}` : item.name;
  };

  const tree = () =>
    Array.from(items.values())
      .filter((item) => item.id !== FAKE_COURSES_FOLDER_ID && !item.trashed)
      .map((item) => ({ path: pathOfItem(item), item }));

  const liveFileAt = (path: string) =>
    tree().find(({ path: p, item }) => p === path && item.mimeType !== FOLDER)
      ?.item;

  /** The live folder at `a/b/c` under the courses root, created if absent. */
  const ensureFolder = (folderPath: string) => {
    let parentId = FAKE_COURSES_FOLDER_ID;
    for (const name of folderPath.split("/").filter(Boolean)) {
      const existing = Array.from(items.values())
        .filter(
          (item) =>
            item.parentId === parentId &&
            item.name === name &&
            item.mimeType === FOLDER &&
            !item.trashed
        )
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      parentId = existing?.id ?? store({ name, mimeType: FOLDER, parentId }).id;
    }
    return parentId;
  };

  return {
    items,
    calls,
    tree,
    handleFetch,
    peakConcurrentRequests,
    holdUntilInFlight,
    waitForRequest,
    /**
     * Put bytes at a course-relative path, as a person or an earlier attempt
     * might have: an existing file's content is replaced, otherwise the file
     * (and any missing folder) is created.
     */
    store: (path: string, content: Buffer) => {
      const existing = liveFileAt(path);
      if (existing) {
        existing.content = content;
        existing.revisions++;
        return existing;
      }
      const segments = path.split("/");
      const name = segments.pop()!;
      return store({
        name,
        mimeType: name.endsWith(".mp4") ? "video/mp4" : "application/json",
        parentId: ensureFolder(segments.join("/")),
        content,
      });
    },
    /** Trash the file at a path, if there is one. */
    remove: (path: string) => {
      const existing = liveFileAt(path);
      if (existing) existing.trashed = true;
    },
    /** Trash everything under the courses root. */
    clear: () => {
      for (const item of items.values()) {
        if (item.id !== FAKE_COURSES_FOLDER_ID) item.trashed = true;
      }
    },
    /** The path a resumable upload start is creating, from its metadata. */
    uploadTargetPath: (init: RequestInit) => {
      const metadata = JSON.parse(bodyBuffer(init).toString("utf-8"));
      const parent = items.get(metadata.parents[0]);
      return parent && parent.id !== FAKE_COURSES_FOLDER_ID
        ? `${pathOfItem(parent)}/${metadata.name}`
        : metadata.name;
    },
    filePaths: () =>
      tree()
        .filter(({ item }) => item.mimeType !== FOLDER)
        .map(({ path }) => path)
        .sort(),
    fileAt: liveFileAt,
    folderCount: (path: string) =>
      tree().filter(
        ({ path: p, item }) => p === path && item.mimeType === FOLDER
      ).length,
    /** Put a file straight into the fake, as an earlier attempt would have. */
    seedFile: (
      parentId: string,
      name: string,
      content: Buffer,
      createdAt?: Date
    ) =>
      store({
        name,
        mimeType: "video/mp4",
        parentId,
        content,
        createdAt: createdAt?.getTime(),
      }),
    /** Every non-trashed file directly inside a folder, by name. */
    namesIn: (parentId: string) =>
      Array.from(items.values())
        .filter((item) => item.parentId === parentId && !item.trashed)
        .map((item) => item.name)
        .sort(),
    /** Add a folder the way the author would, outside the courses root. */
    addFolder: (id: string) =>
      items.set(id, {
        id,
        name: id,
        mimeType: FOLDER,
        parentId: "root",
        content: Buffer.alloc(0),
        createdAt: 0,
        trashed: false,
        revisions: 1,
      }),
    trash: (id: string) => {
      const item = items.get(id);
      if (item) item.trashed = true;
    },
    failNextRequests: (opts: {
      match: Matcher;
      count: number;
      status: number;
      body?: string;
    }) =>
      failures.push({
        match: opts.match,
        remaining: opts.count,
        status: opts.status,
        body: opts.body,
      }),
    acceptPartialChunkOnce: (keepBytes: number) =>
      partialAccepts.push({ keepBytes, remaining: 1 }),
    install: () => {
      vi.stubGlobal("fetch", vi.fn(handleFetch));
    },
    cleanup: () => {
      releaseBarrier();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
};
