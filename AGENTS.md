# Course Video Manager: agent guide

This file is the only source of agent instructions for Codex and Claude Code (`CLAUDE.md` just imports it). It's a map: the detail lives in the files it links to. This repo is **`devin-thomas/course-video-manager`**, a fork of `mattpocock/course-video-manager`. `origin` is the fork and `upstream` is Matt's repo. Never open issues or PRs on upstream.

## Domain language

- [`CONTEXT.md`](./CONTEXT.md) is the ubiquitous-language glossary. It's large, so read the sections you need, not the whole file. Use its terms in code, tests, issues and commit messages, and don't use the synonyms it rules out. How to use it: [docs/agents/domain.md](./docs/agents/domain.md).
- ADRs are in [`docs/adr/`](./docs/adr/). Read the ones that cover the area you're changing. If your change goes against one, say so explicitly.
- **Keep the `cvm` help text in sync with `CONTEXT.md` by hand.** When domain vocabulary or entity fields change in `CONTEXT.md`, update the matching noun/verb help in `apps/local/app/cli/commands/*.ts` (including `*.help.ts`) and the root help in `apps/local/app/cli/index.ts`.

## Repository layout

A Turborepo monorepo on a pnpm workspace. Use Node 22 (`.node-version`) and pnpm 9.12.3 (`packageManager`).

- `apps/local`: today's application (React Router app, Video Editor, publish flow, ffmpeg/OBS, the `cvm` CLI).
- `apps/remote`: the deployed RPC API, a Hono app on Vercel. See [apps/remote/README.md](./apps/remote/README.md).
- `packages/core`: the domain database (schema, `DrizzleService`, every `db-*` service, `CourseWriteService`) and every piece of SQL in the repo. It also holds the pure domain logic both apps share, under `features/` (Clip Zoom, Overlay Kind, Bullet Panel, Overlay Transform). `apps/local` reaches that logic through one-off `@/features/videos/*` aliases in its tsconfig. See [packages/core/README.md](./packages/core/README.md).
- `packages/lucide-icons`: the vendored, append-only lucide icon-node table, plus the tldraw path transpiler behind its own entry point. It's a top-level package because both `apps/local` and `packages/overlay-renderer` use it.
- `packages/overlay-renderer`: the standalone Remotion renderer. It's **excluded from every root turbo filter** (`--filter=!@cvm/overlay-renderer`), so run its scripts from its own directory. See [its AGENTS.md](./packages/overlay-renderer/AGENTS.md).

## Boundaries

- **Neither `packages/core` nor `apps/remote` may import anything filesystem-bound** (`fs`, `path`, `os`, `child_process`, …). Their READMEs explain why. Anything that needs a machine lives in `apps/local` and gets injected.
- Packages under `apps/local/app/packages/` are **deep modules**. Import them only through their entry points, which are the files at the package root. Everything in `lib/` and `tests/` is private. Read [apps/local/app/packages/README.md](./apps/local/app/packages/README.md) before you add or import one.
- `packages/lucide-icons` follows the same rule at workspace level. Its entry points are exactly its `exports` map (`index.ts`, `generator.ts`, `tldraw.ts`), and it has its own `.dependency-cruiser.cjs`.
- `pnpm run lint:boundaries` runs every package's own check. The pre-commit hook runs it together with `typecheck`, and so does CI.

## Commands

- Typecheck with `pnpm run typecheck` (or `pnpm --filter <pkg> typecheck`). **Never run bare `npx tsc`.** A PreToolUse hook blocks it in both Claude Code and Codex (`scripts/agent-hooks/block-npx-tsc.mjs`).
- Check boundaries with `pnpm run lint:boundaries`.
- The pre-commit hook runs lint-staged (prettier), typecheck, lint:boundaries, a file-size check and a no-`__dirname` check. Never skip it with `--no-verify`. Fix whatever it reports instead.

## Testing

There are two tiers, and **you don't run a package's full suite by hand**.

- **While iterating**, run only the test file(s) that cover your change: `pnpm --filter <package> test -- path/to/thing.test.ts`. For root `.sandcastle`/`tests` files, use `pnpm run test:root path/to/file.test.ts` **without** `--`.
- **CI runs everything.** [`.github/workflows/test.yml`](./.github/workflows/test.yml) runs typecheck, lint:boundaries, the full unfiltered `pnpm run test` and overlay-renderer's own checks on every push and PR. Targeting your local runs never leaves a change unverified.
- DB tests use in-process PGlite, so no Postgres server is involved. Under CPU load they can look flaky. See [docs/agents/testing.md](./docs/agents/testing.md) for how to tell that apart from a real regression, and for the `packages/core` build-order gotcha.

## Coding standards

Read [docs/agents/coding-standards.md](./docs/agents/coding-standards.md) before writing code. It covers Effect primitives, optional parameters, routes, filters, fetchers, env config at the edge, testing rules (including "never test Remotion render output") and deep modules.

## The `cvm` CLI

`cvm` (source in `apps/local/app/cli/`) exposes this project's domain data to agents over HTTP through `apps/remote`, and **that is its only transport**. Don't add an in-process fallback. Schema Version mismatches are refused, and some commands are local-only. Read [apps/local/app/cli/AGENTS.md](./apps/local/app/cli/AGENTS.md) before you change the CLI or add a route.

## Backlog and workflow

- Issues and PRDs are GitHub issues in `devin-thomas/course-video-manager`. Pass `-R devin-thomas/course-video-manager` to every `gh` call, because this clone also has an upstream remote. See [docs/agents/backlog.md](./docs/agents/backlog.md).
- Triage labels are the canonical defaults, except `ready-for-agent` is spelled `Sandcastle` here. See [docs/agents/triage-labels.md](./docs/agents/triage-labels.md).
- Project skills live in `.agents/skills/`. Each `.claude/skills/<name>` is a symlink to its `.agents/skills/<name>` copy, so edit the `.agents` copy and keep skills tool-neutral. To add a skill, create it in `.agents/skills/` and add a matching symlink.
- The AFK agent platform (Sandcastle, `.github/workflows/agent-*.yml`) is described in [docs/agents/afk-agent-platform-spec.md](./docs/agents/afk-agent-platform-spec.md).

## Database migrations

Edit `packages/core/db/schema.ts`, then run `pnpm db:generate`. Migrations are **applied by hand** with `pnpm db:migrate` against `DIRECT_DATABASE_URL` (ADR 0026, which supersedes the deploy-applies-migrations rule in ADR 0025), and they are **additive-only**. See the root [README](./README.md#database-migrations).

## Secrets

Never print, commit or paste `.env` (or any `.env.*` except `.env.example`). When you add a new env key, add it to `.env.example` in the same commit.
