# @cvm/core

The domain database: the Drizzle schema (`db/schema.ts`) and its migrations, the
`DrizzleService`, every `db-*` operations service and `CourseWriteService` —
every piece of SQL in the repo. It also holds the pure domain logic both apps
share, under `features/` (Clip Zoom, Overlay Kind, Bullet Panel, Overlay
Transform); `apps/local` reaches those through `@/features/videos/*` aliases.

## Filesystem-free

`apps/remote` is built from this package and runs on a box with no disk, no
ffmpeg, no OBS and no git checkout. So **nothing here may import anything
filesystem-bound** — `fs`, `path`, `os`, `child_process`, glob/spawn libraries
and the like. That is a build failure, not a convention:
[`.dependency-cruiser.cjs`](./.dependency-cruiser.cjs) lists the forbidden
modules and `pnpm run lint:boundaries` enforces it (tests and `test-utils/` are
exempt). Anything that needs a machine lives in `apps/local` and is injected —
see `services/diagram-thumbnail-store.ts` for the shape. This package also may
not import from either app.

## Consumed via `dist/`

The `exports` map points at `dist/`, even for tests. `pnpm run test` builds it
first through Turbo; running vitest directly in `apps/local` or `apps/remote`
needs `pnpm --filter @cvm/core build` once beforehand.

## Tests

Every test runs the real services over in-process PGlite (ADR 0014) — no
Postgres server, no `DATABASE_URL`. `test-utils/global-setup.ts` pushes the
schema once and snapshots it for each fork.

## Migrations

`pnpm db:generate` after editing the schema; migrations are applied by hand and
are additive-only — see the root [README](../../README.md#database-migrations)
and ADR 0026.
