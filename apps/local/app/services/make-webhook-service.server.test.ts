import { describe, it, expect, afterEach, vi } from "vitest";
import { ConfigProvider, Effect, Exit } from "effect";
import { MakeWebhookService } from "@/services/make-webhook-service.server";

const WEBHOOK = "https://hook.us2.make.com/test-webhook";

const payload = {
  caption: 'She said "ship it"\nand we did',
  googleDriveFileId: "drive-file-1",
  videoId: "video-1",
  fileName: "video-1.mp4",
};

const send = (response: Response) => {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  const run = Effect.gen(function* () {
    const make = yield* MakeWebhookService;
    return yield* make.sendSocialPost(payload);
  }).pipe(
    Effect.provide(MakeWebhookService.Default),
    Effect.withConfigProvider(
      ConfigProvider.fromMap(new Map([["MAKE_SOCIAL_WEBHOOK_URL", WEBHOOK]]))
    )
  );
  return { fetchMock, run };
};

const bufferResponse = (createPost: unknown, errors?: unknown) =>
  new Response(JSON.stringify({ data: { createPost }, errors }));

afterEach(() => vi.unstubAllGlobals());

describe("MakeWebhookService", () => {
  it("posts the Drive file ID, caption and a JSON-encoded caption", async () => {
    const { fetchMock, run } = send(bufferResponse({ post: { id: "bp-1" } }));

    await Effect.runPromise(run);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(WEBHOOK);
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject(payload);
    // Dropped verbatim into Buffer's GraphQL body, it must parse back.
    expect(JSON.parse(sent.captionJson)).toBe(payload.caption);
  });

  it("returns the Buffer post ID from the scenario's response", async () => {
    const { run } = send(bufferResponse({ post: { id: "bp-42" } }));

    expect(await Effect.runPromise(run)).toEqual({ bufferPostId: "bp-42" });
  });

  it("counts a bare Accepted (no Webhook Response ran) as handed off", async () => {
    const { run } = send(new Response("Accepted"));

    expect(await Effect.runPromise(run)).toEqual({ bufferPostId: null });
  });

  it("fails on a Buffer MutationError", async () => {
    const { run } = send(bufferResponse({ message: "Channel is paused" }));

    const exit = await Effect.runPromiseExit(run);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("Channel is paused");
  });

  it("fails on GraphQL errors", async () => {
    const { run } = send(bufferResponse(null, [{ message: "Unauthorized" }]));

    const exit = await Effect.runPromiseExit(run);

    expect(JSON.stringify(exit)).toContain("Unauthorized");
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails when Make rejects the call", async () => {
    const { run } = send(new Response("Scenario failed", { status: 500 }));

    expect(Exit.isFailure(await Effect.runPromiseExit(run))).toBe(true);
  });
});
