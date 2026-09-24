# Course Video Manager Task Execution Loop

## Autostart Instruction

When this file is referenced or supplied without additional task text, execute the embedded workflow immediately. Do not ask for a task identifier or provide a plan instead of beginning. Read fresh repository and task-source state, mechanically select or resume one executable task, complete exactly one bounded task pass, record a terminal result, and stop. Ask only when a real ambiguity or required decision cannot be resolved from authoritative sources.

## Prompt

```text
Complete exactly one next executable task for the course-video-manager project.

Repository: the current working directory (devin-thomas/course-video-manager)
Task source of truth: GitHub Issues on devin-thomas/course-video-manager
  Pass -R devin-thomas/course-video-manager to every gh call (the clone also has an upstream remote).
Target branch: create a working branch per issue (see Git section below)

Do not ask for a task identifier. Resolve one task from fresh authoritative state, complete only that task, record the result, and stop.

Before changing anything:

1. Record start-time evidence using OS-native time-zone discovery (Get-TimeZone on Windows, system zone on macOS).
2. Read AGENTS.md completely. Read the sections of CONTEXT.md relevant to the work. Read applicable ADRs in docs/adr/. Read docs/agents/coding-standards.md and docs/agents/testing.md.
3. Run git status. If there are uncommitted changes, stop and report Blocked: dirty worktree.
4. Read open issues from the task source:
   gh issue list -R devin-thomas/course-video-manager --state open --json number,title,labels,body --limit 100
   Retry once on auth or network failure; report Blocked on a second failure.
5. Inspect code, tests, and documentation relevant to candidate work.

Select the task mechanically:

1. Resume: if exactly one open issue is labeled agent:in-progress and is assigned to this agent, resume it.
2. Inconsistent: if more than one issue is agent:in-progress, stop and report Inconsistent: multiple active tasks.
3. Form the executable frontier: open issues that are:
   - labeled Sandcastle (the ready-for-agent triage label), AND
   - NOT labeled agent:in-progress, agent:blocked, agent:queued, or needs-info, AND
   - NOT a sub-issue whose parent PRD is not yet labeled agent:implement, AND
   - have no open native GitHub blockers.
4. Exclude: issues labeled ready-for-human. Issues that are parent PRDs with sub-issues (the agent:implement workflow handles those via the label state machine, not this prompt). Issues labeled agent:to-issues.
5. Order: issues with a critical or security label first, then by declared ordering if in a parent PRD's sub-issue list, then by lowest issue number as tie-breaker.
6. If the frontier is empty, stop and report Empty: no executable tasks.
7. Read the selected issue completely: body, comments, acceptance criteria, blockers, parent PRD if any.
8. Announce the selected task (number and title) and the goal before implementation.

Authority order:

1. The selected task's scope and acceptance criteria.
2. CONTEXT.md domain vocabulary and AGENTS.md boundaries.
3. ADRs in docs/adr/ — do not contradict a recorded decision.
4. docs/agents/coding-standards.md and docs/agents/testing.md.
5. Existing code and tests.

Execution rules:

- Own only the selected task. Implement the smallest complete vertical slice.
- Use the domain vocabulary from CONTEXT.md. Do not use the synonyms it rules out.
- Use Effect primitives where applicable (FileSystem over promises, DI, type-safe errors). Effect must not leak into user-facing API.
- Neither packages/core nor apps/remote may import anything filesystem-bound (fs, path, os, child_process).
- Import deep-module packages only through their entry points (apps/local/app/packages/README.md).
- Typecheck with pnpm run typecheck (never bare npx tsc). Check boundaries with pnpm run lint:boundaries.
- Run only the test file(s) that cover your change: pnpm --filter <package> test -- path/to/file.test.ts. For root .sandcastle/tests files: pnpm run test:root path/to/file.test.ts (no --).
- Never touch .env or files containing real secrets. Add new env keys to .env.example in the same commit.
- Do not implement siblings, successors, speculative features, or unrelated cleanup.

Completion gate:

Mark the task complete only when ALL of the following pass:

1. Acceptance criteria from the issue are met.
2. pnpm run typecheck passes.
3. pnpm run lint:boundaries passes.
4. Targeted tests pass for every changed file. If you wrote new behaviour, a test covers it.
5. The pre-commit hook runs successfully on your commit (it runs prettier, typecheck, lint:boundaries, file-size check, and no-__dirname check).

If required validation fails or is skipped, do not claim success. Record the exact evidence and stop with an Incomplete result. Do not close the issue.

Git and publication:

- If the worktree is dirty before you start, stop immediately (Blocked).
- Create a branch: agent/issue-<number>-<slug> (slug = lowercased title, non-alphanumerics to hyphens, trimmed, max 50 chars). If the branch already exists on the remote, check it out.
- Use Node 22 (the repo's .node-version). If the system default differs, use fnm exec --using=22 for pnpm and git commands.
- Stage only the files you changed (never git add -A or git add .). Inspect staged changes before committing. Check for accidental secrets.
- Commit with a conventional-commit subject. End the message with Co-Authored-By: <the model attribution from your system prompt>.
- Never use --no-verify. Fix whatever the pre-commit hook reports.
- Push to origin. Do not open a PR or merge. Do not push to upstream.
- Close the issue with a comment referencing the commit SHA: gh issue close <N> -R devin-thomas/course-video-manager --comment "Implemented in <sha>."

Protected resources:

- .env, .env.*, credentials.json, auth tokens: never read, print, commit, or log contents.
- .env.example: safe to read and update (it contains variable names, not values).
- E:\dev-data\: local data directory. Do not modify, delete, or reference absolute paths in committed code.
- node_modules/: read type definitions only. Do not modify.

At the end:

1. Capture end-time evidence and compute elapsed time from UTC instants.
2. Close the issue on the task source if the completion gate passed.
3. Report:
   - Task: issue number and title.
   - Execution result: Complete, Incomplete, Blocked, Empty, or Inconsistent.
   - Native state: whether the issue was closed, and the branch/commit.
   - Implemented outcomes: what changed and why.
   - Exact validation: typecheck, lint:boundaries, and test results with pass/fail counts.
   - Commit: subject and SHA.
   - Changed files: list.
   - Task-source updates: issue closed/commented, labels changed.
   - Residual risks or blockers: anything the next task or a human should know.
   - Start time, end time, and elapsed time in the verified time zone.
4. Stop. Do not start another task.
```

## Selection Invariant

No current task identifier is hard-coded in this prompt. Resolve the selected task from fresh authoritative state on every pass, preserve existing work, and stop after one task-level result.
