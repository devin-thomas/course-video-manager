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

## Not in this fork: YouTube and Buffer posting

Upstream uploads finished videos to YouTube and posts vertical Shorts to
Buffer (by way of S3, and a Make or Zapier scenario). Both integrations are
removed here: this fork publishes Course bundles to Google Drive and nothing
else, so it needs no YouTube or Buffer API credentials.

What is kept: the Post tab still drafts a title, description and thumbnail
(including the AI generators for them), the Shorts editor still records,
edits, exports and renders vertical video, and the AI Hero, newsletter and
skills-changelog posting paths are untouched.

The `youtube_auth` table is still in the schema, unused. Migrations here are
additive-only, so dropping it is a separate two-step change.
