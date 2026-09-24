import { Config, ConfigProvider, Data, Effect, Redacted } from "effect";
import { LinkAuthOperationsService } from "@/services/db-link-auth-operations.server";

export class GoogleDriveAuthError extends Data.TaggedError(
  "GoogleDriveAuthError"
)<{
  message: string;
  code?: string;
}> {}

export class GoogleDriveNotAuthenticatedError extends Data.TaggedError(
  "GoogleDriveNotAuthenticatedError"
)<{}> {}

/**
 * Full Drive access: the Publish writes into a folder the author created by
 * hand (`GOOGLE_DRIVE_COURSES_FOLDER_ID`), which the narrower `drive.file`
 * scope cannot see.
 */
export const GOOGLE_DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
];

export const GOOGLE_DRIVE_CALLBACK_PATH = "/api/auth/google-drive/callback";

export const googleDriveClientCredentials = Effect.all({
  clientId: Config.string("GOOGLE_DRIVE_CLIENT_ID"),
  clientSecret: Config.redacted("GOOGLE_DRIVE_CLIENT_SECRET"),
});

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const refreshAccessToken = Effect.fn("refreshGoogleDriveAccessToken")(
  function* (refreshToken: string) {
    const { clientId, clientSecret } = yield* googleDriveClientCredentials;

    const tokenResponse = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: Redacted.value(clientSecret),
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
        });

        if (!response.ok) {
          const errorData = await response.text();
          throw new Error(`Google Drive token refresh failed: ${errorData}`);
        }

        return response.json() as Promise<{
          access_token: string;
          expires_in: number;
        }>;
      },
      catch: (e) =>
        new GoogleDriveAuthError({
          message:
            e instanceof Error
              ? e.message
              : "Google Drive token refresh failed",
          code: "refresh_failed",
        }),
    });

    return {
      accessToken: tokenResponse.access_token,
      expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
    };
  }
);

export const getValidGoogleDriveAccessToken = Effect.gen(function* () {
  const linkAuthOps = yield* LinkAuthOperationsService;
  const auth = yield* linkAuthOps.getGoogleDriveAuth();

  if (!auth) {
    return yield* new GoogleDriveNotAuthenticatedError();
  }

  const isExpired =
    Date.now() >= auth.expiresAt.getTime() - TOKEN_REFRESH_BUFFER_MS;

  if (isExpired) {
    const newTokens = yield* refreshAccessToken(auth.refreshToken).pipe(
      Effect.withConfigProvider(ConfigProvider.fromEnv())
    );

    yield* linkAuthOps.updateGoogleDriveAccessToken({
      accessToken: newTokens.accessToken,
      expiresAt: newTokens.expiresAt,
    });

    yield* Effect.logInfo("Google Drive access token refreshed successfully");
    return newTokens.accessToken;
  }

  return auth.accessToken;
});

export const isGoogleDriveAuthenticated = Effect.gen(function* () {
  const linkAuthOps = yield* LinkAuthOperationsService;
  const auth = yield* linkAuthOps.getGoogleDriveAuth();
  return auth !== null;
});
