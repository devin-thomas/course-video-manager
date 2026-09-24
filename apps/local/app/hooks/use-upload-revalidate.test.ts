import { describe, expect, it } from "vitest";
import type { uploadReducer } from "@/features/upload-manager/upload-reducer";
import { hasNewSuccessForTypes } from "./use-upload-revalidate";

function entry(
  status: uploadReducer.UploadStatus,
  uploadType: uploadReducer.UploadType
) {
  return { status, uploadType };
}

describe("hasNewSuccessForTypes", () => {
  it("returns true when a matching upload type transitions to success", () => {
    const prev = { "upload-1": entry("uploading", "render-vertical") };
    const current = { "upload-1": entry("success", "render-vertical") };
    expect(
      hasNewSuccessForTypes(prev, current, new Set(["render-vertical"]))
    ).toBe(true);
  });

  it("returns false when a non-matching upload type transitions to success", () => {
    const prev = { "upload-1": entry("uploading", "export") };
    const current = { "upload-1": entry("success", "export") };
    expect(
      hasNewSuccessForTypes(prev, current, new Set(["render-vertical"]))
    ).toBe(false);
  });

  it("returns false when status has not changed", () => {
    const prev = { "upload-1": entry("uploading", "render-vertical") };
    const current = { "upload-1": entry("uploading", "render-vertical") };
    expect(
      hasNewSuccessForTypes(prev, current, new Set(["render-vertical"]))
    ).toBe(false);
  });

  it("returns false when upload is new (not in prev)", () => {
    const prev = {};
    const current = { "upload-1": entry("success", "render-vertical") };
    expect(
      hasNewSuccessForTypes(prev, current, new Set(["render-vertical"]))
    ).toBe(false);
  });

  it("returns true when any one of multiple uploads matches", () => {
    const prev = {
      "upload-1": entry("uploading", "export"),
      "upload-2": entry("uploading", "publish"),
    };
    const current = {
      "upload-1": entry("uploading", "export"),
      "upload-2": entry("success", "publish"),
    };
    expect(hasNewSuccessForTypes(prev, current, new Set(["publish"]))).toBe(
      true
    );
  });

  it("returns false when upload transitions to error instead of success", () => {
    const prev = { "upload-1": entry("uploading", "render-vertical") };
    const current = { "upload-1": entry("error", "render-vertical") };
    expect(
      hasNewSuccessForTypes(prev, current, new Set(["render-vertical"]))
    ).toBe(false);
  });

  it("checks multiple types in the set", () => {
    const prev = { "upload-1": entry("uploading", "render-vertical") };
    const current = { "upload-1": entry("success", "render-vertical") };
    expect(
      hasNewSuccessForTypes(
        prev,
        current,
        new Set(["render-vertical", "publish", "render-vertical", "export"])
      )
    ).toBe(true);
  });
});
