import { describe, expect, it } from "vitest";
import { uploadReducer, createInitialUploadState } from "./upload-reducer";

const reduce = (state: uploadReducer.State, action: uploadReducer.Action) =>
  uploadReducer(state, action);

const createState = (
  overrides: Partial<uploadReducer.State> = {}
): uploadReducer.State => ({
  ...createInitialUploadState(),
  ...overrides,
});

const createAiHeroEntry = (
  overrides: Partial<Omit<uploadReducer.AiHeroUploadEntry, "uploadType">> = {}
): uploadReducer.AiHeroUploadEntry => ({
  uploadId: "upload-1",
  videoId: "video-1",
  title: "Test Video",
  progress: 0,
  status: "uploading",
  uploadType: "ai-hero",
  aiHeroSlug: null,
  errorMessage: null,
  retryCount: 0,
  terminal: false,
  dependsOn: null,
  parentUploadId: null,
  ...overrides,
});

const createPublishEntry = (
  overrides: Partial<Omit<uploadReducer.PublishUploadEntry, "uploadType">> = {}
): uploadReducer.PublishUploadEntry => ({
  uploadId: "upload-1",
  videoId: "",
  title: "My Course",
  progress: 0,
  status: "uploading",
  uploadType: "publish",
  publishStage: null,
  newDraftVersionId: null,
  courseId: "course-1",
  errorMessage: null,
  retryCount: 0,
  terminal: false,
  dependsOn: null,
  parentUploadId: null,
  ...overrides,
});

/** Every value `progress` took, starting from the entry's own. */
const progressOver = (
  entry: uploadReducer.UploadEntry,
  actions: uploadReducer.Action[]
) => {
  let state = createState({ uploads: { "upload-1": entry } });
  const seen = [entry.progress];
  for (const action of actions) {
    state = reduce(state, action);
    seen.push(state.uploads["upload-1"]!.progress);
  }
  return seen;
};

const isMonotonic = (values: number[]) =>
  values.every((value, i) => i === 0 || value >= values[i - 1]!);

// The job viewer draws a bar from `progress` for every unfinished job, so a
// stage handover that lowers `progress` is visible as the bar running
// backwards. These walk the event orders the SSE clients really produce.
describe("progress never runs backwards", () => {
  it("keeps the publish bar climbing across the prologue and into the work", () => {
    // The real emission order: validate, Submit (freeze then clone), and only
    // then the overlapping export and upload.
    const seen = progressOver(createPublishEntry(), [
      {
        type: "UPDATE_PUBLISH_STAGE",
        uploadId: "upload-1",
        stage: "validating",
      },
      { type: "UPDATE_PUBLISH_STAGE", uploadId: "upload-1", stage: "freezing" },
      { type: "UPDATE_PUBLISH_STAGE", uploadId: "upload-1", stage: "cloning" },
      {
        type: "UPDATE_PUBLISH_STAGE",
        uploadId: "upload-1",
        stage: "exporting",
      },
      {
        type: "UPDATE_PUBLISH_STAGE",
        uploadId: "upload-1",
        stage: "uploading",
      },
    ]);

    expect(isMonotonic(seen)).toBe(true);
    expect(seen.at(-1)).toBe(10);
  });

  it("ignores a bundle-wide percentage aimed at the publish bar", () => {
    // The Publish's bar is derived from its per-Video children; the aggregate
    // the server also reports must not be able to overwrite it.
    const seen = progressOver(createPublishEntry({ progress: 40 }), [
      { type: "UPDATE_PROGRESS", uploadId: "upload-1", progress: 99 },
    ]);

    expect(seen).toEqual([40, 40]);
  });

  it("still streams a real percentage straight through for a plain upload", () => {
    const seen = progressOver(createAiHeroEntry(), [
      { type: "UPDATE_PROGRESS", uploadId: "upload-1", progress: 37 },
      { type: "UPDATE_PROGRESS", uploadId: "upload-1", progress: 82 },
    ]);

    expect(seen).toEqual([0, 37, 82]);
  });
});
