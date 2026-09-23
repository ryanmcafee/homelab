/**
 * Predicates over the `code` that node:fs, node:net and Bun.spawn attach to
 * system errors, so callers can tell "missing" from "failed" without string
 * matching on messages.
 */

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === code
  );
}

/** A file, directory or executable does not exist (ENOENT). */
export function isNotFound(err: unknown): boolean {
  return hasCode(err, "ENOENT");
}

/** The path already exists (EEXIST). */
export function isAlreadyExists(err: unknown): boolean {
  return hasCode(err, "EEXIST");
}

/** The operation is not permitted (EACCES or EPERM). */
export function isPermissionDenied(err: unknown): boolean {
  return hasCode(err, "EACCES") || hasCode(err, "EPERM");
}

/** The address or port is already bound (EADDRINUSE). */
export function isAddrInUse(err: unknown): boolean {
  return hasCode(err, "EADDRINUSE");
}

/** An Error carrying a system error code, for fakes that stand in for node:fs. */
export function systemError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}
