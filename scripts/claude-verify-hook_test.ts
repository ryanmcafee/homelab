#!/usr/bin/env -S bun test
/**
 * Unit tests for the pure helpers in claude-verify-hook.ts: which edits
 * trigger level 0, the lock (against an in-memory filesystem, so no
 * permissions are needed), and the compact failure summary the agent sees.
 * Nothing here runs go or level 0.
 *
 *   bun test scripts/claude-verify-hook_test.ts
 */

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "./lib/assert.ts";
import { isPermissionDenied, systemError } from "./lib/errors.ts";
import {
  collectEditedPaths,
  fnv1a,
  hintsFor,
  hookDisabled,
  type LockFs,
  normalizePath,
  relativeToRoot,
  releaseLock,
  summarizeFailure,
  tryAcquireLock,
  watchedPaths,
} from "./claude-verify-hook.ts";
import type { VerifyCheck, VerifyResult } from "./lib/verify-result.ts";

const ROOT = "/work/homelab";

// ---------------------------------------------------------------------------
// payload -> paths (shapes from the Claude Code PostToolUse hook input)
// ---------------------------------------------------------------------------
test("collectEditedPaths: Edit, Write, MultiEdit and NotebookEdit payloads", () => {
  assertEquals(
    collectEditedPaths({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: `${ROOT}/charts/addons/values.yaml`,
        old_string: "a",
        new_string: "b",
      },
    }),
    [`${ROOT}/charts/addons/values.yaml`],
  );
  assertEquals(
    collectEditedPaths({
      tool_name: "MultiEdit",
      tool_input: {
        file_path: `${ROOT}/charts/gitops/values.yaml`,
        edits: [
          { old_string: "a", new_string: "b" },
          {
            file_path: `${ROOT}/configuration/versions.yaml`,
          },
        ],
      },
    }),
    [
      `${ROOT}/charts/gitops/values.yaml`,
      `${ROOT}/configuration/versions.yaml`,
    ],
  );
  assertEquals(
    collectEditedPaths({ tool_input: { notebook_path: `${ROOT}/x.ipynb` } }),
    [`${ROOT}/x.ipynb`],
  );
});

test("collectEditedPaths: tolerates junk and deduplicates", () => {
  assertEquals(collectEditedPaths(null), []);
  assertEquals(collectEditedPaths({ tool_input: "nope" }), []);
  assertEquals(
    collectEditedPaths({ tool_input: { file_path: "", edits: [null, 3] } }),
    [],
  );
  assertEquals(
    collectEditedPaths({
      tool_input: { file_path: "a", edits: [{ file_path: "a" }] },
    }),
    ["a"],
  );
});

test("normalizePath and relativeToRoot", () => {
  assertEquals(normalizePath("/a/./b/../c//d/"), "/a/c/d");
  assertEquals(normalizePath("a/../../b"), "../b");
  assertEquals(
    relativeToRoot(`${ROOT}/charts/x.yaml`, ROOT, "/"),
    "charts/x.yaml",
  );
  assertEquals(relativeToRoot("charts/x.yaml", ROOT, ROOT), "charts/x.yaml");
  assertEquals(
    relativeToRoot(`${ROOT}/../other/charts/x.yaml`, ROOT, "/"),
    null,
  );
  // A sibling directory that merely shares the prefix is outside the root.
  assertEquals(
    relativeToRoot(`${ROOT}-issue-261/charts/x.yaml`, ROOT, "/"),
    null,
  );
});

test("watchedPaths: only charts/ and configuration/ of the project root", () => {
  const paths = [
    `${ROOT}/charts/addons/templates/envoy-gateway.yaml`,
    `${ROOT}/configuration/versions.yaml`,
    `${ROOT}/docs/runbooks/verification.md`,
    `${ROOT}/scripts/lib/verify-result.ts`,
    `${ROOT}/chartsy/nope.yaml`,
    "/elsewhere/charts/addons/values.yaml",
  ];
  assertEquals(watchedPaths(paths, ROOT, ROOT), [
    "charts/addons/templates/envoy-gateway.yaml",
    "configuration/versions.yaml",
  ]);
});

test("hookDisabled: off/0/false/no, case-insensitive", () => {
  for (const v of ["off", "OFF", " 0 ", "false", "no"]) {
    assert(hookDisabled(v), v);
  }
  for (const v of [undefined, "", "on", "1", "true"]) {
    assertEquals(hookDisabled(v), false, String(v));
  }
});

// ---------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------
test("fnv1a: stable per root, differs between roots", () => {
  assertEquals(fnv1a(ROOT), fnv1a(ROOT));
  assert(fnv1a(ROOT) !== fnv1a(`${ROOT}-issue-261-cd`));
  assertEquals(fnv1a("").length, 8);
});

