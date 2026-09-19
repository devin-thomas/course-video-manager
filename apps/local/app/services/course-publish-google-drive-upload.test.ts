/**
 * What a Publish sends to Google Drive, and how it recovers.
 *
 * The same Course the Dropbox upload tests publish, run through the real
 * publish logic against an in-memory Drive. Pins the Drive-specific rules:
 * the Bundle is a folder tree under the Course folder, Videos are verified by
 * the SHA256 Drive reports, a re-release copies unchanged Videos server-side,
 * and the Commit receipt keeps one file ID that is replaced in place.
 */

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { CoursePublishService } from "@/services/course-publish-service";
import {
  fakeDrive,
  freezeLatestVersion,
  manifestVideos,
  setupDropboxUploadTests,
  setupUploads,
} from "./course-publish-dropbox-upload-test-setup";

setupDropboxUploadTests();

const drive = () => fakeDrive;

const videoPaths = () =>
  drive()
    .filePaths()
    .filter((p) => p.endsWith(".mp4"));

const bundleDirs = () =>
  Array.from(
    new Set(videoPaths().map((p) => p.split("/versions/")[1]!.split("/")[0]!))
  );

const receipt = () => drive().fileAt("test-course/course.json");

const receiptManifest = () => JSON.parse(receipt()!.content.toString("utf-8"));

const isResumableStart = (call: { method: string; url: URL }) =>
  call.method === "POST" &&
  call.url.pathname === "/upload/drive/v3/files" &&
  call.url.searchParams.get("uploadType") === "resumable";

const resumableStarts = () => drive().calls.filter(isResumableStart).length;

const copyCalls = () =>
  drive().calls.filter((call) => call.url.pathname.endsWith("/copy")).length;

