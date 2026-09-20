import { describe, expect, it } from "vitest";
import { uploadReducer } from "./upload-reducer";
import { uploadTypeRegistry } from "./upload-type-registry";

const exportConfig = uploadTypeRegistry["export"]!;

const makeBase = (
  overrides: Partial<uploadReducer.BaseUploadEntry> = {}
): uploadReducer.BaseUploadEntry => ({
  uploadId: "upload-1",
  videoId: "video-1",
  title: "Test Export",
  progress: 0,
  status: "uploading",
  errorMessage: null,
  retryCount: 0,
  terminal: false,
  dependsOn: null,
  parentUploadId: null,
  ...overrides,
});

describe("export registry entry", () => {
  describe("createEntry", () => {
    it("should create an export entry with exportStage queued and isBatchEntry false", () => {
      const base = makeBase();

      const entry = exportConfig.createEntry(base, {
        type: "START_UPLOAD",
        uploadType: "export",
        uploadId: "upload-1",
        videoId: "video-1",
        title: "Test Export",
      });

      expect(entry).toEqual({
        ...base,
        uploadType: "export",
        exportStage: "queued",
        isBatchEntry: false,
        videoUploadStage: null,
        uploadedBytes: 0,
        totalBytes: null,
      });
    });

    it("should set isBatchEntry true from action", () => {
      const entry = exportConfig.createEntry(makeBase(), {
        type: "START_UPLOAD",
        uploadType: "export",
        uploadId: "upload-1",
        videoId: "video-1",
        title: "Batch Export",
        isBatchEntry: true,
      });

      expect(entry).toMatchObject({
        uploadType: "export",
        isBatchEntry: true,
        videoUploadStage: null,
        uploadedBytes: 0,
        totalBytes: null,
      });
    });

    it("should preserve waiting status from base when dependsOn is set", () => {
      const base = makeBase({ status: "waiting", dependsOn: "upload-0" });

      const entry = exportConfig.createEntry(base, {
        type: "START_UPLOAD",
        uploadType: "export",
        uploadId: "upload-1",
        videoId: "video-1",
        title: "Test Export",
      });

      expect(entry.status).toBe("waiting");
      expect(entry.dependsOn).toBe("upload-0");
    });
  });

  describe("resetEntry", () => {
    it("should reset exportStage to queued and preserve isBatchEntry", () => {
      const base = makeBase({
        errorMessage: "some error",
        retryCount: 1,
      });

      const prevEntry: uploadReducer.ExportUploadEntry = {
        ...base,
        uploadType: "export",
        exportStage: "normalizing-audio",
        isBatchEntry: true,
        videoUploadStage: null,
        uploadedBytes: 0,
        totalBytes: null,
      };

      const entry = exportConfig.resetEntry(base, prevEntry);

      expect(entry).toEqual({
        ...base,
        uploadType: "export",
        exportStage: "queued",
        isBatchEntry: true,
        videoUploadStage: null,
        uploadedBytes: 0,
        totalBytes: null,
      });
    });

    it("should preserve isBatchEntry false", () => {
      const base = makeBase({ retryCount: 2 });

      const prevEntry: uploadReducer.ExportUploadEntry = {
        ...base,
        uploadType: "export",
        exportStage: "concatenating-clips",
        isBatchEntry: false,
        videoUploadStage: null,
        uploadedBytes: 0,
        totalBytes: null,
      };

      const entry = exportConfig.resetEntry(base, prevEntry);

      expect(entry).toMatchObject({
        uploadType: "export",
        exportStage: "queued",
        isBatchEntry: false,
        videoUploadStage: null,
        uploadedBytes: 0,
        totalBytes: null,
      });
    });
  });

  describe("applySuccess", () => {
    it("should set status to success, clear exportStage, and preserve isBatchEntry", () => {
      const entry: uploadReducer.ExportUploadEntry = {
        uploadId: "upload-1",
        videoId: "video-1",
        title: "Test Export",
        progress: 80,
        status: "uploading",
        uploadType: "export",
        exportStage: "normalizing-audio",
        isBatchEntry: false,
        videoUploadStage: null,
        uploadedBytes: 0,
        totalBytes: null,
        errorMessage: null,
        retryCount: 0,
        terminal: false,
        dependsOn: null,
        parentUploadId: null,
      };

      const result = exportConfig.applySuccess(entry, {
        type: "UPLOAD_SUCCESS",
        uploadId: "upload-1",
      });

      expect(result).toEqual({
        ...entry,
        status: "success",
        progress: 100,
        errorMessage: null,
        exportStage: null,
      });
    });

    it("should preserve isBatchEntry true on success", () => {
      const entry: uploadReducer.ExportUploadEntry = {
        uploadId: "upload-1",
        videoId: "video-1",
        title: "Batch Export",
        progress: 80,
        status: "uploading",
        uploadType: "export",
        exportStage: "normalizing-audio",
        isBatchEntry: true,
        videoUploadStage: null,
        uploadedBytes: 0,
        totalBytes: null,
        errorMessage: null,
        retryCount: 0,
        terminal: false,
        dependsOn: null,
        parentUploadId: null,
      };

      const result = exportConfig.applySuccess(entry, {
        type: "UPLOAD_SUCCESS",
        uploadId: "upload-1",
      });

      expect(result.isBatchEntry).toBe(true);
      expect(result.exportStage).toBeNull();
      expect(result.status).toBe("success");
    });

    it("should clear previous error message on success", () => {
      const entry: uploadReducer.ExportUploadEntry = {
        uploadId: "upload-1",
        videoId: "video-1",
        title: "Test Export",
        progress: 50,
        status: "uploading",
        uploadType: "export",
        exportStage: "concatenating-clips",
        isBatchEntry: false,
        videoUploadStage: null,
        uploadedBytes: 0,
        totalBytes: null,
        errorMessage: "previous error",
        retryCount: 1,
        terminal: false,
        dependsOn: null,
        parentUploadId: null,
      };

      const result = exportConfig.applySuccess(entry, {
        type: "UPLOAD_SUCCESS",
        uploadId: "upload-1",
      });

      expect(result.errorMessage).toBeNull();
    });
  });
});
