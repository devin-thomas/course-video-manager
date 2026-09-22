---
status: accepted
---

# The AFK agent platform is vendor-neutral

The Sandcastle AFK agent platform (`.sandcastle/`, `.github/workflows/agent-*.yml`) currently hardcodes Claude Code as the only agent runner. Every script pins `claudeCode("claude-opus-5")`, every workflow installs `@anthropic-ai/claude-code`, passes `CLAUDE_CODE_OAUTH_TOKEN`, and commits as `claude-code[bot]`.

This ADR records the decision to make the platform vendor-neutral so that any supported coding-agent CLI can execute any AFK job.

## Motivation

1. **Portability.** The platform should not be locked to a single vendor. If a vendor's CLI, pricing, or terms change, switching should be a config change, not a rewrite.
2. **Quota management.** The owner may want to draw from different subscription allowances depending on the project or the time of day. A single hardcoded vendor prevents this.

## Decision

The agent runner — the one pluggable pillar described in the [platform spec](../agents/afk-agent-platform-spec.md) §0 — is made genuinely pluggable. Four vendors are supported at launch: Claude Code, OpenAI Codex, Google Antigravity (`agy`), and Cursor.

### Design principles

- **Subscription-only.** Every vendor path uses the owner's existing subscription. No metered API keys are introduced, stored, or required. The harness must never silently incur per-token charges.
- **Egalitarian.** No vendor is treated as second-class. Every vendor can execute every AFK job. Vendor-specific quirks (e.g. exit-code semantics, structured-output support) are handled by the harness, not by limiting which jobs a vendor can run.
- **Harness-side validation.** The harness validates structured output for all vendors rather than trusting vendor-native schema enforcement. This is the only way to guarantee uniform behaviour given that vendors differ in their enforcement reliability.
- **Triple-check verdicts.** A run's success is determined by three signals: exit code, structured-output presence and validity, and ground-truth assertions (e.g. `git rev-list --count` to confirm commits). Exit code alone is never sufficient — some vendors report success even when the work was not done.

### Configuration

A new `.sandcastle/config.json` sets the default vendor, model, and base branch:

```json
{
  "defaultProvider": "claude-code",
  "defaultModel": "claude-opus-5",
  "defaultBaseBranch": "main"
}
```

Per-run overrides use environment variables (`SANDCASTLE_PROVIDER`, `SANDCASTLE_MODEL`).

### Credentials

The harness uses each vendor CLI's native credential store (OAuth tokens, OS keychain, saved login). An environment-variable fallback covers CI and explicit overrides. The harness itself never stores or manages credentials.

### Prompts

All prompts converge on the vendor-neutral `{{VAR}}` placeholder format already used by the genericised skeletons in `docs/agents/prompts/`. Vendor-specific syntax (Claude's `` !`cmd` `` command substitution, skill references) is removed. The harness populates variables before handing the prompt to the vendor.

### Commit identity

Each vendor gets its own git identity (`claude-code[bot]`, `codex[bot]`, `agy[bot]`, `cursor[bot]`), so the provenance of each commit is visible in the history. The `Co-Authored-By` trailer carries the model name for additional detail.

### CI model

A self-hosted runner executes CI workflows using the vendor CLIs installed and authenticated on the host. This is the only way to use subscription auth for vendors that lack a cloud-CI subscription path.

### Local vs CI separation

In CI, the platform spec's invariant holds: the agent writes files, the orchestrator pushes and mutates. Locally, agents use `gh` and `git` directly — the orchestration separation exists to protect shared CI infrastructure, not to add overhead to local runs.

### Antigravity provider

`@ai-hero/sandcastle` ships providers for Claude Code, Codex, and Cursor, but not Antigravity. A custom `AgentProvider` implementation is built as part of this project, implementing the ~5-member interface against the `agy` CLI's headless mode.

### Scope

This decision covers the AFK layer only (`.sandcastle/` job scripts and `.github/workflows/agent-*.yml`). Interactive skill portability (making Claude Code skills like `execute-task` work across vendors) is a separate project.

## Consequences

- Every `.sandcastle/*.ts` script reads the provider from config instead of hardcoding `claudeCode()`.
- Every `agent-*.yml` workflow reads the provider and installs the corresponding CLI.
- The `main.ts` RALPH loop is converted to use the config system.
- Prompts in `.sandcastle/<job>/prompt.md` are converted to the `{{VAR}}` format.
- The `run-with-retry.ts` and `run-with-extraction.ts` wrappers gain harness-side schema validation and vendor-neutral session-resume handling.
