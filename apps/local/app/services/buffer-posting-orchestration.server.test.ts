import { describe, it, expect } from "@effect/vitest";
import { beforeAll, beforeEach, vi } from "vitest";
import { Effect, Layer, ConfigProvider } from "effect";
import { FileSystem } from "@effect/platform";
import { VideoPostOperationsService } from "@/services/db-video-post-operations.server";
import { SocialStagingService } from "@/services/social-staging-service.server";
import { MakeWebhookService } from "@/services/make-webhook-service.server";
import { bufferPostProgram } from "@/services/buffer-posting-orchestration.server";
import { DrizzleService } from "@/services/drizzle-service.server";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createTestDb,
  truncateAllTables,
  type TestDb,
} from "@/test-utils/pglite";

const STAGED_FILE_ID = "drive-file-abc";

let testDb: TestDb;

beforeAll(async () => {
  const result = await createTestDb();
  testDb = result.testDb;
});

beforeEach(async () => {
  await truncateAllTables(testDb);
});

async function createTestVideo(title = "Test Short") {
  const [video] = await testDb
    .insert(schema.videos)
    .values({
      title,
      originalFootagePath: "",
      format: "short",
    })
    .returning();
  return video!;
}

function makeFakeStaging() {
  return {
    stage: vi.fn(
      (opts: {
        filePath: string;
        fileName: string;
        onProgress?: (p: number) => void;
      }) =>
        Effect.sync(() => {
          opts.onProgress?.(0);
          opts.onProgress?.(100);
          return { fileId: STAGED_FILE_ID };
        })
    ),
  };
}

function makeFakeMake(opts?: { bufferPostId?: string | null }) {
  return {
    sendSocialPost: vi.fn(
      (_payload: {
        caption: string;
        googleDriveFileId: string;
        videoId: string;
        fileName: string;
      }) =>
        Effect.succeed({
          bufferPostId:
            opts?.bufferPostId === undefined
              ? "buffer-post-123"
              : opts.bufferPostId,
        })
    ),
  };
}

function makeFakeFileSystem(opts?: { fileExists?: boolean }) {
  return FileSystem.FileSystem.of({
    exists: (_path: string) => Effect.succeed(opts?.fileExists ?? true),
  } as any);
}

function makeTestLayer(fakes: {
  staging: ReturnType<typeof makeFakeStaging>;
  make: ReturnType<typeof makeFakeMake>;
  fileExists?: boolean;
}) {
  const videoPostLayer = VideoPostOperationsService.Default.pipe(
    Layer.provide(Layer.succeed(DrizzleService, testDb as any))
  );

  const configLayer = Layer.setConfigProvider(
    ConfigProvider.fromMap(
      new Map([["FINISHED_VIDEOS_DIRECTORY", "/tmp/finished-videos"]])
    )
  );

  return Layer.mergeAll(
    videoPostLayer,
    configLayer,
    Layer.succeed(
      FileSystem.FileSystem,
      makeFakeFileSystem({ fileExists: fakes.fileExists })
    ),
    Layer.succeed(
      SocialStagingService,
      fakes.staging as unknown as SocialStagingService
    ),
    Layer.succeed(
      MakeWebhookService,
      fakes.make as unknown as MakeWebhookService
    )
  );
}

function makeSendEvent() {
  const events: Array<{ event: string; data: unknown }> = [];
  const sendEvent = (event: string, data: unknown) => {
    events.push({ event, data });
  };
  return { sendEvent, events };
}

const postsFor = (videoId: string) =>
  Effect.promise(() =>
    testDb.query.videoPosts.findMany({
      where: eq(schema.videoPosts.videoId, videoId),
    })
  );

