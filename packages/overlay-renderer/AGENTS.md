# `@cvm/overlay-renderer`: agent notes

This is the standalone Remotion renderer for Overlay content (Definition Cards, Bullet Panels) and the vertical Shorts overlay. These rules add to the root [AGENTS.md](../../AGENTS.md). [README.md](./README.md) covers the props contract, the CLI and transparency settings.

## Outside the root toolchain

- `apps/local` **shells out to the built `bin.mjs`**. It doesn't import the render path, which keeps Remotion and Chromium out of the application's toolchain. Don't add an import of `src/render.ts` from the app.
- This package is **excluded from every root turbo filter** (`--filter=!@cvm/overlay-renderer`), so root `pnpm run test`, `typecheck` and `lint:boundaries` never cover it. Run its own scripts from this directory, or with `pnpm --filter @cvm/overlay-renderer <script>`:
  - `pnpm test`: props and timing unit tests. No Chromium.
  - `pnpm run typecheck`: runs `tsc --noEmit` (the package script, not a bare `npx tsc`).
  - `pnpm run studio`: Remotion Studio. **This is how you check a visual or branding change.**
- CI runs its `typecheck` and `test` as a separate job (`.github/workflows/test.yml`).

## Testing rule

**Never write an automated test against the actual render output.** A real render boots Chromium, takes minutes and asserts on pixels that a deliberate branding change is supposed to move. What you can test is the props schema (pure validation) and the orchestration around the render (the props a service builds and the arguments it spawns the renderer with, faked at the process boundary). The full rule is in `docs/agents/coding-standards.md` under "Remotion renderer packages".

## Invariants

- The transparency settings (`prores`, profile `4444`, `yuva444p10le`, `png` frames) are set in both `remotion.config.ts` and `src/render.ts`. Don't change them without re-checking the ffmpeg composite downstream.
- The package needs no secrets and no `.env`, and renders locally only. Don't add AWS/Lambda code paths.
- It depends on `@cvm/lucide-icons` only through that package's entry points.
