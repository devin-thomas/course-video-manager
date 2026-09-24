# Multi-Vendor Sandcastle — Requirements Spec

> **What this is.** Requirements for making the AFK agent platform vendor-neutral.
> The platform spec (`afk-agent-platform-spec.md`) remains the source of truth for
> orchestration, the label state machine, and the Agent-Runner Contract. This document
> specifies only what changes to support multiple vendors.
>
> **Decision record:** [ADR 0030](../adr/0030-multi-vendor-sandcastle.md).
> **Scope:** AFK layer only (`.sandcastle/` job scripts, `.github/workflows/agent-*.yml`,
> `main.ts`). Interactive skill portability is a separate project.

---

## 1. Supported vendors

| Vendor             | CLI                  | Headless flag | Stream format                          | Session resume        | Structured output        |
| ------------------ | -------------------- | ------------- | -------------------------------------- | --------------------- | ------------------------ |
| Claude Code        | `claude`             | `-p`          | `stream-json` (NDJSON)                 | `--resume <id>`       | `--json-schema`          |
| OpenAI Codex       | `codex`              | `exec`        | `--json` (JSONL)                       | `resume <id>`         | `--output-schema`        |
| Google Antigravity | `agy`                | `-p`          | `--output-format stream-json` (NDJSON) | `--conversation <id>` | `--json-schema`          |
| Cursor             | `cursor` SDK (local) | Programmatic  | Typed `SDKMessage` events              | `Agent.resume(id)`    | None (harness validates) |

All four are coding agents with tool use, file editing, shell access, and GitHub interaction
(via `gh`). Every vendor can execute every AFK job.

---

## 2. Configuration

### 2.1 Config file

`.sandcastle/config.json` — colocated with the job scripts it configures.

```json
{
  "defaultProvider": "claude-code",
  "defaultModel": "claude-opus-5",
  "defaultBaseBranch": "main"
}
```

**Fields:**

| Field               | Type     | Default           | Description                                                                          |
| ------------------- | -------- | ----------------- | ------------------------------------------------------------------------------------ |
| `defaultProvider`   | `string` | `"claude-code"`   | One of `claude-code`, `codex`, `antigravity`, `cursor`.                              |
| `defaultModel`      | `string` | `"claude-opus-5"` | Model identifier passed to the provider factory.                                     |
| `defaultBaseBranch` | `string` | `"main"`          | Base branch for all workflows. Replaces the hardcoded `main` in every `agent-*.yml`. |

### 2.2 Per-run overrides

| Env var               | Overrides         |
| --------------------- | ----------------- |
| `SANDCASTLE_PROVIDER` | `defaultProvider` |
| `SANDCASTLE_MODEL`    | `defaultModel`    |

These are set by the caller (a human running locally, or a workflow input).

### 2.3 Resolution order

1. Environment variable (highest priority).
2. `.sandcastle/config.json`.
3. Built-in defaults (`claude-code`, `claude-opus-5`, `main`).

A `resolveConfig()` function reads the file once and merges overrides. Every job
script and workflow calls it instead of hardcoding a provider.

---

## 3. Provider resolution

A `resolveProvider(config)` function maps the provider name + model to a Sandcastle
`AgentProvider` instance:

```
claude-code  → sandcastle.claudeCode(model, { env })
codex        → sandcastle.codex(model, { env })
cursor       → sandcastle.cursor(model, { env })
antigravity  → new AntigravityProvider(model, { env })
```

The Antigravity provider is custom (see §7). The other three use `@ai-hero/sandcastle`'s
built-in factories.

### 3.1 Credential injection

Each provider's `env` is populated from the environment, using the vendor's native
credential variable. The harness does **not** manage credentials — it passes through
whatever the environment provides:

| Provider      | Credential env var(s)      | Native store fallback         |
| ------------- | -------------------------- | ----------------------------- |
| `claude-code` | `CLAUDE_CODE_OAUTH_TOKEN`  | `~/.claude/.credentials.json` |
| `codex`       | (none needed if logged in) | `~/.codex/auth.json`          |
| `antigravity` | (none needed if logged in) | OS keychain                   |
| `cursor`      | `CURSOR_API_KEY`           | Dashboard-generated key       |

