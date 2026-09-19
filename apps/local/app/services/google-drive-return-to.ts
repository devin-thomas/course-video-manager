/**
 * Where to land after the OAuth round trip. Only a same-origin path is
 * honoured, so the `state` Google echoes back cannot redirect off-site.
 */
export const safeReturnTo = (value: string | null | undefined) =>
  value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
