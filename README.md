# Course Video Manager

A tool for managing course video publishing workflows — editing metadata, generating descriptions, creating thumbnails, and posting to social platforms.

## Repository layout

A Turborepo monorepo over the pnpm workspace:

| Directory                   | What it is                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/local`                | The application as it runs on the author's machine: the React Router app, the Video Editor, the Diagram Playground, the Publish flow, ffmpeg, OBS, and the `cvm` CLI |
| `packages/core`             | The domain database — the Drizzle schema, the `DrizzleService` and every `db-*` operations service. Every piece of SQL in the repo lives here                        |
| `packages/overlay-renderer` | The standalone Remotion renderer for every overlay content-kind — subtitles, the CTA, and Definition Cards — with its own toolchain                                  |

`packages/core` has **no filesystem access, no `child_process` and no git
coupling**, so it can be deployed as well as run locally. `pnpm lint:boundaries`
enforces that — anything that needs a machine is injected from `apps/local`
(see `packages/core/services/diagram-thumbnail-store.ts` for the shape).

`.env` lives at the workspace root: one file for the whole monorepo, which is
also where `cvm` looks for it (`apps/local/app/cli/env.ts`).

### Commands

Run these from the workspace root; Turborepo fans them out and re-runs only what
changed.

| Script                 | Description                    |
| ---------------------- | ------------------------------ |
| `pnpm typecheck`       | Typecheck every package        |
| `pnpm test`            | Run every suite once           |
| `pnpm test:watch`      | Run every suite in watch mode  |
| `pnpm lint:boundaries` | Enforce the package boundaries |
| `pnpm dev`             | Start the local application    |
| `pnpm build`           | Build the local application    |

Each of these filters out `@cvm/overlay-renderer`: it ships its own
toolchain (Remotion, and a Chromium download) and has never been part of the
application's checks. Run it with `pnpm --filter @cvm/overlay-renderer`.

### Deploys

Vercel gets one project per deployable directory, each with its own Root
Directory, and relies on Vercel's **built-in unaffected-project skipping** to
decide what to deploy. There is deliberately **no Ignored Build Step**:
`turbo-ignore` is deprecated, and native skipping does not consume a concurrent
build slot. If a custom step is ever needed it is `turbo query affected`.

## Database migrations

Schema changes are managed with **drizzle-kit generate / migrate** (versioned SQL files), not `push`. The schema, the migrations and the drizzle config all live in `packages/core`.

### Making a schema change

1. Edit `packages/core/db/schema.ts`.
2. `pnpm db:generate` — creates a new numbered `.sql` file under `packages/core/db/migrations/`.
3. Commit it, then `pnpm db:migrate` — run by hand, against `DIRECT_DATABASE_URL` — before or as part of deploying `apps/remote`. Applying migrations used to be the deploy's job exclusively; it moved to a manual step because that ran on every Vercel build, previews included, and could land an unmerged migration on the production schema. See `apps/remote/README.md` and [ADR 0026](docs/adr/0026-migrations-applied-by-hand.md).

Migrations are **additive-only**: no dropped or renamed columns without a two-step release. A `cvm` invocation may be in flight while a deploy lands, and it is the additive rule — not the version gate — that keeps that from breaking. The version gate refuses the box's _next_ command, naming both migration counts and telling it to pull (`packages/core/rpc/schema-version.ts`).

### First-time setup on an existing database

If the database was originally created via `drizzle-kit push` and has never run migrations:

```sh
pnpm db:baseline
```

This registers the `0000` baseline migration as already-applied so the next `pnpm db:migrate` won't replay the initial `CREATE TABLE` statements.

### Scripts

| Script             | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `pnpm db:generate` | Generate a new migration from schema changes                  |
| `pnpm db:migrate`  | Apply pending migrations by hand (deploy no longer does this) |
| `pnpm db:baseline` | Mark the `0000` baseline as applied (one-time setup)          |
| `pnpm db:studio`   | Open Drizzle Studio                                           |

## Social posts: Google Drive → Make → Buffer

"Post to Buffer" hands a Short to Buffer by way of a Make scenario. Nothing here uses AWS or a Buffer SDK:

1. CVM uploads the exported vertical video to the Google Drive folder `GOOGLE_DRIVE_SOCIAL_STAGING_FOLDER_ID`. It uses the same Drive connection as publishing (`/api/auth/google-drive/initiate`). Staged files older than 7 days are moved to the Drive trash on the next post.
2. CVM POSTs `{caption, captionJson, googleDriveFileId, videoId, fileName}` to `MAKE_SOCIAL_WEBHOOK_URL`. `captionJson` is the caption already JSON-encoded.
3. The **CVM → Buffer (social post)** Make scenario runs four modules:
   - **Webhooks › Custom webhook** receives the call.
   - **Google Drive › Get a Share Link** makes the file viewable by anyone with the link (Type _Anyone_, Role _Reader_, not discoverable).
   - **HTTP › Make a request** sends `POST https://api.buffer.com` with the same `createPost` GraphQL mutation upstream CVM sent directly. It includes `"text": {{captionJson}}`, a video asset at `https://drive.usercontent.google.com/download?id={{googleDriveFileId}}&export=download&confirm=t`, and `mode: shareNow`. The Buffer token comes from a Make API-key keychain, `Authorization: Bearer …`. Parse response is off.
   - **Webhooks › Webhook response** returns 200 with Buffer's raw response as the body.
4. CVM reads that response. A post ID becomes the post's remote ID. A `MutationError` or GraphQL error fails the post, so it is not marked posted.

Make's own Buffer app is not used, because it cannot attach video.

### Finishing the scenario (one-time)

- In Make, go to **Credentials › Keys**, open **Buffer API token**, and replace the placeholder with `Bearer <your Buffer API token>`.
- In the HTTP module body, replace `YOUR_BUFFER_CHANNEL_ID` with the Buffer channel ID. Upstream kept this in `BUFFER_CHANNEL_ID`.
- Switch the scenario **on**. While it is off, Make queues incoming calls and answers `Accepted`. CVM counts that as handed off, and the queued posts publish when the scenario is switched on.