The harness tries the vendor's native credential store first (the CLI finds its own
auth). Environment variables are the fallback, used primarily in CI.

---

## 4. Commit identity

Each vendor gets a deterministic git identity. The harness sets `user.name` and
`user.email` before the agent runs, based on the resolved provider:

| Provider      | `user.name`        | `user.email`                                |
| ------------- | ------------------ | ------------------------------------------- |
| `claude-code` | `claude-code[bot]` | `claude-code[bot]@users.noreply.github.com` |
| `codex`       | `codex[bot]`       | `codex[bot]@users.noreply.github.com`       |
| `antigravity` | `agy[bot]`         | `agy[bot]@users.noreply.github.com`         |
| `cursor`      | `cursor[bot]`      | `cursor[bot]@users.noreply.github.com`      |

The `Co-Authored-By` trailer carries the model name.

---

## 5. Vendor-neutral prompts

### 5.1 Format

All `.sandcastle/<job>/prompt.md` files converge on the `{{VAR}}` placeholder format
already used by the genericised skeletons in `docs/agents/prompts/`.

Vendor-specific constructs are removed:

| Remove                                                  | Replace with                                          |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `` !`gh issue view $N` `` (Claude command substitution) | `{{ISSUE_BODY}}` — harness fetches and injects        |
| `/code-review` (Claude Code skill reference)            | Inline instructions describing the review methodology |
| `RALPH:` commit prefix                                  | Conventional commits (no vendor-branded prefix)       |
| `PR_COMMENTS_JSON` embedded in prompt                   | `{{PR_COMMENTS_JSON}}` — harness fetches and injects  |

### 5.2 Variable population

The harness (the runner script in each workflow) fetches context and populates variables
**before** handing the prompt to the vendor. This is already partially done (e.g. the
review workflow fetches PR comments via GraphQL). The change is to make it complete — no
prompt should require the agent to run `gh` to fetch its own inputs.

In local mode, this constraint is relaxed: agents can call `gh` directly if needed.

---

## 6. Harness contract extensions

These extend the Agent-Runner Contract (platform spec §3.8) for multi-vendor support.

### 6.1 Harness-side schema validation

The harness validates all structured output against the expected Zod schema, regardless
of whether the vendor enforced a schema natively. The validation pipeline:

1. The agent produces output (text containing the structured data).
2. The harness extracts the structured block (by tag or by parsing the final message).
3. The harness validates against the Zod schema.
4. On validation failure: if session resume is available, resume with feedback describing
   the error (the existing `runWithRetry` / `runWithExtraction` pattern). If resume is
   unavailable, write `failure_reason.txt` and fail.

### 6.2 Triple-check verdict

Every run's success is determined by three signals:

| Signal              | Source                                    | Example                                           |
| ------------------- | ----------------------------------------- | ------------------------------------------------- |
| **Exit code**       | Process exit status                       | `0` = success (but not sufficient alone)          |
| **Output validity** | Harness schema validation                 | Structured output present and valid               |
| **Ground truth**    | Assertions on the working tree or tracker | `git rev-list --count main..HEAD > 0` (implement) |

A run passes only when all applicable signals agree. Jobs that don't produce structured
output (e.g. `implement`) skip the output-validity check but still require exit code +
ground truth.

**Antigravity-specific:** The harness must check for `denied_actions` in the JSON output
and treat any soft-denied tool as a failure, regardless of exit code.

### 6.3 Session resume across vendors

The two-pass extraction pattern (`runWithExtraction`) requires resuming the same session.
Each vendor has a different resume mechanism:

| Provider      | Session ID source                  | Resume flag           |
| ------------- | ---------------------------------- | --------------------- |
| `claude-code` | `.session_id` from JSON output     | `--resume <id>`       |
| `codex`       | `thread.started` event             | `resume <id>`         |
| `antigravity` | `conversation_id` from JSON output | `--conversation <id>` |
| `cursor`      | Agent ID from `Agent.create()`     | `Agent.resume(id)`    |

