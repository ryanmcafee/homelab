#!/usr/bin/env -S bun test
/**
 * Unit tests for crd-schemas-vendor.ts token discovery and contents-API error
 * reporting: an exhausted rate limit must read as a rate limit, because the
 * manual `task schemas:vendor` path is the one that hits the 60/hour budget.
 *
 *   bun test scripts/crd-schemas-vendor_test.ts
 */

import { test } from "bun:test";
import {
  contentsApiError,
  githubApiHeaders,
  EXIT_FETCH_FAILED,
  exitCodeForErrors,
  SourceFetchError,
  withRetry,
} from "./crd-schemas-vendor.ts";
import { assert, assertEquals, assertStringIncludes } from "./lib/assert.ts";

const RESET = 1_790_000_000;

function response(
  status: number,
  statusText: string,
  rateHeaders: Record<string, string> = {},
) {
  return {
    status,
    statusText,
    headers: { get: (name: string) => rateHeaders[name] ?? null },
  };
}

test("githubApiHeaders authenticates from GITHUB_TOKEN", () => {
  const headers = githubApiHeaders({ GITHUB_TOKEN: "ci-token" });
  assertEquals(headers.Authorization, "Bearer ci-token");
});

test("githubApiHeaders authenticates from GH_TOKEN when GITHUB_TOKEN is unset", () => {
  const headers = githubApiHeaders({ GH_TOKEN: "gh-cli-token" });
  assertEquals(headers.Authorization, "Bearer gh-cli-token");
});

test("githubApiHeaders prefers GITHUB_TOKEN over GH_TOKEN", () => {
  const headers = githubApiHeaders({
    GITHUB_TOKEN: "ci-token",
    GH_TOKEN: "gh-cli-token",
  });
  assertEquals(headers.Authorization, "Bearer ci-token");
});

test("githubApiHeaders treats an empty token as absent", () => {
  const headers = githubApiHeaders({ GITHUB_TOKEN: "", GH_TOKEN: "" });
  assert(
    !("Authorization" in headers),
    "an empty token must not produce an Authorization header",
  );
  assertEquals(headers["User-Agent"], "homelab-crd-schemas-vendor");
});

test("an exhausted unauthenticated budget names the rate limit and the remedy", () => {
  const message = contentsApiError(
    "prometheus-operator-crds",
    "https://api.github.com/repos/x/y/contents/z?ref=v1",
    response(403, "Forbidden", {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "60",
      "x-ratelimit-reset": String(RESET),
    }),
    false,
  );
  assertStringIncludes(message, "schemas-vendor/rate-limit");
  assertStringIncludes(message, "limit 60/hour, 0 remaining");
  assertStringIncludes(message, new Date(RESET * 1000).toISOString());
  assertStringIncludes(message, "GH_TOKEN");
});

test("an exhausted authenticated budget does not advise adding a token", () => {
  const message = contentsApiError(
    "prometheus-operator-crds",
    "https://api.github.com/repos/x/y/contents/z?ref=v1",
    response(403, "Forbidden", {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": String(RESET),
    }),
    true,
  );
  assertStringIncludes(message, "schemas-vendor/rate-limit");
  assertStringIncludes(message, "wait for the reset");
  assert(
    !message.includes("Export GITHUB_TOKEN"),
    "an authenticated 403 must not blame a missing token",
  );
});

test("a 429 with no remaining budget is reported as a rate limit", () => {
  const message = contentsApiError(
    "argo-cd",
    "https://api.github.com/repos/x/y/contents/z?ref=v1",
    response(429, "Too Many Requests", { "x-ratelimit-remaining": "0" }),
    false,
  );
  assertStringIncludes(message, "schemas-vendor/rate-limit");
  assertStringIncludes(message, "resets at unknown");
});

test("a 403 with budget remaining stays a plain contents-API failure", () => {
  const message = contentsApiError(
    "argo-cd",
    "https://api.github.com/repos/x/y/contents/z?ref=v1",
    response(403, "Forbidden", { "x-ratelimit-remaining": "57" }),
    false,
  );
  assertStringIncludes(
    message,
    'GitHub contents API failed for source "argo-cd"',
  );
  assert(
    !message.includes("rate-limit"),
    "a 403 that is not a spent budget must not be reported as one",
  );
});

test("a 404 keeps the plain contents-API failure message", () => {
  const message = contentsApiError(
    "argo-cd",
    "https://api.github.com/repos/x/y/contents/z?ref=v1",
    response(404, "Not Found"),
    true,
  );
  assertStringIncludes(message, "404 Not Found");
  assert(
    !message.includes("rate-limit"),
    "a missing path must not be reported as a rate limit",
  );
});

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
