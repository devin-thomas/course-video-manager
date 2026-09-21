/**
 * Shared test setup for the publish upload tests.
 *
 * It builds a Course whose Videos are already exported to disk, points the
 * publish code at an in-memory Google Drive fake, and hands back the helpers that
 * read what landed there. The upload tests and the Bundle-reuse tests both
 * publish the same world, so they share this file rather than each building
 * their own.
 */

import { beforeAll, afterEach } from "vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { NodeContext } from "@effect/platform-node";
import { createFakeOverlayRenderCache } from "@/test-utils/fake-overlay-render-cache";
import { createFakeVideoEditorLogger } from "@/test-utils/fake-video-editor-logger";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createTestDb,
  truncateAllTables,
  type TestDb,
} from "@/test-utils/pglite";
import {
  createFakeGoogleDrive,
  FAKE_COURSES_FOLDER_ID,
  FAKE_DRIVE_ACCESS_TOKEN,
  isCopyRequest,
  isVideoUploadStart,
} from "@/test-utils/fake-google-drive";
import { CourseOperationsService } from "@/services/db-course-operations.server";
import { VideoOperationsService } from "@/services/db-video-operations.server";
import { VersionOperationsService } from "@/services/db-version-operations.server";
import { LessonSectionOperationsService } from "@/services/db-lesson-section-operations.server";
import { LinkAuthOperationsService } from "@/services/db-link-auth-operations.server";
import { DrizzleService } from "@/services/drizzle-service.server";
import { VideoProcessingService } from "@/services/video-processing-service";
import { CoursePublishService } from "@/services/course-publish-service";
import { syncCourseVersion } from "@/test-utils/sync-course-version";
import {
  computeExportHash,
  resolveExportPath,
  type ExportClip,
} from "@/services/export-hash";
import {
  clips as clipsTable,
  videos as videosTable,
  googleDriveAuth,
} from "@/db/schema";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";

let testDb: TestDb;
let finishedVideosDir: string;
export let fakeDrive: ReturnType<typeof createFakeGoogleDrive>;

/** Register the lifecycle every file that uses this setup needs. */
export function setupUploadTests() {
  beforeAll(async () => {
    const result = await createTestDb();
    testDb = result.testDb;
  });

  afterEach(() => {
    fakeDrive?.cleanup();
  });
}

/** The Course folder every path below is relative to. */
export const COURSE_DIR = "test-course";

/** The start of one Video's upload: Drive's resumable session. */
export const isVideoUploadRequest = isVideoUploadStart;

/**
 * A course with `videoCount` lessons, each holding one Video whose clips —
 * and therefore whose Export Hash and exported bytes — are unique, so every
 * Video is a distinct file in the bundle.
 */