The `runWithExtraction` wrapper abstracts this: it captures the session ID from the
produce pass and passes it to the extract pass. The `AgentProvider` interface already
supports this via `sessionStorage` / `captureSessions` — extend it for Antigravity.

---

## 7. Antigravity `AgentProvider`

A custom implementation of `@ai-hero/sandcastle`'s `AgentProvider` interface for the
`agy` CLI.

### 7.1 Interface members

| Member                       | Implementation                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `name`                       | `"antigravity"`                                                                                |
| `env`                        | Passed through from config; no credential env var needed for subscription auth                 |
| `captureSessions`            | `true`                                                                                         |
| `sessionStorage`             | Read `conversation_id` from the `result` event in stream output                                |
| `buildPrintCommand(opts)`    | `agy -p "<prompt>" --output-format stream-json --json-schema '<schema>' [--conversation <id>]` |
| `parseStreamLine(line)`      | Parse NDJSON: `init` → session start, `step_update` → progress, `result` → completion          |
| `parseSessionUsage(content)` | Extract token counts from the `result` event's `usage` field                                   |

### 7.2 Soft-deny handling

The provider's `parseStreamLine` checks every `result` event for a `denied_actions`
field. If present, it emits a synthetic error event so the harness treats the run as
failed rather than successful.

### 7.3 Contribution

Build in-repo first (e.g. `.sandcastle/providers/antigravity.ts`). Upstream contribution
to `@ai-hero/sandcastle` is a stretch goal, not a blocker.

---

## 8. Workflow changes

### 8.1 CLI installation

Each workflow's "install the agent runner" step becomes provider-aware:

| Provider      | Install command                                                     |
| ------------- | ------------------------------------------------------------------- |
| `claude-code` | `npm install -g @anthropic-ai/claude-code`                          |
| `codex`       | `npm install -g @openai/codex`                                      |
| `antigravity` | Platform-specific installer (`curl` on Mac/Linux, `irm` on Windows) |
| `cursor`      | `npm install @cursor/sdk` (project-level, not global)               |

The workflow reads `defaultProvider` from config (or the `SANDCASTLE_PROVIDER` input)
and runs the matching install step.

### 8.2 Credential secrets

Each workflow passes the vendor-appropriate secret:

| Provider      | Secret name                         |
| ------------- | ----------------------------------- |
| `claude-code` | `CLAUDE_CODE_OAUTH_TOKEN`           |
| `codex`       | (native auth on self-hosted runner) |
| `antigravity` | (native auth on self-hosted runner) |
| `cursor`      | `CURSOR_API_KEY`                    |

On a self-hosted runner with all CLIs authenticated, only Claude Code and Cursor need
explicit secrets. Codex and Antigravity use their locally cached credentials.

### 8.3 Git identity

The `git config user.name / user.email` step reads the provider and sets the
corresponding identity from the table in §4.

### 8.4 Base branch

Every reference to `main` in workflow YAML becomes a reference to `defaultBaseBranch`
from config. The workflows read this value in a setup step and export it as a job-level
environment variable.

### 8.5 Self-hosted runner

Workflows that invoke the agent runner target a self-hosted runner label (e.g.
`runs-on: self-hosted`). The runner host has all four vendor CLIs installed and
authenticated via their subscription credentials.

---

## 9. `main.ts` conversion

The `main.ts` RALPH loop is converted to use the config system:

1. Replace every `sandcastle.claudeCode("claude-opus-5")` call with
   `resolveProvider(config)`.
2. Remove any reference to `ANTHROPIC_API_KEY` — the harness must never silently use a
   metered credential.
3. The Docker sandbox and the RALPH orchestration pattern are unchanged.

---

## 10. Files changed

A summary of every file that changes, grouped by concern.

### Config system (new)

| File                              | Change                                                  |
| --------------------------------- | ------------------------------------------------------- |
| `.sandcastle/config.json`         | **New.** Default provider, model, base branch.          |
| `.sandcastle/resolve-config.ts`   | **New.** Reads config, merges env overrides.            |
| `.sandcastle/resolve-provider.ts` | **New.** Maps provider name → `AgentProvider` instance. |

