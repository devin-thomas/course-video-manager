import { CoursePublishService } from "@/services/course-publish-service";
import { createSSEResponse } from "@/lib/create-sse-response.server";
import type { Route } from "./+types/api.courses.sync-sse";
import { ConfigProvider, Effect, Schema } from "effect";
import { runtimeLive } from "@/services/layer.server";

const publishRepoSchema = Schema.Struct({
  repoId: Schema.String,
  courseVersionId: Schema.optional(Schema.String),
  includeTodoLessons: Schema.optional(Schema.Boolean),
});

/**
 * Re-sync a frozen Course Version's Bundle and Commit receipt to Google Drive
 * without Submitting anything: the latest Published Version, or — for a
 * Pending commit being retried — the exact Version named.
 */
export const action = async ({ request }: Route.ActionArgs) => {
  const body = await request.json();

  return createSSEResponse({
    runtime: runtimeLive,
    program: (sendEvent) =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(publishRepoSchema)(body);

        const publishService = yield* CoursePublishService;
        // Pending commits must retry the exact frozen Course Version with the
        // original to-do policy. Without an id, re-sync the latest frozen version.
        const { missingVideos } = result.courseVersionId
          ? yield* publishService.syncFrozenVersion(
              result.repoId,
              result.courseVersionId,
              result.includeTodoLessons ?? true,
              sendEvent
            )
          : yield* publishService.syncPublishedVersion(
              result.repoId,
              result.includeTodoLessons ?? true,
              sendEvent
            );

        sendEvent("complete", {
          missingVideoCount: missingVideos.length,
        });
      }).pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
    errorHandlers: [
      {
        tag: "GoogleDriveNotAuthenticatedError",
        handler: (_error, sendEvent) => {
          sendEvent("error", {
            message:
              "Google Drive is not connected. Connect it from the publish page before syncing.",
          });
        },
      },
    ],
    fallbackMessage: "Publish failed unexpectedly",
  });
};
