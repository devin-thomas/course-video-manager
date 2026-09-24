const BASE = "http://localhost";

/** Whitespace (tab, newline, space, ...) or an ASCII control character. */
const hasWhitespaceOrControl = (value: string) =>
  /\s/.test(value) ||
  Array.from(value).some(
    (c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f
  );

/**
 * Where to land after the OAuth round trip. Only a same-origin path is
 * honoured, so neither the `returnTo` a link carries nor the `state` Google
 * echoes back can redirect off-site.
 *
 * A browser normalises `/\evil.com` to `//evil.com` and strips tabs and
 * newlines from URLs, so a plain "starts with one slash" test is not enough:
 * the value must start with exactly one `/`, contain no whitespace or control
 * characters, and still resolve against this origin.
 */
export const safeReturnTo = (value: string | null | undefined): string => {
  if (!value || !value.startsWith("/")) return "/";
  if (value[1] === "/" || value[1] === "\\") return "/";
  // Whitespace (including tab/newline) and control characters.
  if (hasWhitespaceOrControl(value)) return "/";
  let resolved: URL;
  try {
    resolved = new URL(value, BASE);
  } catch {
    return "/";
  }
  if (resolved.origin !== BASE) return "/";
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
};

/** A safe return path with `error` set, keeping any query it already has. */
export const returnToWithError = (
  value: string | null | undefined,
  error: string
): string => {
  const resolved = new URL(safeReturnTo(value), BASE);
  resolved.searchParams.set("error", error);
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
};
