import { Effect, Config } from "effect";
import { FileSystem } from "@effect/platform";
import { VideoPostOperationsService } from "@/services/db-video-post-operations.server";
import { SocialStagingService } from "@/services/social-staging-service.server";
import { MakeWebhookService } from "@/services/make-webhook-service.server";
import type { SendEvent } from "@/lib/create-sse-response.server";

/**
 * Post an exported vertical video to Buffer, by way of Make.
 *
 * CVM stages the file in the Google Drive social-staging folder and sends the
 * caption plus the file's Drive ID to the "CVM → Buffer" Make scenario, which
 * shares the file and queues it in Buffer. "Posted" means "handed to Make":
 * Buffer fetches the video asynchronously and there is no delivery receipt.
 */
export const bufferPostProgram = (opts: {
  videoId: string;
  caption: string;
  sendEvent: SendEvent;
}) =>
  Effect.gen(function* () {
    const finishedDir = yield* Config.string("FINISHED_VIDEOS_DIRECTORY");
    const fs = yield* FileSystem.FileSystem;
    const videoPostOps = yield* VideoPostOperationsService;
    const staging = yield* SocialStagingService;
    const make = yield* MakeWebhookService;

    const filePath = `${finishedDir}/${opts.videoId}.mp4`;
    const exists = yield* fs.exists(filePath);
    if (!exists) {
      opts.sendEvent("error", {
        message: "Exported vertical video not found. Export it first.",
      });
      return;
    }

    const post = yield* videoPostOps.createVideoPost({
      videoId: opts.videoId,
      platform: "buffer",
    });

    opts.sendEvent("uploading-blob", { percentage: 0 });

    const fileName = `${opts.videoId}.mp4`;
    const staged = yield* staging.stage({
      filePath,
      fileName,
      onProgress: (percentage) => {
        opts.sendEvent("uploading-blob", { percentage });
      },
    });

    opts.sendEvent("creating-post", {});

    const { bufferPostId } = yield* make.sendSocialPost({
      caption: opts.caption,
      googleDriveFileId: staged.fileId,
      videoId: opts.videoId,
      fileName,
    });

    if (bufferPostId) {
      yield* videoPostOps.updateRemoteInfo({
        id: post.id,
        remoteId: bufferPostId,
        remoteUrl: null,
      });
    }

    yield* videoPostOps.markPosted(post.id);

    opts.sendEvent("complete", {});
  });
