---
name: install-effect-package
description: Install @effect/* packages safely. Use whenever adding a new Effect ecosystem dependency.
user-invocable: false
---

## Installing Effect Ecosystem Packages

This repo uses **pnpm**. To add any `@effect/*` package:

```bash
pnpm add @effect/package-name
```

pnpm resolves peer dependencies without rewriting the rest of the lockfile, so it
does not suffer from the npm failure mode this skill originally guarded against
(npm's `--legacy-peer-deps` silently stripping existing `@effect/*` peers such as
`@effect/rpc`, `@effect/sql`, `@effect/experimental` and corrupting the lockfile).

If a new `@effect/*` package reports a peer-dependency conflict, install the
matching peer versions explicitly rather than forcing the tree — check
`pnpm why <package>` to see what is already resolved before adding.
