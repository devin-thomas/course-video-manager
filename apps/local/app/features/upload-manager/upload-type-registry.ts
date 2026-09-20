import type { uploadReducer } from "./upload-reducer";
import { autofillConfig } from "./upload-type-autofill";
import { startSSEExport } from "./sse-export-client";
import { startSSEPublish } from "./sse-publish-client";
import { startSSERenderVertical } from "./sse-render-vertical-client";

type StartUploadAction = Extract<
  uploadReducer.Action,
  { type: "START_UPLOAD" }
>;
type UploadSuccessAction = Extract<
  uploadReducer.Action,
  { type: "UPLOAD_SUCCESS" }
>;

export interface UploadTypeConfig<
  TParams = unknown,
  TEntry extends uploadReducer.UploadEntry = uploadReducer.UploadEntry,
> {
  createEntry: (
    base: uploadReducer.BaseUploadEntry,
    action: StartUploadAction
  ) => TEntry;

  resetEntry: (
    base: uploadReducer.BaseUploadEntry,
    prevEntry: TEntry
  ) => TEntry;

  applySuccess: (entry: TEntry, action: UploadSuccessAction) => TEntry;

  initiate: (
    uploadId: string,
    entry: TEntry,
    params: TParams,
    dispatch: (action: uploadReducer.Action) => void,
    abortControllers: Map<string, AbortController>
  ) => void;

  supportsDependsOn?: boolean;
}

export function withAbortManagement(
  uploadId: string,
  abortControllers: Map<string, AbortController>,
  start: () => AbortController
): void {
  const existing = abortControllers.get(uploadId);
  if (existing) existing.abort();
  const controller = start();
  abortControllers.set(uploadId, controller);
}

const exportConfig: UploadTypeConfig<
  undefined,
  uploadReducer.ExportUploadEntry
> = {
  createEntry: (base, action) => ({
    ...base,
    uploadType: "export" as const,
    exportStage: "queued" as const,
    isBatchEntry: action.isBatchEntry ?? false,
    videoUploadStage: null,
    uploadedBytes: 0,
    totalBytes: null,
  }),

  resetEntry: (base, prev) => ({
    ...base,
    uploadType: "export" as const,
    exportStage: "queued" as const,
    isBatchEntry: prev.isBatchEntry,
    videoUploadStage: null,
    uploadedBytes: 0,
    // The Video's size on disk survives a retry: it is a fact about the file,
    // not about the attempt.
    totalBytes: prev.totalBytes,
  }),

  applySuccess: (entry) => ({
    ...entry,
    status: "success" as const,
    progress: 100,
    errorMessage: null,
    exportStage: null,
    videoUploadStage: null,
  }),

  initiate: (uploadId, entry, _params, dispatch, abortControllers) => {
    withAbortManagement(uploadId, abortControllers, () =>
      startSSEExport(
        { videoId: entry.videoId },
        {
          onStageChange: (stage) => {
            dispatch({ type: "UPDATE_EXPORT_STAGE", uploadId, stage });
          },
          onProgress: (stage, percent) => {
            if (stage === "queued") return;
            dispatch({
              type: "UPDATE_EXPORT_PROGRESS",
              uploadId,
              stage,
              percent,
            });
          },
          onComplete: () => {
            dispatch({ type: "UPLOAD_SUCCESS", uploadId });
            abortControllers.delete(uploadId);
          },
          onError: (message) => {
            dispatch({
              type: "UPLOAD_ERROR",
              uploadId,
              errorMessage: message,
            });
            abortControllers.delete(uploadId);
          },
        }
      )
    );
  },

  supportsDependsOn: false,
};

export interface PublishParams {
  courseId: string;
  name: string;
  description: string;
  includeTodoLessons: boolean;
}

const publishConfig: UploadTypeConfig<
  PublishParams,
  uploadReducer.PublishUploadEntry
