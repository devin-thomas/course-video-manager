---
name: do-work
description: "End-to-end implementation workflow. Use when user wants to implement a feature, fix a bug, or make changes and have everything validated and committed."
---

# Do Work

Complete implementation workflow from exploration to commit.

## Workflow

### Phase 1: Explore & Plan

### Phase 2: Implement

If you're touching code that interacts with the database, follow the [DB TDD workflow](DB-TDD.md).

If you're touching frontend code with complex state (creating/modifying reducers, complex state transitions, non-trivial state management), follow the [Frontend TDD workflow](FRONTEND-TDD.md).

### Phase 3: Feedback Loops

Run each check, fix issues, and re-run until clean. Do these sequentially:

1. **Type checking**: `pnpm run typecheck`
2. **Boundaries**: `pnpm run lint:boundaries`
3. **Tests**: only the test file(s) that cover your change — `pnpm --filter <package> test -- path/to/thing.test.ts`. Don't run a package's full suite by hand; CI runs everything (see `docs/agents/testing.md`).

If a check fails, fix the issue and re-run that check before moving to the next one. Do not move on with failing checks.

### Phase 4: Commit
