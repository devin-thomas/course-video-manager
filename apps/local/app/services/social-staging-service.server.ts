import { Config, Effect } from "effect";
import { stat } from "node:fs/promises";
import {
  listChildren,
  trashFile,
  uploadFileFromDisk,
} from "./google-drive-http-client";
import { getValidGoogleDriveAccessToken } from "./google-drive-auth-service";
import { LinkAuthOperationsService } from "@/services/db-link-auth-operations.server";

/** Staged files older than this are trashed the next time something is staged. */
const STAGING_RETENTION_DAYS = 7;

/**
 * The Google Drive folder a social post's video is handed over through
 * (`GOOGLE_DRIVE_SOCIAL_STAGING_FOLDER_ID`). CVM puts the file there and
 * passes its ID on; Make shares it and hands its URL to Buffer.
 *
 * Buffer fetches the video some time after the post is created, so nothing
 * here deletes the file it just staged. Instead each staging trashes whatever
 * is older than a week — the job the S3 lifecycle rule used to do.
 */
export class SocialStagingService extends Effect.Service<SocialStagingService>()(
  "SocialStagingService",
  {
    effect: Effect.gen(function* () {
      const linkAuth = yield* LinkAuthOperationsService;
      const accessTokenNow = getValidGoogleDriveAccessToken.pipe(
        Effect.provideService(LinkAuthOperationsService, linkAuth)
      );
      return {
        stage: Effect.fn("stageSocialVideo")(function* (opts: {
          filePath: string;
          fileName: string;
          onProgress?: (percentage: number) => void;
        }) {
          const folderId = yield* Config.string(
            "GOOGLE_DRIVE_SOCIAL_STAGING_FOLDER_ID"
          );
          const accessToken = yield* accessTokenNow;

          const cutoff = new Date(
            Date.now() - STAGING_RETENTION_DAYS * 24 * 60 * 60 * 1000
          ).toISOString();
          yield* listChildren({
            accessToken,
            folderId,
            where: `createdTime < '${cutoff}'`,
          }).pipe(
            Effect.flatMap((stale) =>
              Effect.forEach(
                stale,
                (file) => trashFile({ accessToken, fileId: file.id }),
                { concurrency: 4, discard: true }
              )
            ),
            // Tidying is best-effort; a failure here must not block the post.
            Effect.ignore
          );

          const { size } = yield* Effect.promise(() => stat(opts.filePath));
          const uploaded = yield* uploadFileFromDisk({
            accessToken,
            parentId: folderId,
            name: opts.fileName,
            filePath: opts.filePath,
            fileSize: size,
            onProgress: (uploadedBytes, total) =>
              opts.onProgress?.(
                total === 0 ? 100 : Math.round((uploadedBytes / total) * 100)
              ),
          });
          return { fileId: uploaded.id };
        }),
      };
    }),
    dependencies: [LinkAuthOperationsService.Default],
  }
) {}
