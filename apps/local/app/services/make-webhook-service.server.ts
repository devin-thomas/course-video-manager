import { Config, Data, Effect, Either, Redacted } from "effect";

export class MakeWebhookError extends Data.TaggedError("MakeWebhookError")<{
  message: string;
}> {}

/**
 * What CVM hands the "CVM → Buffer" Make scenario. The file is named by its
 * Drive ID, so the scenario never has to search for it by path.
 * `captionJson` is the caption already JSON-encoded, so the scenario can drop
 * it into Buffer's GraphQL body without escaping quotes and newlines itself.
 */
export type SocialPostPayload = {
  caption: string;
  googleDriveFileId: string;
  videoId: string;
  fileName: string;
};

type BufferCreatePostResponse = {
  data?: {
    createPost?: { post?: { id?: unknown }; message?: unknown } | null;
  } | null;
  errors?: Array<{ message?: unknown }>;
};

/**
 * The scenario ends in a Webhook Response that returns Buffer's raw
 * `createPost` GraphQL response, so what comes back is Buffer's own answer:
 * a post ID, a `MutationError` message, or GraphQL `errors`.
 *
 * A bare `Accepted` is Make's reply when no Webhook Response ran — the
 * scenario is switched off (Make queues the call) or has no such module. The
 * hand-off itself succeeded, so it counts as posted, without a Buffer ID.
 */
export const readScenarioResponse = (
  text: string
): Either.Either<string | null, string> => {
  let body: BufferCreatePostResponse;
  try {
    body = JSON.parse(text) as BufferCreatePostResponse;
  } catch {
    return text.trim() === "Accepted"
      ? Either.right(null)
      : Either.left(`Unexpected response from Make: ${text.slice(0, 200)}`);
  }
  const errors = (body.errors ?? [])
    .map((e) => (typeof e.message === "string" ? e.message : ""))
    .filter(Boolean);
  if (errors.length > 0) return Either.left(`Buffer: ${errors.join(", ")}`);
  const result = body.data?.createPost;
  if (typeof result?.post?.id === "string" && result.post.id) {
    return Either.right(result.post.id);
  }
  return Either.left(
    `Buffer createPost failed: ${
      typeof result?.message === "string" ? result.message : "unknown error"
    }`
  );
};

export class MakeWebhookService extends Effect.Service<MakeWebhookService>()(
  "MakeWebhookService",
  {
    succeed: {
      sendSocialPost: Effect.fn("sendSocialPostToMake")(function* (
        payload: SocialPostPayload
      ) {
        const url = yield* Config.redacted("MAKE_SOCIAL_WEBHOOK_URL");
        const text = yield* Effect.tryPromise({
          try: async () => {
            const response = await fetch(Redacted.value(url), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...payload,
                captionJson: JSON.stringify(payload.caption),
              }),
            });
            const body = await response.text();
            if (!response.ok) {
              throw new Error(`Make webhook ${response.status}: ${body}`);
            }
            return body;
          },
          catch: (e) =>
            new MakeWebhookError({
              message: e instanceof Error ? e.message : String(e),
            }),
        });
        const bufferPostId = yield* Either.match(readScenarioResponse(text), {
          onLeft: (message) => Effect.fail(new MakeWebhookError({ message })),
          onRight: (id) => Effect.succeed(id),
        });
        return { bufferPostId };
      }),
    },
  }
) {}
