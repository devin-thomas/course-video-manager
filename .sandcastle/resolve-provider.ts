import * as sandcastle from "@ai-hero/sandcastle";
import type { AgentProvider } from "@ai-hero/sandcastle";
import { SANDCASTLE_PROVIDERS, type SandcastleConfig } from "./resolve-config";
import { AntigravityProvider } from "./providers/antigravity";

/**
 * Map a resolved {@link SandcastleConfig} to a Sandcastle `AgentProvider`
 * instance for the four launch vendors (ADR 0030).
 *
 * Credential env vars are passed through per-vendor when present in the
 * environment — this function does no credential management of its own. A
 * vendor that needs no explicit credential here (Codex, Antigravity) relies
 * on its native credential store on the runner instead.
 */
export function resolveProvider(config: SandcastleConfig): AgentProvider {
  const { provider, model } = config;

  switch (provider) {
    case "claude-code":
      return sandcastle.claudeCode(model, {
        env: credentialEnv("CLAUDE_CODE_OAUTH_TOKEN"),
      });
    case "codex":
      return sandcastle.codex(model, { env: {} });
    case "cursor":
      return sandcastle.cursor(model, {
        env: credentialEnv("CURSOR_API_KEY"),
      });
    case "antigravity":
      return new AntigravityProvider(model, { env: {} });
    default:
      throw new Error(
        `Unknown Sandcastle provider "${provider as string}". Valid providers: ${SANDCASTLE_PROVIDERS.join(", ")}.`
      );
  }
}

/** Passes a credential env var through only when it's actually set. */
function credentialEnv(varName: string): Record<string, string> {
  const value = process.env[varName];
  return value ? { [varName]: value } : {};
}
