import * as fs from "node:fs";
import * as path from "node:path";

/** A Sandcastle agent runner vendor. See ADR 0030. */
export type SandcastleProvider =
  "claude-code" | "codex" | "cursor" | "antigravity";

export const SANDCASTLE_PROVIDERS: readonly SandcastleProvider[] = [
  "claude-code",
  "codex",
  "cursor",
  "antigravity",
];

/** Resolved, typed Sandcastle harness config — see {@link resolveConfig}. */
export interface SandcastleConfig {
  readonly provider: SandcastleProvider;
  readonly model: string;
  readonly baseBranch: string;
}

interface SandcastleConfigFile {
  readonly defaultProvider: string;
  readonly defaultModel: string;
  readonly defaultBaseBranch: string;
}

/**
 * Resolve the Sandcastle harness config: read `.sandcastle/config.json`, then
 * apply the `SANDCASTLE_PROVIDER` / `SANDCASTLE_MODEL` env var overrides when
 * set. `defaultBaseBranch` has no env override — a job script that needs a
 * different base branch passes one explicitly.
 *
 * Throws if the resolved provider (file value or env override) isn't one of
 * {@link SANDCASTLE_PROVIDERS}.
 */
export function resolveConfig(): SandcastleConfig {
  const configPath = path.join(import.meta.dirname, "config.json");
  const file = JSON.parse(
    fs.readFileSync(configPath, "utf8")
  ) as SandcastleConfigFile;

  const provider = process.env.SANDCASTLE_PROVIDER ?? file.defaultProvider;
  if (!isSandcastleProvider(provider)) {
    throw new Error(
      `Unknown Sandcastle provider "${provider}". Valid providers: ${SANDCASTLE_PROVIDERS.join(", ")}.`
    );
  }

  return {
    provider,
    model: process.env.SANDCASTLE_MODEL ?? file.defaultModel,
    baseBranch: file.defaultBaseBranch,
  };
}

function isSandcastleProvider(value: string): value is SandcastleProvider {
  return (SANDCASTLE_PROVIDERS as readonly string[]).includes(value);
}
