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

type Matcher = (url: URL, init: RequestInit) => boolean;

const json = (status: number, body: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

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
  const calls: Array<{ method: string; url: URL }> = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  const failures: Array<{
    match: Matcher;
    remaining: number;
    status: number;
    body?: string;
  }> = [];
  /** A resumable PUT that keeps only this many bytes of its chunk, once. */
  const partialAccepts: Array<{ keepBytes: number; remaining: number }> = [];

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
  }) => {
    const item: StoredItem = {
      id: nextId(opts.mimeType === FOLDER ? "folder" : "file"),
      name: opts.name,
      mimeType: opts.mimeType,
      parentId: opts.parentId,
      content: opts.content ?? Buffer.alloc(0),
      createdAt: ++counter,
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

  const handleFetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, url });

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

  /** Every non-trashed item under the courses root, by `a/b/c` path. */
  const tree = () => {
    const pathOf = (item: StoredItem): string => {
      if (item.parentId === FAKE_COURSES_FOLDER_ID) return item.name;
      const parent = items.get(item.parentId);
      return parent ? `${pathOf(parent)}/${item.name}` : item.name;
    };
    return Array.from(items.values())
      .filter((item) => item.id !== FAKE_COURSES_FOLDER_ID && !item.trashed)
      .map((item) => ({ path: pathOf(item), item }));
  };

  return {
    items,
    calls,
    tree,
    filePaths: () =>
      tree()
        .filter(({ item }) => item.mimeType !== FOLDER)
        .map(({ path }) => path)
        .sort(),
    fileAt: (path: string) =>
      tree().find(({ path: p, item }) => p === path && item.mimeType !== FOLDER)
        ?.item,
    folderCount: (path: string) =>
      tree().filter(
        ({ path: p, item }) => p === path && item.mimeType === FOLDER
      ).length,
    /** Put a file straight into the fake, as an earlier attempt would have. */
    seedFile: (parentId: string, name: string, content: Buffer) =>
      store({ name, mimeType: "video/mp4", parentId, content }),
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
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
};
