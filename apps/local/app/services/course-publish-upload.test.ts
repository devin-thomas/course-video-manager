/**
 * What a Publish sends to Google Drive, and how it recovers when a send goes
 * wrong.
 *
 * These run the real publish logic against an in-memory Drive and pin: the
 * Bundle is a folder tree under the Course folder addressed by the recipe
 * rather than by the bytes, several Videos go up at once, Videos are verified
 * by the SHA256 Drive reports, the Commit receipt keeps one file ID that is
 * replaced in place, an interrupted Publish finishes rather than restarts, and
 * a rate-limited upload is retried. Reuse from the previous Bundle lives in
 * `course-publish-upload-reuse.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { CoursePublishService } from "@/services/course-publish-service";
import {
  COURSE_DIR,
  RECEIPT_PATH,
  fakeDrive,
  freezeLatestVersion,
  isVideoUploadRequest,
  manifestVideos,
  receipt,
  receiptManifest,
  remoteBundleDirs,
  remoteBundleVideoPaths,
  setupUploadTests,
  setupUploads,
  videoUploadCount,
} from "./course-publish-upload-test-setup";

setupUploadTests();

describe("publish upload — the Bundle", () => {
  it("lands every Video in the Course's versions tree and commits course.json", async () => {
    const { sync, videos } = await setupUploads({ videoCount: 3 });

    await sync();

    expect(remoteBundleVideoPaths()).toHaveLength(3);
    expect(remoteBundleDirs()).toHaveLength(1);
    for (const p of remoteBundleVideoPaths()) {
      expect(p).toMatch(
        /^test-course\/versions\/[0-9a-f]{16}-[0-9a-f]{32}\/intro\/lesson-\d\/Explainer\d\.mp4$/
      );
    }
    const bundle = `${COURSE_DIR}/versions/${remoteBundleDirs()[0]}`;
    expect(fakeDrive.fileAt(`${bundle}/manifest.json`)).toBeDefined();
    expect(fakeDrive.fileAt(`${bundle}/course.schema.json`)).toBeDefined();

    const shipped = manifestVideos(receiptManifest());
    expect(shipped).toHaveLength(3);
    for (const video of videos) {
      const bytes = fs.readFileSync(video.exportPath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      expect(shipped.map((v: any) => v.sha256)).toContain(sha256);
    }
  }, 30_000);

  it("creates each shared folder once, however many uploads race into it", async () => {
    const { sync } = await setupUploads({ videoCount: 6 });

    await sync();

    const bundle = `${COURSE_DIR}/versions/${remoteBundleDirs()[0]}`;
    expect(fakeDrive.folderCount(COURSE_DIR)).toBe(1);
    expect(fakeDrive.folderCount(`${COURSE_DIR}/versions`)).toBe(1);
    expect(fakeDrive.folderCount(bundle)).toBe(1);
    expect(fakeDrive.folderCount(`${bundle}/intro`)).toBe(1);
  }, 30_000);

  it("addresses the bundle by Export Hash, not by the exported bytes", async () => {
    const { videos, sync } = await setupUploads({ videoCount: 2 });

    await sync();
    const originalBundleDirs = remoteBundleDirs();
    expect(originalBundleDirs).toHaveLength(1);

    // Wipe the remote entirely and re-encode every Video to different bytes.
    // The recipe — Clips, source timings, Video Format, Export Version Key —
    // is untouched, so the destination must be untouched too.
    fakeDrive.clear();
    for (const video of videos) {
      fs.writeFileSync(video.exportPath, `re-encoded-${"z".repeat(64)}`);
    }

    await sync();

    expect(remoteBundleDirs()).toEqual(originalBundleDirs);
  }, 30_000);

  it("keeps every Video's SHA256 and byte count in the shipped manifest", async () => {
    const { videos, sync } = await setupUploads({ videoCount: 3 });

    await sync();

    const expected = new Map(
      videos.map((video) => {
        const bytes = fs.readFileSync(video.exportPath);
        return [
          `${video.title}.mp4`,
          {
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
          },
        ];
      })
    );

    const entries = manifestVideos(receiptManifest());
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      const key = entry.relativePath.split("/").pop()!;
      expect({ sha256: entry.sha256, bytes: entry.bytes }).toEqual(
        expected.get(key)
      );
    }
  }, 30_000);

  it("re-derives the manifest's SHA256 from the bytes that actually shipped", async () => {
    const { videos, sync } = await setupUploads({ videoCount: 1 });

    await sync();
    fakeDrive.clear();
    const reEncoded = Buffer.from(`re-encoded-${"z".repeat(64)}`);
    fs.writeFileSync(videos[0]!.exportPath, reEncoded);

    await sync();

    expect(manifestVideos(receiptManifest())[0]).toMatchObject({
      sha256: createHash("sha256").update(reEncoded).digest("hex"),
      bytes: reEncoded.length,
    });
  }, 30_000);

  it("lands a differing to-do lesson setting in a distinct bundle", async () => {
    const { sync } = await setupUploads({ videoCount: 2 });

    await sync(undefined, true);
    const withTodo = remoteBundleDirs();

    fakeDrive.clear();
    await sync(undefined, false);
    const withoutTodo = remoteBundleDirs();

    expect(withTodo).toHaveLength(1);
    expect(withoutTodo).toHaveLength(1);
    expect(withoutTodo).not.toEqual(withTodo);
  }, 30_000);
});

describe("publish upload — the Commit receipt", () => {
  it("replaces course.json in place, keeping one file ID across releases", async () => {
    const { course, run, sync } = await setupUploads({ videoCount: 2 });

    await sync();
    const first = receipt()!;
    const firstVersionId = receiptManifest().courseVersionId;

    const secondVersionId = await freezeLatestVersion(course, run);
    await run(
      Effect.gen(function* () {
        const svc = yield* CoursePublishService;
        return yield* svc.syncFrozenVersion(course.id, secondVersionId, true);
      })
    );

    const receipts = fakeDrive.filePaths().filter((p) => p === RECEIPT_PATH);
    expect(receipts).toHaveLength(1);
    expect(receipt()!.id).toBe(first.id);
    expect(receipt()!.revisions).toBe(2);
    expect(receiptManifest().courseVersionId).toBe(secondVersionId);
    expect(secondVersionId).not.toBe(firstVersionId);
  }, 30_000);
});

describe("publish upload — concurrency", () => {
  it("uploads several Videos at once, up to the default limit of 4", async () => {
    const { sync } = await setupUploads({ videoCount: 6 });

    // Deterministic: the barrier only trips if four uploads are genuinely in
    // flight together. A serial implementation hangs rather than passing.
    fakeDrive.holdUntilInFlight(4, isVideoUploadRequest);

    await sync();

    expect(fakeDrive.peakConcurrentRequests(isVideoUploadRequest)).toBe(4);
    expect(remoteBundleVideoPaths()).toHaveLength(6);
  }, 30_000);

  it("never exceeds the configured concurrency limit", async () => {
    const { sync } = await setupUploads({
      videoCount: 6,
      config: { GOOGLE_DRIVE_UPLOAD_CONCURRENCY: "2" },
    });

    fakeDrive.holdUntilInFlight(2, isVideoUploadRequest);

    await sync();

    expect(fakeDrive.peakConcurrentRequests(isVideoUploadRequest)).toBe(2);
    expect(remoteBundleVideoPaths()).toHaveLength(6);
  }, 30_000);

  it("reports monotonic progress with several uploads in flight", async () => {
    const { sync } = await setupUploads({ videoCount: 6 });

    const percentages: number[] = [];
    await sync((_event, data) => percentages.push(data.percentage));

    expect(percentages.length).toBeGreaterThan(0);
    expect([...percentages].sort((a, b) => a - b)).toEqual(percentages);
    expect(percentages.at(-1)).toBe(100);
  }, 30_000);
});

describe("publish upload — resumability", () => {
  it("uploads only the Video an interrupted Publish never landed", async () => {
    const { sync } = await setupUploads({ videoCount: 3 });

    await sync();
    const allVideoPaths = remoteBundleVideoPaths();
    expect(allVideoPaths).toHaveLength(3);

    // Simulate a Publish that died partway: the bundle folder exists but one
    // Video never landed.
    const droppedPath = allVideoPaths[1]!;
    fakeDrive.remove(droppedPath);
    expect(remoteBundleVideoPaths()).toHaveLength(2);

    const callsBefore = fakeDrive.calls.length;
    await sync();

    expect(remoteBundleVideoPaths()).toEqual(allVideoPaths);
    const reUploaded = fakeDrive.calls
      .slice(callsBefore)
      .filter((call) => isVideoUploadRequest(call.url, call.init))
      .map((call) => fakeDrive.uploadTargetPath(call.init));
    expect(reUploaded).toEqual([droppedPath]);
  }, 30_000);

  it("restores a bundle's missing manifest without re-uploading its Videos", async () => {
    const { sync } = await setupUploads({ videoCount: 2 });

    await sync();
    const manifestPath = fakeDrive
      .filePaths()
      .find((p) => p.endsWith("manifest.json"))!;
    fakeDrive.remove(manifestPath);

    const uploadsBefore = videoUploadCount();
    await sync();

    expect(fakeDrive.fileAt(manifestPath)).toBeDefined();
    expect(videoUploadCount()).toBe(uploadsBefore);
  }, 30_000);

  it("uploads zero Videos when re-publishing an unchanged Course Version", async () => {
    const { sync } = await setupUploads({ videoCount: 3 });

    await sync();
    const uploadsBefore = videoUploadCount();
    await sync();

    expect(videoUploadCount()).toBe(uploadsBefore);
  }, 30_000);

  it("fails rather than adopting a landed Video whose bytes differ", async () => {
    const { sync } = await setupUploads({ videoCount: 2 });

    await sync();
    const target = fakeDrive.fileAt(remoteBundleVideoPaths()[0]!)!;
    // Same size, different bytes — an immutability violation, not a partial
    // transfer.
    target.content = Buffer.from("y".repeat(target.content.length));

    await expect(sync()).rejects.toBeDefined();
  }, 30_000);

  it("re-sends the part of a chunk Drive did not keep, digesting each byte once", async () => {
    const { sync, videos } = await setupUploads({ videoCount: 1 });

    fakeDrive.acceptPartialChunkOnce(5);
    await sync();

    const landed = fakeDrive.fileAt(remoteBundleVideoPaths()[0]!)!;
    const local = fs.readFileSync(videos[0]!.exportPath);
    expect(landed.content.equals(local)).toBe(true);
    const sha256 = createHash("sha256").update(local).digest("hex");
    expect(manifestVideos(receiptManifest())[0].sha256).toBe(sha256);
  }, 30_000);
});

describe("publish upload — transient failures", () => {
  it("backs off and retries a rate-limited chunk rather than failing", async () => {
    const { sync } = await setupUploads({ videoCount: 2 });

    fakeDrive.failNextRequests({
      match: (url, init) =>
        (init.method ?? "GET").toUpperCase() === "PUT" &&
        url.searchParams.has("upload_id"),
      count: 1,
      status: 429,
    });

    await sync();

    expect(remoteBundleVideoPaths()).toHaveLength(2);
  }, 30_000);
});
