/**
 * Assertion helpers for the script unit tests (`bun test scripts`).
 *
 * assertEquals is a deep strict comparison (node:assert deepStrictEqual);
 * assertThrows / assertRejects return the error so a test can inspect it and,
 * given a class and a substring, check both.
 */

import { deepStrictEqual } from "node:assert/strict";

export class AssertionError extends Error {
  override name = "AssertionError";
}

export function assert(
  cond: unknown,
  msg = "Expected condition to be truthy",
): asserts cond {
  if (!cond) throw new AssertionError(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  try {
    deepStrictEqual(actual, expected);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new AssertionError(msg ? `${msg}\n${detail}` : detail);
  }
}

export function assertStringIncludes(
  actual: string,
  expected: string,
  msg?: string,
): void {
  if (!actual.includes(expected)) {
    throw new AssertionError(
      msg ?? `Expected actual: "${actual}" to contain: "${expected}".`,
    );
  }
}

type ErrorClass = abstract new (...args: never[]) => Error;

function checkError(
  err: unknown,
  ErrorClass?: ErrorClass,
  msgIncludes?: string,
  msg?: string,
): Error {
  if (!(err instanceof Error)) {
    throw new AssertionError(msg ?? "A non-Error object was thrown.");
  }
  const actualName = err.constructor.name;
  if (ErrorClass && !(err instanceof ErrorClass)) {
    throw new AssertionError(
      msg ??
        `Expected error to be instance of "${ErrorClass.name}", but was "${actualName}".`,
    );
  }
  if (msgIncludes !== undefined && !err.message.includes(msgIncludes)) {
    throw new AssertionError(
      msg ??
        `Expected error message to include "${msgIncludes}", but got "${err.message}".`,
    );
  }
  return err;
}

export function assertThrows(
  fn: () => unknown,
  ErrorClass?: ErrorClass,
  msgIncludes?: string,
  msg?: string,
): Error {
  try {
    fn();
  } catch (e) {
    return checkError(e, ErrorClass, msgIncludes, msg);
  }
  throw new AssertionError(msg ?? "Expected function to throw.");
}

export async function assertRejects(
  fn: () => PromiseLike<unknown>,
  ErrorClass?: ErrorClass,
  msgIncludes?: string,
  msg?: string,
): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return checkError(e, ErrorClass, msgIncludes, msg);
  }
  throw new AssertionError(msg ?? "Expected function to reject.");
}
