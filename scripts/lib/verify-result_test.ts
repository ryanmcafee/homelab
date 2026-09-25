#!/usr/bin/env -S bun test
/**
 * Unit tests for scripts/lib/verify-result.ts.
 *
 *   bun test scripts/lib/verify-result_test.ts
 */

import { test } from "bun:test";
import { assertEquals, assertThrows } from "./assert.ts";
import {
  extractJsonObject,
  parseVerifyResult,
  type VerifyResult,
} from "./verify-result.ts";

// Shaped like `homelab verify all --level 0 --json` (internal/verify/types.go).
const RESULT: VerifyResult = {
  level: 0,
  checks: [
    { name: "render/homelab/addons", status: "pass", duration_ms: 120 },
    {
      name: "gitops/localdev/ssa",
      status: "skip",
      duration_ms: 1,
      detail: "no huge-CRD charts",
    },
    { name: "pluto/homelab", status: "pass", duration_ms: 40 },
  ],
  pass: true,
  duration_ms: 2900,
};

const FAILING: VerifyResult = {
  level: 0,
  checks: [
    { name: "render/homelab/addons", status: "pass" },
    {
      name: "snapshot/homelab/addons",
      status: "fail",
      detail: "rendered output differs",
      findings: ["@@ -1 +1 @@", "-a", "+b"],
    },
  ],
  pass: false,
};

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------
test("extractJsonObject: strips task's trailing failure line", () => {
  const raw =
    JSON.stringify(FAILING, null, 2) +
    '\ntask: Failed to run task "verify": exit status 1\n';
  assertEquals(JSON.parse(extractJsonObject(raw)), FAILING);
});

test("extractJsonObject: single-line object and leading noise", () => {
  const raw = "go: downloading x\n" + JSON.stringify(RESULT) + "\n";
  assertEquals(JSON.parse(extractJsonObject(raw)), RESULT);
});

test("parseVerifyResult: accepts the contract and keeps detail/findings", () => {
  const r = parseVerifyResult(JSON.stringify(FAILING, null, 2));
  assertEquals(r.pass, false);
  assertEquals(r.checks[1].findings, ["@@ -1 +1 @@", "-a", "+b"]);
});

test("parseVerifyResult: rejects empty input, non-JSON and wrong shapes", () => {
  assertThrows(() => parseVerifyResult(""), Error, "no JSON object");
  // `task verify` when the Go build itself failed: only task's error line.
  assertThrows(
    () =>
      parseVerifyResult('task: Failed to run task "verify": exit status 1\n'),
    Error,
    "no JSON object",
  );
  assertThrows(() => parseVerifyResult("{nope"), Error, "not JSON");
  assertThrows(
    () => parseVerifyResult('{"level":0,"pass":true}'),
    Error,
    "`checks`",
  );
  assertThrows(
    () =>
      parseVerifyResult(
        '{"level":0,"pass":true,"checks":[{"name":"a","status":"ok"}]}',
      ),
    Error,
    "status",
  );
});
