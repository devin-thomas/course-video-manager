import { DrizzleService, type Database } from "./drizzle-service.server.js";
import {
  links,
  aiHeroAuth,
  dropboxAuth,
  googleDriveAuth,
} from "../db/schema.js";
import { NotFoundError, UnknownDBServiceError } from "./db-service-errors.js";
import { desc, eq } from "drizzle-orm";
import { Effect } from "effect";

const makeDbCall = <T>(fn: () => Promise<T>) => {
  return Effect.tryPromise({
    try: fn,
    catch: (e) => new UnknownDBServiceError({ cause: e }),
  });
};

export const createLinkAuthOperations = (db: Database) => {
  const getLinks = Effect.fn("getLinks")(function* () {
    const allLinks = yield* makeDbCall(() =>
      db.query.links.findMany({
        orderBy: desc(links.createdAt),
      })
    );
    return allLinks;
  });

  const createLink = Effect.fn("createLink")(function* (link: {
    title: string;
    url: string;
    description?: string | null;
  }) {
    const [newLink] = yield* makeDbCall(() =>
      db
        .insert(links)
        .values({
          title: link.title,
          url: link.url,
          description: link.description ?? null,
        })
        .returning()
    );

    if (!newLink) {
      return yield* new UnknownDBServiceError({
        cause: "No link was returned from the database",
      });
    }

    return newLink;
  });

  const deleteLink = Effect.fn("deleteLink")(function* (linkId: string) {
    yield* makeDbCall(() => db.delete(links).where(eq(links.id, linkId)));
    return { success: true };
  });

  const getAiHeroAuth = Effect.fn("getAiHeroAuth")(function* () {
    const auth = yield* makeDbCall(() => db.query.aiHeroAuth.findFirst());
    return auth ?? null;
  });

  const upsertAiHeroAuth = Effect.fn("upsertAiHeroAuth")(function* (params: {
    accessToken: string;
    userId: string;
  }) {
    yield* makeDbCall(() => db.delete(aiHeroAuth));

    const [newAuth] = yield* makeDbCall(() =>
      db
        .insert(aiHeroAuth)
        .values({
          accessToken: params.accessToken,
          userId: params.userId,
        })
        .returning()
    );

    if (!newAuth) {
      return yield* new UnknownDBServiceError({
        cause: "No AI Hero auth was returned from the database",
      });
    }

    return newAuth;
  });

  const deleteAiHeroAuth = Effect.fn("deleteAiHeroAuth")(function* () {
    yield* makeDbCall(() => db.delete(aiHeroAuth));
    return { success: true };
  });

  const getDropboxAuth = Effect.fn("getDropboxAuth")(function* () {
    const auth = yield* makeDbCall(() => db.query.dropboxAuth.findFirst());
    return auth ?? null;
  });

  const upsertDropboxAuth = Effect.fn("upsertDropboxAuth")(function* (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }) {
    yield* makeDbCall(() => db.delete(dropboxAuth));

    const [newAuth] = yield* makeDbCall(() =>
      db
        .insert(dropboxAuth)
        .values({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        })
        .returning()
    );

    if (!newAuth) {
      return yield* new UnknownDBServiceError({
        cause: "No Dropbox auth was returned from the database",
      });
    }

    return newAuth;
  });

  const updateDropboxAccessToken = Effect.fn("updateDropboxAccessToken")(
    function* (tokens: { accessToken: string; expiresAt: Date }) {
      const existing = yield* makeDbCall(() =>
        db.query.dropboxAuth.findFirst()
      );

      if (!existing) {
        return yield* new NotFoundError({
          type: "updateDropboxAccessToken",
          params: {},
          message: "No Dropbox auth found to update",
        });
      }

      const [updated] = yield* makeDbCall(() =>
        db
          .update(dropboxAuth)
          .set({
            accessToken: tokens.accessToken,
            expiresAt: tokens.expiresAt,
            updatedAt: new Date(),
          })
          .where(eq(dropboxAuth.id, existing.id))
          .returning()
      );

      if (!updated) {
        return yield* new NotFoundError({
          type: "updateDropboxAccessToken",
          params: {},
        });
      }

      return updated;
    }
  );

  const deleteDropboxAuth = Effect.fn("deleteDropboxAuth")(function* () {
    yield* makeDbCall(() => db.delete(dropboxAuth));
    return { success: true };
  });

  const getGoogleDriveAuth = Effect.fn("getGoogleDriveAuth")(function* () {
    const auth = yield* makeDbCall(() => db.query.googleDriveAuth.findFirst());
    return auth ?? null;
  });

  const upsertGoogleDriveAuth = Effect.fn("upsertGoogleDriveAuth")(
    function* (tokens: {
      accessToken: string;
      refreshToken: string;
      expiresAt: Date;
    }) {
      yield* makeDbCall(() => db.delete(googleDriveAuth));

      const [newAuth] = yield* makeDbCall(() =>
        db
          .insert(googleDriveAuth)
          .values({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
          })
          .returning()
      );

      if (!newAuth) {
        return yield* new UnknownDBServiceError({
          cause: "No Google Drive auth was returned from the database",
        });
      }

      return newAuth;
    }
  );

  const updateGoogleDriveAccessToken = Effect.fn(
    "updateGoogleDriveAccessToken"
  )(function* (tokens: { accessToken: string; expiresAt: Date }) {
    const existing = yield* makeDbCall(() =>
      db.query.googleDriveAuth.findFirst()
    );

    if (!existing) {
      return yield* new NotFoundError({
        type: "updateGoogleDriveAccessToken",
        params: {},
        message: "No Google Drive auth found to update",
      });
    }

    const [updated] = yield* makeDbCall(() =>
      db
        .update(googleDriveAuth)
        .set({
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(googleDriveAuth.id, existing.id))
        .returning()
    );

    if (!updated) {
      return yield* new NotFoundError({
        type: "updateGoogleDriveAccessToken",
        params: {},
      });
    }

    return updated;
  });

  const deleteGoogleDriveAuth = Effect.fn("deleteGoogleDriveAuth")(
    function* () {
      yield* makeDbCall(() => db.delete(googleDriveAuth));
      return { success: true };
    }
  );

  return {
    getLinks,
    createLink,
    deleteLink,
    getAiHeroAuth,
    upsertAiHeroAuth,
    deleteAiHeroAuth,
    getDropboxAuth,
    upsertDropboxAuth,
    updateDropboxAccessToken,
    deleteDropboxAuth,
    getGoogleDriveAuth,
    upsertGoogleDriveAuth,
    updateGoogleDriveAccessToken,
    deleteGoogleDriveAuth,
  };
};

export class LinkAuthOperationsService extends Effect.Service<LinkAuthOperationsService>()(
  "LinkAuthOperationsService",
  {
    effect: Effect.gen(function* () {
      const db = yield* DrizzleService;
      return createLinkAuthOperations(db);
    }),
  }
) {}