// In-memory LockFs: no real filesystem is touched.
function memFs(): LockFs & { files: Map<string, number> } {
  const files = new Map<string, number>();
  let clock = 0;
  return {
    files,
    createNew(path) {
      if (files.has(path)) throw systemError("EEXIST", path);
      files.set(path, clock);
    },
    mtimeMs: (path) => files.get(path) ?? null,
    remove(path) {
      if (!files.delete(path)) throw systemError("ENOENT", path);
    },
    set now(v: number) {
      clock = v;
    },
  } as LockFs & { files: Map<string, number>; now: number };
}

test("tryAcquireLock: exclusive while fresh, replaced when stale, free after release", () => {
  const fs = memFs() as ReturnType<typeof memFs> & { now: number };
  const lock = "/tmp/homelab-verify-hook-x.lock";
  fs.now = 1_000;
  assert(tryAcquireLock(lock, 1_000, 200_000, fs));
  assertEquals(
    tryAcquireLock(lock, 2_000, 200_000, fs),
    false,
    "second run while in flight",
  );
  fs.now = 500_000;
  assert(tryAcquireLock(lock, 500_000, 200_000, fs), "stale lock is replaced");
  assertEquals(fs.files.get(lock), 500_000);
  releaseLock(lock, fs);
  assertEquals(fs.files.has(lock), false);
  assert(tryAcquireLock(lock, 500_001, 200_000, fs));
  releaseLock(lock, fs);
  releaseLock(lock, fs); // idempotent
});

test("tryAcquireLock: other filesystem errors propagate", () => {
  const broken: LockFs = {
    createNew: () => {
      throw systemError("EACCES", "tmp");
    },
    mtimeMs: () => null,
    remove: () => {},
  };
  let threw = false;
  try {
    tryAcquireLock("/x.lock", 0, 1, broken);
  } catch (e) {
    threw = isPermissionDenied(e);
  }
  assert(threw);
});

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
function failing(name: string, findings: number, detail = "boom"): VerifyCheck {
  return {
    name,
    status: "fail",
    detail,
    findings: Array.from({ length: findings }, (_, i) => `finding ${i + 1}`),
  };
}

function result(checks: VerifyCheck[]): VerifyResult {
  return {
    level: 0,
    checks,
    pass: !checks.some((c) => c.status === "fail"),
    duration_ms: 4200,
  };
}

test("summarizeFailure: header, capped findings, snapshot hint", () => {
  const r = result([
    { name: "render/homelab/addons", status: "pass" },
    failing("snapshot/homelab/addons", 8, "rendered output differs"),
  ]);
  const text = summarizeFailure(r, ["charts/addons/values.yaml"]);
  const lines = text.split("\n");
  assertStringIncludes(
    lines[0],
    "Level 0 verification FAILED after editing charts/addons/values.yaml",
  );
  assertStringIncludes(lines[0], "1 of 2 checks failed, 4.2 s");
  assertStringIncludes(
    text,
    "FAIL snapshot/homelab/addons: rendered output differs",
  );
  assertStringIncludes(text, "  - finding 5");
  assertEquals(text.includes("finding 6"), false);
  assertStringIncludes(text, "... 3 more finding(s)");
  assertStringIncludes(text, "task test:snapshot -- --update");
});

test("summarizeFailure: never exceeds 60 lines, reports hidden checks", () => {
  const checks = Array.from({ length: 30 }, (_, i) =>
    failing(`policy/env${i}`, 9),
  );
  const text = summarizeFailure(result(checks), [
    "charts/a.yaml",
    "charts/b.yaml",
    "charts/c.yaml",
    "charts/d.yaml",
  ]);
  const lines = text.split("\n");
  assert(lines.length <= 60, `got ${lines.length} lines`);
  assertStringIncludes(lines[0], "(+1 more)");
  assertStringIncludes(text, "more failing check(s): run `task verify:text`");
});

test("summarizeFailure: clips long findings to one line", () => {
  const long = "x".repeat(1000) + "\nsecond line";
  const text = summarizeFailure(
    result([{ name: "kubeconform/homelab", status: "fail", findings: [long] }]),
    ["charts/a.yaml"],
  );
  for (const line of text.split("\n")) {
    assert(line.length <= 480, `line of ${line.length}`);
  }
  assertEquals(text.includes("second line"), false);
});

test("hintsFor: committed-values and missing-schema hints", () => {
  const hints = hintsFor([
    failing("render/localdev/_committed-values", 1),
    {
      name: "kubeconform/homelab",
      status: "fail",
      findings: ["x.yaml: could not find schema for Foo"],
    },
  ]);
  assertEquals(hints.length, 2);
  assertStringIncludes(hints[0], "task config:export:localdev");
  assertStringIncludes(hints[1], "task schemas:vendor");
  assertEquals(hintsFor([failing("policy/homelab", 1)]), []);
});
