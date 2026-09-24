import { describe, it, expect, afterEach } from "vitest";
import { resolveConfig } from "./resolve-config";

afterEach(() => {
  delete process.env.SANDCASTLE_PROVIDER;
  delete process.env.SANDCASTLE_MODEL;
});

describe("resolveConfig", () => {
  it("reads the defaults from config.json when no env overrides are set", () => {
    const config = resolveConfig();

    expect(config).toEqual({
      provider: "claude-code",
      model: "claude-opus-5",
      baseBranch: "main",
    });
  });

  it("overrides the provider from SANDCASTLE_PROVIDER", () => {
    process.env.SANDCASTLE_PROVIDER = "codex";

    expect(resolveConfig().provider).toBe("codex");
  });

  it("overrides the model from SANDCASTLE_MODEL", () => {
    process.env.SANDCASTLE_MODEL = "gpt-5-codex";

    expect(resolveConfig().model).toBe("gpt-5-codex");
  });

  it("throws naming the valid providers when SANDCASTLE_PROVIDER is unrecognized", () => {
    process.env.SANDCASTLE_PROVIDER = "gpt-5";

    expect(() => resolveConfig()).toThrow(
      /Unknown Sandcastle provider "gpt-5".*claude-code, codex, cursor, antigravity/
    );
  });
});
