import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SocialStagingService } from "@/services/social-staging-service.server";
import { DrizzleService } from "@/services/drizzle-service.server";
import { googleDriveAuth } from "@/db/schema";
import {
  createTestDb,
  truncateAllTables,
  type TestDb,
} from "@/test-utils/pglite";
import {
  createFakeGoogleDrive,
  FAKE_DRIVE_ACCESS_TOKEN,
} from "@/test-utils/fake-google-drive";

const STAGING_FOLDER = "fake-social-staging";

let testDb: TestDb;
let drive: ReturnType<typeof createFakeGoogleDrive>;

beforeAll(async () => {
  testDb = (await createTestDb()).testDb;
});

afterEach(() => drive?.cleanup());

const setup = async () => {
  await truncateAllTables(testDb);
  drive = createFakeGoogleDrive();
  drive.addFolder(STAGING_FOLDER);
  drive.install();
  await testDb.insert(googleDriveAuth).values({
    accessToken: FAKE_DRIVE_ACCESS_TOKEN,
    refreshToken: "fake-refresh-token",
    expiresAt: new Date(Date.now() + 3600 * 1000),
  });
  const layer = Layer.mergeAll(
    SocialStagingService.Default.pipe(
      Layer.provide(Layer.succeed(DrizzleService, testDb as any))
    ),
    Layer.setConfigProvider(
      ConfigProvider.fromMap(
        new Map([["GOOGLE_DRIVE_SOCIAL_STAGING_FOLDER_ID", STAGING_FOLDER]])
      )
    )
  );
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "staging-test-")),
    "short.mp4"
  );
  fs.writeFileSync(file, "vertical-video-bytes");
  const stage = (onProgress?: (p: number) => void) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const staging = yield* SocialStagingService;
        return yield* staging.stage({
          filePath: file,
          fileName: "video-1.mp4",
          onProgress,
        });
      }).pipe(Effect.provide(layer)) as Effect.Effect<{ fileId: string }>
    );
  return { stage };
};

describe("SocialStagingService", () => {
  it("uploads the video into the staging folder and returns its Drive ID", async () => {
    const { stage } = await setup();
    const progress: number[] = [];

    const { fileId } = await stage((p) => progress.push(p));

    expect(drive.items.get(fileId)?.parentId).toBe(STAGING_FOLDER);
    expect(drive.items.get(fileId)?.content.toString()).toBe(
      "vertical-video-bytes"
    );
    expect(progress.at(-1)).toBe(100);
  });

  it("trashes staged files older than a week, and keeps recent ones", async () => {
    const { stage } = await setup();
    const day = 24 * 60 * 60 * 1000;
    drive.seedFile(
      STAGING_FOLDER,
      "old.mp4",
      Buffer.from("old"),
      new Date(Date.now() - 8 * day)
    );
    drive.seedFile(
      STAGING_FOLDER,
      "recent.mp4",
      Buffer.from("recent"),
      new Date(Date.now() - 2 * day)
    );

    await stage();

    expect(drive.namesIn(STAGING_FOLDER)).toEqual([
      "recent.mp4",
      "video-1.mp4",
    ]);
  });
});
