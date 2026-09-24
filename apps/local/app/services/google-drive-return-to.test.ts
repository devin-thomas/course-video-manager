import { describe, expect, it } from "vitest";
import {
  returnToWithError,
  safeReturnTo,
} from "@/services/google-drive-return-to";

describe("safeReturnTo", () => {
  it("keeps a same-origin path with its query", () => {
    expect(safeReturnTo("/courses/x/publish?y=1")).toBe(
      "/courses/x/publish?y=1"
    );
  });

  it.each([
    ["a protocol-relative URL", "//evil.com"],
    ["a backslash the browser turns into //", "/\\evil.com"],
    ["a tab the browser strips", "/\t/evil.com"],
    ["a newline the browser strips", "/\n/evil.com"],
    ["an absolute URL", "https://evil.com"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a relative path", "courses/x"],
    ["nothing", null],
    ["an empty string", ""],
  ])("falls back to / for %s", (_label, value) => {
    expect(safeReturnTo(value)).toBe("/");
  });
});

describe("returnToWithError", () => {
  it("adds the error to a path without a query", () => {
    expect(returnToWithError("/courses/x/publish", "oauth_failed")).toBe(
      "/courses/x/publish?error=oauth_failed"
    );
  });

  it("adds the error to a path that already has a query", () => {
    expect(returnToWithError("/courses/x/publish?y=1", "no_code")).toBe(
      "/courses/x/publish?y=1&error=no_code"
    );
  });

  it("replaces an earlier error rather than stacking another", () => {
    expect(returnToWithError("/p?error=old", "new")).toBe("/p?error=new");
  });

  it("sends an unsafe value home, still carrying the error", () => {
    expect(returnToWithError("//evil.com", "oauth_failed")).toBe(
      "/?error=oauth_failed"
    );
  });
});
