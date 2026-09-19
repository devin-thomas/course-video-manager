import { ConfigProvider, Console, Data, Effect, Redacted } from "effect";
import { redirect } from "react-router";
import { runtimeLive } from "@/services/layer.server";
import { LinkAuthOperationsService } from "@/services/db-link-auth-operations.server";
import {
  GOOGLE_DRIVE_CALLBACK_PATH,
  googleDriveClientCredentials,
} from "@/services/google-drive-auth-service";
import { safeReturnTo } from "@/services/google-drive-return-to";

class GoogleDriveOAuthError extends Data.TaggedError("GoogleDriveOAuthError")<{
  message: string;
}> {}

export const loader = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = safeReturnTo(url.searchParams.get("state"));
  const error = url.searchParams.get("error");

  if (error) {
    console.error("Google Drive OAuth error:", error);
    return redirect(`${state}?error=oauth_${encodeURIComponent(error)}`);
  }
  if (!code) {
    return redirect(`${state}?error=no_code`);
  }

  return Effect.gen(function* () {
    const { clientId, clientSecret } = yield* googleDriveClientCredentials;
    const linkAuthOps = yield* LinkAuthOperationsService;

    const tokenResponse = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: Redacted.value(clientSecret),
            redirect_uri: `${url.origin}${GOOGLE_DRIVE_CALLBACK_PATH}`,
            grant_type: "authorization_code",
          }),
        });
        if (!response.ok) {
          throw new Error(`Token exchange failed: ${await response.text()}`);
        }
        return response.json() as Promise<{
          access_token: string;
          refresh_token?: string;
          expires_in: number;
        }>;
      },
      catch: (e) =>
        new GoogleDriveOAuthError({
          message: e instanceof Error ? e.message : "Token exchange failed",
        }),
    });

    if (!tokenResponse.refresh_token) {
      return yield* new GoogleDriveOAuthError({
        message: "No refresh token received from Google",
      });
    }

    yield* linkAuthOps.upsertGoogleDriveAuth({
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
    });

    yield* Effect.logInfo("Google Drive OAuth tokens stored successfully");
    return redirect(state);
  }).pipe(
    Effect.tapErrorCause((e) => Console.log(e)),
    Effect.catchTag("ConfigError", () =>
      Effect.succeed(redirect("/?error=oauth_not_configured"))
    ),
    Effect.catchTag("GoogleDriveOAuthError", (e) => {
      console.error("Google Drive OAuth error:", e.message);
      return Effect.succeed(redirect(`${state}?error=oauth_failed`));
    }),
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    Effect.catchAll((e) => {
      console.error("Google Drive OAuth callback error:", e);
      return Effect.succeed(redirect(`${state}?error=oauth_error`));
    }),
    runtimeLive.runPromise
  );
};
