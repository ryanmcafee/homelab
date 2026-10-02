#!/usr/bin/env -S bun test
/**
 * Unit tests for the fetch-failure handling in crd-schemas-vendor.ts.
 *
 *   bun test scripts/crd-schemas-vendor_test.ts
 */

import { test } from "bun:test";
import { assertEquals } from "./lib/assert.ts";
import {
  EXIT_FETCH_FAILED,
  exitCodeForErrors,
  SourceFetchError,
  withRetry,
} from "./crd-schemas-vendor.ts";

const noSleep = async () => {};

test("withRetry: one transient failure is absorbed by the next attempt", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls === 1) throw new Error("read: connection reset by peer");
      return "pulled";
    },
    { attempts: 3, backoffMs: 1, sleep: noSleep },
  );
  assertEquals(result, "pulled");
  assertEquals(calls, 2);
});

test("withRetry: stops after the attempt limit and rethrows the last error", async () => {
  let calls = 0;
  let thrown: unknown;
  try {
    await withRetry(
      async () => {
        calls++;
        throw new Error(`reset ${calls}`);
      },
      { attempts: 3, backoffMs: 1, sleep: noSleep },
    );
  } catch (err) {
    thrown = err;
  }
  assertEquals(calls, 3);
  assertEquals(thrown instanceof Error ? thrown.message : thrown, "reset 3");
});

test("withRetry: backs off linearly between attempts", async () => {
  const slept: number[] = [];
  await withRetry(
    async () => {
      throw new Error("down");
    },
    {
      attempts: 3,
      backoffMs: 100,
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
  ).catch(() => {});
  assertEquals(slept, [100, 200]);
});

test("exitCodeForErrors: a fetch failure is not reported as drift or a generic failure", () => {
  assertEquals(exitCodeForErrors([]), 0);
  assertEquals(exitCodeForErrors([new Error("kind Foo not found")]), 1);
  assertEquals(
    exitCodeForErrors([
      new Error("kind Foo not found"),
      new SourceFetchError("helm pull failed"),
    ]),
    EXIT_FETCH_FAILED,
  );
});