describe("bufferPostProgram", () => {
  describe("happy path — handed to Make", () => {
    it.effect("stages in Drive, sends the file ID to Make, marks posted", () =>
      Effect.gen(function* () {
        const video = yield* Effect.promise(() => createTestVideo());
        const staging = makeFakeStaging();
        const make = makeFakeMake();
        const { sendEvent, events } = makeSendEvent();

        yield* bufferPostProgram({
          videoId: video.id,
          caption: "Check this out! #coding",
          sendEvent,
        }).pipe(Effect.provide(makeTestLayer({ staging, make })));

        expect(staging.stage).toHaveBeenCalledOnce();
        expect(staging.stage.mock.calls[0]![0]).toMatchObject({
          filePath: `/tmp/finished-videos/${video.id}.mp4`,
          fileName: `${video.id}.mp4`,
        });

        expect(make.sendSocialPost).toHaveBeenCalledWith({
          caption: "Check this out! #coding",
          googleDriveFileId: STAGED_FILE_ID,
          videoId: video.id,
          fileName: `${video.id}.mp4`,
        });

        const posts = yield* postsFor(video.id);
        expect(posts).toHaveLength(1);
        expect(posts[0]!.platform).toBe("buffer");
        expect(posts[0]!.remoteId).toBe("buffer-post-123");
        expect(posts[0]!.postedAt).toBeInstanceOf(Date);

        const eventTypes = events.map((e) => e.event);
        expect(eventTypes).toContain("uploading-blob");
        expect(eventTypes).toContain("creating-post");
        expect(eventTypes).toContain("complete");
        expect(eventTypes).not.toContain("error");
      })
    );

    it.effect("still marks posted when Make returns no Buffer post ID", () =>
      Effect.gen(function* () {
        const video = yield* Effect.promise(() => createTestVideo());
        const staging = makeFakeStaging();
        const make = makeFakeMake({ bufferPostId: null });
        const { sendEvent } = makeSendEvent();

        yield* bufferPostProgram({
          videoId: video.id,
          caption: "Plain accepted",
          sendEvent,
        }).pipe(Effect.provide(makeTestLayer({ staging, make })));

        const posts = yield* postsFor(video.id);
        expect(posts[0]!.remoteId).toBeNull();
        expect(posts[0]!.postedAt).toBeInstanceOf(Date);
      })
    );
  });

  describe("the Make webhook fails", () => {
    it.effect("does not mark posted", () =>
      Effect.gen(function* () {
        const video = yield* Effect.promise(() => createTestVideo());
        const staging = makeFakeStaging();
        const make = makeFakeMake();
        make.sendSocialPost.mockImplementation(
          () =>
            Effect.fail({
              _tag: "MakeWebhookError" as const,
              message: "Make webhook 500",
            }) as any
        );
        const { sendEvent } = makeSendEvent();

        const exit = yield* bufferPostProgram({
          videoId: video.id,
          caption: "Fail test",
          sendEvent,
        }).pipe(Effect.provide(makeTestLayer({ staging, make })), Effect.exit);

        expect(exit._tag).toBe("Failure");
        const posts = yield* postsFor(video.id);
        expect(posts).toHaveLength(1);
        expect(posts[0]!.postedAt).toBeNull();
      })
    );
  });

  describe("file does not exist", () => {
    it.effect("sends error and stages nothing", () =>
      Effect.gen(function* () {
        const video = yield* Effect.promise(() => createTestVideo());
        const staging = makeFakeStaging();
        const make = makeFakeMake();
        const { sendEvent, events } = makeSendEvent();

        yield* bufferPostProgram({
          videoId: video.id,
          caption: "No file",
          sendEvent,
        }).pipe(
          Effect.provide(makeTestLayer({ staging, make, fileExists: false }))
        );

        expect(staging.stage).not.toHaveBeenCalled();
        expect(make.sendSocialPost).not.toHaveBeenCalled();

        const errorEvents = events.filter((e) => e.event === "error");
        expect(errorEvents).toHaveLength(1);
        expect((errorEvents[0]!.data as any).message).toContain("not found");
      })
    );
  });
});
