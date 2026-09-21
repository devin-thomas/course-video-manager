import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

/**
 * Shown on the publish page while Google Drive is not connected. A Publish
 * commits its Bundle and `course.json` to Drive, so until the OAuth round trip
 * has stored a token the Publish button stays disabled and this is the way to
 * connect. The callback returns here, with `?error=…` if it failed.
 */
export function GoogleDriveConnectBanner({
  connected,
  returnTo,
  oauthError,
}: {
  connected: boolean;
  returnTo: string;
  oauthError: string | null;
}) {
  if (connected) return null;

  const connectUrl = `/api/auth/google-drive/initiate?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <div className="mb-8 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="w-5 h-5 text-amber-500" />
        <span className="text-sm font-medium text-amber-500">
          Google Drive is not connected
        </span>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        Publishing uploads this course to Google Drive. Connect the account that
        owns the courses folder.
      </p>
      {oauthError && (
        <p className="text-sm text-destructive mb-3">
          Connecting failed ({oauthError}). Try again.
        </p>
      )}
      <Button asChild variant="outline" size="sm">
        <a href={connectUrl}>Connect Google Drive</a>
      </Button>
    </div>
  );
}
