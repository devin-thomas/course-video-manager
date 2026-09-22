# `cvm` CLI: agent notes

`cvm` is a read-mostly CLI that exposes this project's domain data to agents. These rules add to the root [AGENTS.md](../../../../AGENTS.md). ADR 0025 (`docs/adr/0025-local-remote-split-one-http-transport.md`) explains why.

## One transport

- Every verb group reaches the data over HTTP through `apps/remote`, authenticated with a bearer token (`CVM_API_URL` + `CVM_API_TOKEN`). **There is one transport.** The author's invocations and an agent's both use it. **Don't add an in-process fallback.**
- Because of that, `cvm` needs no `DATABASE_URL`. The one exception is `course publish`, which runs the publish pipeline in-process on the author's machine and still reads it.

## Schema Version gate

- Every request states the **Schema Version** its checkout was built against. A mismatch is refused outright (exit 6), and the message tells the caller to pull. See `packages/core/rpc/schema-version.ts`.
- Migrations are applied by hand (ADR 0026, which supersedes ADR 0025's "the deploy applies them") and are **additive-only**. The additive rule, not the gate, is what keeps a `cvm` call that's already in flight safe while a deploy lands.

## Local-only commands

Some commands need the author's disk. They refuse on any other machine **before doing any work** (exit 7, `LocalOnlyCommandError`): `cvm file`, `cvm course readiness`, `cvm course publish` and `cvm footage`. The author's machine declares itself with `CVM_LOCAL_MACHINE`. Callers of `requireLocalMachine` (`local-only.ts`) are the authoritative list.

## Adding a service method

Add one `.post` in `apps/remote/routes/<noun>.ts` and one `rpcMethod` line in `rpc-layer.ts`. The build checks the route table, the service signature and the argument order. A service method that no command calls gets no route.

## Writes

- Most nouns are read-only. The write-capable ones reuse their operations service's write methods: `learning-goal` (create/update/move/delete, a Section's pre-Beat planning artifact), `beat` (add/update/move/delete), `clip` (add/update/move/delete), `chapter` (add/update/move/delete), `overlay` (add/update/delete), `section` (create/rename/move/archive), `lesson` (create/update/move/archive), `video` (create/move/update), `file` (add/delete), `footage` (transcribe), `pitch` (create/update), `deliverable` (create/update/archive, the deadline surface from ADR 0022) and `course` (publish). The root help in `index.ts` is the current list, and each verb's own `--help` says whether it reads or writes.
- Writes happen immediately, with no confirmation or dry-run. Flags come **before** the positional `<id>`.
- More nouns may gain writes over time. When one does, update the root help list.

## Help text is documentation

`--help` text is a domain-teaching document written in `CONTEXT.md` terms. **Keep it in sync with `CONTEXT.md` by hand**: when vocabulary or entity fields change there, update the matching `commands/<noun>.ts` / `commands/<noun>.help.ts` and the root help in `index.ts`.

## Tests

- The `cli-*.test.ts` files drive the real CLI against a real `apps/remote` over PGlite, using the `cli-*-test-harness.ts` helpers. Run only the file(s) you touched: `pnpm --filter @cvm/local test -- app/cli/<file>.test.ts`.
