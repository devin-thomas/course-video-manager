#!/usr/bin/env node
/**
 * PreToolUse hook shared by Claude Code (.claude/settings.json) and Codex
 * (.codex/hooks.json): refuse a shell command that runs `npx tsc`, and point
 * at `pnpm run typecheck` instead.
 *
 * Both tools pipe the same JSON shape to stdin — `tool_input.command` holds the
 * shell command — and both treat exit code 2 as "block, and show stderr to the
 * model". Only a command that IS `npx tsc` is blocked: `npx` must be the first
 * word of the first line, so "npx tsc" quoted inside, say, a commit message
 * passes.
 *
 * Plain Node with no dependencies, so it runs the same on Windows, macOS and
 * Linux without jq or a POSIX shell.
 */

const MESSAGE = "Use `pnpm run typecheck` instead of `npx tsc`";

/** The command a PreToolUse payload would run, or "" if it carries none. */
const commandOf = (payload) => {
  const command = payload?.tool_input?.command;
  if (Array.isArray(command)) return command.join(" ");
  return typeof command === "string" ? command : "";
};

const isBareNpxTsc = (command) => {
  const firstLine = command.trimStart().split(/\r?\n/, 1)[0] ?? "";
  return /^npx\s+tsc(\s|$)/.test(firstLine);
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return 0; // Not a payload we understand: never block on our own failure.
  }
  if (!isBareNpxTsc(commandOf(payload))) return 0;
  process.stderr.write(`${MESSAGE}\n`);
  return 2;
};

process.exitCode = await main();
