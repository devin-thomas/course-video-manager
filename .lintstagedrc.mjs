import { lstatSync } from "node:fs";

/**
 * Prettier every staged file — except symlinks. `.claude/skills/<name>` are
 * symlinks into `.agents/skills/` (the one copy Codex and Claude Code share),
 * and prettier refuses an explicitly named symlink outright, which failed the
 * whole commit. The files they point at are staged and formatted on their own.
 */
const isSymlink = (file) => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

export default {
  "*": (files) => {
    const formattable = files.filter((file) => !isSymlink(file));
    if (formattable.length === 0) return [];
    const quoted = formattable.map((file) => JSON.stringify(file)).join(" ");
    return `prettier --ignore-unknown --write ${quoted}`;
  },
};