> = {
  createEntry: (base, action) => ({
    ...base,
    uploadType: "publish" as const,
    publishStage: "validating" as const,
    newDraftVersionId: null,
    courseId: action.courseId ?? "",
  }),

  resetEntry: (base, prev) => ({
    ...base,
    uploadType: "publish" as const,
    publishStage: "validating" as const,
    newDraftVersionId: null,
    courseId: prev.courseId,
  }),

  applySuccess: (entry) => ({
    ...entry,
    status: "success" as const,
    progress: 100,
    errorMessage: null,
    publishStage: null,
    newDraftVersionId: entry.newDraftVersionId,
    courseId: entry.courseId,
  }),

  initiate: (uploadId, _entry, params, dispatch, abortControllers) => {
    // One task per Video, spanning BOTH halves of its life: encoding, then
    // waiting for an upload slot, then uploading. The id is derived from the
    // videoId rather than remembered in a map, so the export and upload event
    // streams address the same entry without a lookup table to keep in step.
    const videoUploadId = (videoId: string) => `${uploadId}-video-${videoId}`;
    // Videos that have not yet reached a terminal state, so a stream-level
    // failure knows which children to take down with it.
    const liveVideoIds = new Set<string>();
    const settle = (videoId: string, action: uploadReducer.Action) => {
      if (!liveVideoIds.delete(videoId)) return;
      dispatch(action);
    };

    withAbortManagement(uploadId, abortControllers, () =>
      startSSEPublish(
        {
          courseId: params.courseId,
          name: params.name,
          description: params.description,
          includeTodoLessons: params.includeTodoLessons,
        },
        {
          onStageChange: (stage) => {
            dispatch({ type: "UPDATE_PUBLISH_STAGE", uploadId, stage });
          },
          // The whole shipping roster, announced before either pool starts.
          // Every task is created from this one event; the export roster is
          // only a subset of it, so nothing is created from that.
          onPublishVideos: (videos) => {
            for (const video of videos) {
              liveVideoIds.add(video.id);
              dispatch({
                type: "START_UPLOAD",
                uploadId: videoUploadId(video.id),
                videoId: video.id,
                title: video.title,
                uploadType: "export",
                isBatchEntry: true,
                parentUploadId: uploadId,
              });
            }
          },
          onExportStageChange: (videoId, stage) => {
            dispatch({
              type: "UPDATE_EXPORT_STAGE",
              uploadId: videoUploadId(videoId),
              stage,
            });
          },
          onExportProgress: (videoId, stage, percent) => {
            if (stage === "queued") return;
            dispatch({
              type: "UPDATE_EXPORT_PROGRESS",
              uploadId: videoUploadId(videoId),
              stage,
              percent,
            });
          },
          // Terminal per video: the publish already retried the export
          // server-side, and the publish itself is about to fail — never
          // auto-retry a standalone export from here.
          onExportError: (videoId, message) => {
            settle(videoId, {
              type: "UPLOAD_FATAL_ERROR",
              uploadId: videoUploadId(videoId),
              errorMessage: message,
            });
          },
          onVideoUploadQueued: (videoId) => {
            dispatch({
              type: "UPDATE_VIDEO_UPLOAD_STAGE",
              uploadId: videoUploadId(videoId),
              stage: "queued-for-upload",
            });
          },
          onVideoUploadProgress: (videoId, uploadedBytes, totalBytes) => {
            dispatch({
              type: "UPDATE_VIDEO_UPLOAD_PROGRESS",
              uploadId: videoUploadId(videoId),
              uploadedBytes,
              totalBytes,
            });
          },
          onVideoUploadComplete: (videoId) => {
            settle(videoId, {
              type: "UPLOAD_SUCCESS",
              uploadId: videoUploadId(videoId),
            });
          },
          onVideoUploadError: (videoId, message) => {
            settle(videoId, {
              type: "UPLOAD_FATAL_ERROR",
              uploadId: videoUploadId(videoId),
              errorMessage: message,
            });
          },
          onComplete: (result) => {
            dispatch({
              type: "PUBLISH_COMPLETE",
              uploadId,
              newDraftVersionId: result.newDraftVersionId,
            });
            dispatch({ type: "UPLOAD_SUCCESS", uploadId });
            abortControllers.delete(uploadId);
          },
          // A failed Commit auto-Discards the Pending Version server-side
          // (issue #1401), so there is no recoverable "pending" state to
          // retry from here — every failure is terminal for this attempt.
          onError: (message) => {
            // The per-video tasks this publish spawned would otherwise dangle
            // at their last stage forever: the stream that fed them is gone,
            // so fail the ones still in flight too.
            for (const videoId of [...liveVideoIds]) {
              settle(videoId, {
                type: "UPLOAD_FATAL_ERROR",
                uploadId: videoUploadId(videoId),
                errorMessage: message,
              });
            }
            dispatch({
              type: "UPLOAD_FATAL_ERROR",
              uploadId,
              errorMessage: `${message}. Publish status may be unknown, so refresh before starting another publish.`,
            });
            abortControllers.delete(uploadId);
          },
        }
      )
    );
  },

  supportsDependsOn: false,
};

const renderVerticalConfig: UploadTypeConfig<
  undefined,
  uploadReducer.RenderVerticalUploadEntry
> = {
  createEntry: (base) => ({
    ...base,
    uploadType: "render-vertical" as const,
    renderVerticalStage: "concatenating-clips" as const,
  }),

  resetEntry: (base) => ({
    ...base,
    uploadType: "render-vertical" as const,
    renderVerticalStage: "concatenating-clips" as const,
  }),

  applySuccess: (entry) => ({
    ...entry,
    status: "success" as const,
    progress: 100,
    errorMessage: null,
    renderVerticalStage: null,
  }),

  initiate: (uploadId, entry, _params, dispatch, abortControllers) => {
    withAbortManagement(uploadId, abortControllers, () =>
      startSSERenderVertical(
        { videoId: entry.videoId },
        {
          onStageChange: (stage) => {
            dispatch({
              type: "UPDATE_RENDER_VERTICAL_STAGE",
              uploadId,
              stage,
            });
          },
          onComplete: () => {
            dispatch({ type: "UPLOAD_SUCCESS", uploadId });
            abortControllers.delete(uploadId);
          },
          onError: (message) => {
            dispatch({
              type: "UPLOAD_ERROR",
              uploadId,
              errorMessage: message,
            });
            abortControllers.delete(uploadId);
          },
        }
      )
    );
  },

  supportsDependsOn: false,
};

export const uploadTypeRegistry: Record<
  uploadReducer.UploadType,
  UploadTypeConfig<any, any>
> = {
  export: exportConfig,
  publish: publishConfig,
  autofill: autofillConfig,
  "render-vertical": renderVerticalConfig,
};