export const setupUploads = async (opts?: {
  videoCount?: number;
  config?: Record<string, string>;
}) => {
  const videoCount = opts?.videoCount ?? 6;
  await truncateAllTables(testDb);

  finishedVideosDir = fs.mkdtempSync(
    path.join(tmpdir(), "upload-test-videos-")
  );

  fakeDrive = createFakeGoogleDrive();
  fakeDrive.install();
  await testDb.insert(googleDriveAuth).values({
    accessToken: FAKE_DRIVE_ACCESS_TOKEN,
    refreshToken: "fake-refresh-token",
    expiresAt: new Date(Date.now() + 3600 * 1000),
  });

  const drizzleLayer = Layer.succeed(DrizzleService, testDb as any);
  const dbLayer = Layer.mergeAll(
    CourseOperationsService.Default,
    VideoOperationsService.Default,
    VersionOperationsService.Default,
    LessonSectionOperationsService.Default,
    LinkAuthOperationsService.Default
  ).pipe(Layer.provide(drizzleLayer));

  const runDb = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(dbLayer) as any)
    ) as Promise<A>;

  const course = await runDb(
    Effect.gen(function* () {
      const courseOps = yield* CourseOperationsService;
      return yield* courseOps.createCourse({ name: "test-course" });
    })
  );

  const version = await runDb(
    Effect.gen(function* () {
      const versionOps = yield* VersionOperationsService;
      return yield* versionOps.createCourseVersion({
        repoId: course.id,
        name: "",
      });
    })
  );

  const section = await runDb(
    Effect.gen(function* () {
      const lsOps = yield* LessonSectionOperationsService;
      const sections = yield* lsOps.createSections({
        repoVersionId: version.id,
        sections: [{ sectionPathWithNumber: "01-intro", sectionNumber: 1 }],
      });
      return sections[0]!;
    })
  );

  const videos: Array<{ id: string; title: string; exportPath: string }> = [];

  for (let index = 0; index < videoCount; index++) {
    const number = index + 1;
    const lesson = await runDb(
      Effect.gen(function* () {
        const lsOps = yield* LessonSectionOperationsService;
        const lessons = yield* lsOps.createLessons(section.id, [
          {
            lessonPathWithNumber: `01.0${number}-lesson-${number}`,
            lessonNumber: number,
          },
        ]);
        yield* lsOps.updateLesson(lessons[0]!.id, { authoringStatus: "done" });
        return lessons[0]!;
      })
    );

    const video = await runDb(
      Effect.gen(function* () {
        const videoOps = yield* VideoOperationsService;
        return yield* videoOps.createVideo(lesson.id, {
          title: `Explainer${number}`,
          originalFootagePath: `/tmp/footage${number}.mp4`,
        });
      })
    );

    await testDb
      .update(videosTable)
      .set({ body: "Video body", description: "Video description" })
      .where(eq(videosTable.id, video.id));

    // Unique clip timings per Video → unique Export Hash → unique file.
    const clipData = [
      {
        videoFilename: "recording.mp4",
        sourceStartTime: 0,
        sourceEndTime: 10 + number,
        order: "a0",
        text: "Hello world",
        pauseType: "none" as const,
      },
    ];
    await testDb
      .insert(clipsTable)
      .values(clipData.map((clip) => ({ ...clip, videoId: video.id })));

    const clips: ExportClip[] = clipData.map((clip) => ({
      videoFilename: clip.videoFilename,
      sourceStartTime: clip.sourceStartTime,
      sourceEndTime: clip.sourceEndTime,
      pauseType: "none",
      zoomType: "none",
      overlays: [],
    }));
    const exportHash = computeExportHash(clips, "landscape")!;
    const exportPath = resolveExportPath(
      finishedVideosDir,
      course.id,
      exportHash
    );
    // Distinct byte counts, so byte-weighted progress is observable.
    fs.writeFileSync(exportPath, `video-content-${"x".repeat(number * 8)}`);

    videos.push({ id: video.id, title: video.title, exportPath });
  }

  // Cloning a fresh Draft leaves the seeded version Published, which is what
  // `sync` re-commits.
  await runDb(
    Effect.gen(function* () {
      const versionOps = yield* VersionOperationsService;
      yield* versionOps.copyVersionStructure({
        sourceVersionId: version.id,
        repoId: course.id,
        newVersionName: "",
      });
    })
  );

  const configLayer = Layer.setConfigProvider(
    ConfigProvider.fromMap(
      new Map([
        ["FINISHED_VIDEOS_DIRECTORY", finishedVideosDir],
        ["GOOGLE_DRIVE_COURSES_FOLDER_ID", FAKE_COURSES_FOLDER_ID],
        ...Object.entries(opts?.config ?? {}),
      ])
    )
  );

  const mockVideoProcessing = Layer.succeed(
    VideoProcessingService,
    fromPartial({
      exportVideoClips: () =>
        Effect.die(new Error("no export expected in these tests")),
    })
  );

  const coreTestLayer = Layer.mergeAll(
    CourseOperationsService.Default,
    VideoOperationsService.Default,
    VersionOperationsService.Default,
    LinkAuthOperationsService.Default,
    mockVideoProcessing,
    createFakeOverlayRenderCache().layer,
    createFakeVideoEditorLogger().layer,
    NodeContext.layer
  ).pipe(Layer.provide(drizzleLayer), Layer.provide(configLayer));

  const testLayer = Layer.merge(
    coreTestLayer,
    CoursePublishService.Default.pipe(Layer.provide(coreTestLayer))
  );

  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(testLayer) as any)
    ) as Promise<A>;

  const sync = (
    onProgress?: (event: "progress", data: { percentage: number }) => void,
    includeTodoLessons = true
  ) =>
    run(
      syncCourseVersion(course.id, version.id, includeTodoLessons, onProgress)
    );

  return { course, version, videos, run, sync };
};

/** Every `.mp4` Drive holds, by course-relative path (`test-course/...`). */
export const remoteBundleVideoPaths = () =>
  fakeDrive.filePaths().filter((remotePath) => remotePath.endsWith(".mp4"));

/** The `{versionFingerprint}-{assetFingerprint}` directory the bundle landed in. */
export const remoteBundleDirs = () =>
  Array.from(
    new Set(
      remoteBundleVideoPaths().map(
        (remotePath) => remotePath.split("/versions/")[1]!.split("/")[0]!
      )
    )
  );

export const RECEIPT_PATH = `${COURSE_DIR}/course.json`;

export const receipt = () => fakeDrive.fileAt(RECEIPT_PATH);

export const receiptManifest = () =>
  JSON.parse(receipt()!.content.toString("utf-8"));

export const manifestVideos = (manifest: any): any[] =>
  manifest.sections.flatMap((section: any) =>
    section.lessons.flatMap((lesson: any) =>
      [lesson.explainer, lesson.problem, lesson.solution].filter(Boolean)
    )
  );

/** Take the current Draft to a frozen Version, so it can be committed. */
export const freezeLatestVersion = (
  course: { id: string },
  run: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>
) =>
  run(
    Effect.gen(function* () {
      const versionOps = yield* VersionOperationsService;
      const latest = yield* versionOps.getLatestCourseVersion(course.id);
      yield* versionOps.freezeAndCloneVersion({
        sourceVersionId: latest!.id,
        repoId: course.id,
        newVersionName: "",
        sourceName: "second release",
        sourceDescription: "",
      });
      return latest!.id;
    })
  );

export const videoUploadCount = () =>
  fakeDrive.calls.filter((call) => isVideoUploadRequest(call.url, call.init))
    .length;

/** Server-side copies: Drive makes one `files.copy` per reused Video. */
export const copyCount = () =>
  fakeDrive.calls.filter((call) => isCopyRequest(call.url, call.init)).length;