### Antigravity provider (new)

| File                                   | Change                              |
| -------------------------------------- | ----------------------------------- |
| `.sandcastle/providers/antigravity.ts` | **New.** `AgentProvider` for `agy`. |

### Job scripts (modify)

| File                                                     | Change                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `.sandcastle/main.ts`                                    | Replace `claudeCode()` with `resolveProvider()`. Remove `ANTHROPIC_API_KEY`. |
| `.sandcastle/implement/implement.ts`                     | Replace `claudeCode()` with `resolveProvider()`.                             |
| `.sandcastle/implement-prd/implement-prd.ts`             | Same.                                                                        |
| `.sandcastle/implement-pr/implement-pr.ts`               | Same.                                                                        |
| `.sandcastle/review/review.ts`                           | Same.                                                                        |
| `.sandcastle/to-issues-prd/to-issues-prd.ts`             | Same.                                                                        |
| `.sandcastle/write-pr/write-pr.ts`                       | Same.                                                                        |
| `.sandcastle/write-prd-pr/write-prd-pr.ts`               | Same.                                                                        |
| `.sandcastle/update-branch/update-branch.ts`             | Same.                                                                        |
| `.sandcastle/architecture-review/architecture-review.ts` | Same.                                                                        |

### Harness wrappers (modify)

| File                                 | Change                                                           |
| ------------------------------------ | ---------------------------------------------------------------- |
| `.sandcastle/run-with-retry.ts`      | Add harness-side schema validation. Abstract session ID capture. |
| `.sandcastle/run-with-extraction.ts` | Same. Add soft-deny detection for Antigravity.                   |

### Prompts (modify)

| File                                          | Change                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `.sandcastle/*/prompt.md` (all 10)            | Replace `` !`cmd` `` substitutions with `{{VAR}}` placeholders. Remove skill references. Drop `RALPH:` prefix. |
| `.sandcastle/*/extraction.md` (where present) | Same placeholder conversion.                                                                                   |

### Workflows (modify)

| File                                         | Change                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `.github/workflows/agent-implement.yml`      | Provider-aware install, credential, identity, base-branch. Self-hosted runner. |
| `.github/workflows/agent-implement-prd.yml`  | Same.                                                                          |
| `.github/workflows/agent-implement-pr.yml`   | Same.                                                                          |
| `.github/workflows/agent-review.yml`         | Same. Remove `-a claude-code` skill install.                                   |
| `.github/workflows/agent-update-branch.yml`  | Same.                                                                          |
| `.github/workflows/agent-to-issues-prd.yml`  | Same.                                                                          |
| `.github/workflows/agent-promote-queued.yml` | Base-branch only (no agent runner).                                            |

### Domain vocabulary (modify)

| File         | Change                                                             |
| ------------ | ------------------------------------------------------------------ |
| `CONTEXT.md` | Add Agent Runner, Agent Provider, Vendor, Run Verdict definitions. |

### Decision record (new)

| File                                       | Change                                      |
| ------------------------------------------ | ------------------------------------------- |
| `docs/adr/0030-multi-vendor-sandcastle.md` | **New.** Records the multi-vendor decision. |

### Dockerfile (modify)

| File                     | Change                                                    |
| ------------------------ | --------------------------------------------------------- |
| `.sandcastle/Dockerfile` | Install all four vendor CLIs instead of only Claude Code. |

---

## 11. Out of scope

- **Interactive skill portability.** Making Claude Code skills (`execute-task`, `do-work`,
  etc.) work across vendors is a separate project.
- **Vendor-native CI actions.** Using `anthropics/claude-code-action` or
  `openai/codex-action` directly. The self-hosted runner approach renders these
  unnecessary — the harness invokes the CLI itself.
- **Automatic quota-based vendor switching.** No vendor exposes quota reliably enough to
  automate failover. The owner switches manually via env var override.
- **Per-job vendor assignments.** The config sets one default; per-run override is
  sufficient. Per-job config can be added later if needed.