describe("Google Drive publish upload — the Bundle", () => {
  it("lands every Video in the Course's versions tree and commits course.json", async () => {
    const { sync, videos } = await setupUploads({
      videoCount: 3,
      backend: "google-drive",
    });

    await sync();

    expect(videoPaths()).toHaveLength(3);
    expect(bundleDirs()).toHaveLength(1);
    for (const p of videoPaths()) {
      expect(p).toMatch(
        /^test-course\/versions\/[0-9a-f]{16}-[0-9a-f]{32}\/intro\/lesson-\d\/Explainer\d\.mp4$/
      );
    }
    const bundle = `test-course/versions/${bundleDirs()[0]}`;
    expect(drive().fileAt(`${bundle}/manifest.json`)).toBeDefined();
    expect(drive().fileAt(`${bundle}/course.schema.json`)).toBeDefined();

    const shipped = manifestVideos(receiptManifest());
    expect(shipped).toHaveLength(3);
    for (const video of videos) {
      const bytes = fs.readFileSync(video.exportPath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      expect(shipped.map((v: any) => v.sha256)).toContain(sha256);
    }
  }, 30_000);

  it("creates each shared folder once, however many uploads race into it", async () => {
    const { sync } = await setupUploads({
      videoCount: 6,
      backend: "google-drive",
    });

    await sync();

    const bundle = `test-course/versions/${bundleDirs()[0]}`;
    expect(drive().folderCount("test-course")).toBe(1);
    expect(drive().folderCount("test-course/versions")).toBe(1);
    expect(drive().folderCount(bundle)).toBe(1);
    expect(drive().folderCount(`${bundle}/intro`)).toBe(1);
  }, 30_000);
});

describe("Google Drive publish upload — the Commit receipt", () => {
  it("replaces course.json in place, keeping one file ID across releases", async () => {
    const { course, run, sync } = await setupUploads({
      videoCount: 2,
      backend: "google-drive",
    });

    await sync();
    const first = receipt()!;
    const firstVersionId = receiptManifest().courseVersionId;

    const secondVersionId = await freezeLatestVersion(course, run);
    await run(
      Effect.gen(function* () {
        const svc = yield* CoursePublishService;
        return yield* svc.syncFrozenVersionToDropbox(
          course.id,
          secondVersionId,
          true
        );
      })
    );

    const receipts = drive()
      .filePaths()
      .filter((p) => p === "test-course/course.json");
    expect(receipts).toHaveLength(1);
    expect(receipt()!.id).toBe(first.id);
    expect(receipt()!.revisions).toBe(2);
    expect(receiptManifest().courseVersionId).toBe(secondVersionId);
    expect(secondVersionId).not.toBe(firstVersionId);
  }, 30_000);
});

describe("Google Drive publish upload — resumability", () => {
  it("uploads only the Video an interrupted Publish never landed", async () => {
    const { sync } = await setupUploads({
      videoCount: 3,
      backend: "google-drive",
    });

    await sync();
    const all = videoPaths();
    const dropped = drive().fileAt(all[1]!)!;
    drive().trash(dropped.id);
    expect(videoPaths()).toHaveLength(2);

    const startsBefore = resumableStarts();
    await sync();

    expect(videoPaths()).toEqual(all);
    expect(resumableStarts() - startsBefore).toBe(1);
  }, 30_000);

  it("uploads zero Videos when re-publishing an unchanged Course Version", async () => {
    const { sync } = await setupUploads({
      videoCount: 3,
      backend: "google-drive",
    });

    await sync();
    const startsBefore = resumableStarts();
    await sync();

    expect(resumableStarts()).toBe(startsBefore);
  }, 30_000);

  it("fails rather than adopting a landed Video whose bytes differ", async () => {
    const { sync } = await setupUploads({
      videoCount: 2,
      backend: "google-drive",
    });

    await sync();
    const target = drive().fileAt(videoPaths()[0]!)!;
    target.content = Buffer.from("y".repeat(target.content.length));

    await expect(sync()).rejects.toBeDefined();
  }, 30_000);

  it("re-sends the part of a chunk Drive did not keep, digesting each byte once", async () => {
    const { sync, videos } = await setupUploads({
      videoCount: 1,
      backend: "google-drive",
    });

    drive().acceptPartialChunkOnce(5);
    await sync();

    const landed = drive().fileAt(videoPaths()[0]!)!;
    const local = fs.readFileSync(videos[0]!.exportPath);
    expect(landed.content.equals(local)).toBe(true);
    const sha256 = createHash("sha256").update(local).digest("hex");
    expect(manifestVideos(receiptManifest())[0].sha256).toBe(sha256);
  }, 30_000);
});

describe("Google Drive publish upload — reuse from the previous Bundle", () => {
  it("copies unchanged Videos inside Drive rather than sending them again", async () => {
    const { course, run, sync } = await setupUploads({
      videoCount: 2,
      backend: "google-drive",
    });

    await sync();
    const startsAfterFirstRelease = resumableStarts();
    expect(startsAfterFirstRelease).toBe(2);

    const secondVersionId = await freezeLatestVersion(course, run);
    await run(
      Effect.gen(function* () {
        const svc = yield* CoursePublishService;
        return yield* svc.syncFrozenVersionToDropbox(
          course.id,
          secondVersionId,
          true
        );
      })
    );

    expect(bundleDirs()).toHaveLength(2);
    expect(videoPaths()).toHaveLength(4);
    expect(resumableStarts()).toBe(startsAfterFirstRelease);
    expect(copyCalls()).toBe(2);
  }, 30_000);

  it("uploads after all when the previous Bundle's file has gone", async () => {
    const { course, run, sync } = await setupUploads({
      videoCount: 2,
      backend: "google-drive",
    });

    await sync();
    const gone = drive().fileAt(videoPaths()[0]!)!;
    drive().trash(gone.id);
    const startsBefore = resumableStarts();

    const secondVersionId = await freezeLatestVersion(course, run);
    await run(
      Effect.gen(function* () {
        const svc = yield* CoursePublishService;
        return yield* svc.syncFrozenVersionToDropbox(
          course.id,
          secondVersionId,
          true
        );
      })
    );

    expect(resumableStarts() - startsBefore).toBe(1);
    expect(copyCalls()).toBe(1);
  }, 30_000);
});

describe("Google Drive publish upload — transient failures", () => {
  it("backs off and retries a rate-limited chunk rather than failing", async () => {
    const { sync } = await setupUploads({
      videoCount: 2,
      backend: "google-drive",
    });

    drive().failNextRequests({
      match: (url, init) =>
        (init.method ?? "GET").toUpperCase() === "PUT" &&
        url.searchParams.has("upload_id"),
      count: 1,
      status: 429,
    });

    await sync();

    expect(videoPaths()).toHaveLength(2);
  }, 30_000);
});
