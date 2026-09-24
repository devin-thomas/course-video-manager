import { describe, it, expect, afterEach } from "vitest";
import { resolveProvider } from "./resolve-provider";
import type { SandcastleConfig } from "./resolve-config";

function config(overrides: Partial<SandcastleConfig> = {}): SandcastleConfig {
  return {
    provider: "claude-code",
    model: "claude-opus-5",
    baseBranch: "main",
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CURSOR_API_KEY;
});

describe("resolveProvider", () => {
  it("returns a claude-code AgentProvider for the claude-code config", () => {
    const provider = resolveProvider(config({ provider: "claude-code" }));

    expect(provider.name).toBe("claude-code");
  });

  it("returns a codex AgentProvider for the codex config", () => {
    const provider = resolveProvider(config({ provider: "codex" }));

    expect(provider.name).toBe("codex");
  });

  it("returns a cursor AgentProvider for the cursor config", () => {
    const provider = resolveProvider(config({ provider: "cursor" }));

    expect(provider.name).toBe("cursor");
  });

  it("returns an antigravity AgentProvider for the antigravity config", () => {
    const provider = resolveProvider(config({ provider: "antigravity" }));

    expect(provider.name).toBe("antigravity");
  });

  it("throws naming the valid providers for an unrecognized provider", () => {
    const bogus = config({
      provider: "bogus" as unknown as SandcastleConfig["provider"],
    });

    expect(() => resolveProvider(bogus)).toThrow(
      /Unknown Sandcastle provider "bogus".*claude-code, codex, cursor, antigravity/
    );
  });

  it("passes CLAUDE_CODE_OAUTH_TOKEN through when set", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";

    const provider = resolveProvider(config({ provider: "claude-code" }));

    expect(provider.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "test-token" });
  });

  it("omits CLAUDE_CODE_OAUTH_TOKEN from env when unset", () => {
    const provider = resolveProvider(config({ provider: "claude-code" }));

    expect(provider.env).toEqual({});
  });

  it("passes CURSOR_API_KEY through when set", () => {
    process.env.CURSOR_API_KEY = "test-key";

    const provider = resolveProvider(config({ provider: "cursor" }));

    expect(provider.env).toEqual({ CURSOR_API_KEY: "test-key" });
  });
});
