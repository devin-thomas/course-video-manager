import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The PreToolUse hook Claude Code and Codex both run, driven exactly as they
 * drive it: a JSON payload on stdin, and exit code 2 plus stderr to block.
 */
const HOOK = join(
  import.meta.dirname,
  "..",
  "scripts",
  "agent-hooks",
  "block-npx-tsc.mjs"
);

const runHook = (stdin: string) =>
  spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8" });

const bashCall = (command: unknown) =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command } });

describe("block-npx-tsc hook", () => {
  it.each(["npx tsc", "npx tsc --noEmit", "  npx   tsc -p tsconfig.json"])(
    "blocks %j and points at pnpm run typecheck",
    (command) => {
      const result = runHook(bashCall(command));

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("pnpm run typecheck");
    }
  );

  it("blocks Codex's argv-array form of the command", () => {
    expect(runHook(bashCall(["npx", "tsc", "--noEmit"])).status).toBe(2);
  });

  it.each([
    "pnpm run typecheck",
    "npx tsx scripts/thing.ts",
    "npx tscx",
    'git commit -m "stop running npx tsc"',
    "echo hi\nnpx tsc",
  ])("allows %j", (command) => {
    const result = runHook(bashCall(command));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("allows a payload with no command, or no JSON at all", () => {
    expect(runHook(JSON.stringify({ tool_name: "Read" })).status).toBe(0);
    expect(runHook("not json").status).toBe(0);
  });
});
