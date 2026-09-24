import { ConfigProvider, Console, Effect } from "effect";
import { redirect } from "react-router";
import {
  GOOGLE_DRIVE_CALLBACK_PATH,
  GOOGLE_DRIVE_SCOPES,
  googleDriveClientCredentials,
} from "@/services/google-drive-auth-service";
import {
  returnToWithError,
  safeReturnTo,
} from "@/services/google-drive-return-to";

/**
 * Starts the Google OAuth flow that lets CVM publish into Google Drive. Visit
 * `/api/auth/google-drive/initiate` while signed in to the Drive account that
 * owns `GOOGLE_DRIVE_COURSES_FOLDER_ID`.
 */
export const loader = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));

  return Effect.gen(function* () {
    const { clientId } = yield* googleDriveClientCredentials;

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set(
      "redirect_uri",
      `${url.origin}${GOOGLE_DRIVE_CALLBACK_PATH}`
    );
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", GOOGLE_DRIVE_SCOPES.join(" "));
    authUrl.searchParams.set("access_type", "offline");
    // Always ask again, so Google always returns a refresh token.
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", returnTo);

    return redirect(authUrl.toString());
  }).pipe(
    Effect.tapErrorCause((e) => Console.log(e)),
    // GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET missing: back to
    // where the author came from, which shows the error beside the button.
    Effect.catchTag("ConfigError", () =>
      Effect.succeed(
        redirect(returnToWithError(returnTo, "oauth_not_configured"))
      )
    ),
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    Effect.catchAll(() =>
      Effect.die(new Response("Internal server error", { status: 500 }))
    ),
    Effect.runPromise
  );
};
