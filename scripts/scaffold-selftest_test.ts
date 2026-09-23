#!/usr/bin/env -S bun test
/**
 * Unit tests for the pure logic in scaffold-selftest.ts: result
 * classification against the baseline, output parsing, argument parsing and
 * the report. The end-to-end run (copy, build, scaffold, level 0) is
 * `task test:scaffold` itself.
 *
 *   bun test scripts/scaffold-selftest_test.ts
 */

import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "./lib/assert.ts";
import {
  casePassed,
  type CaseResult,
  CASES,
  changedPaths,
  type Check,
  classify,
  createdPaths,
  e2eTests,
  guardTargets,
  healthStems,
  parseArgs,
  parseVerifyOutput,
  renderSummary,
  UsageError,
  yamllintTargets,
} from "./scaffold-selftest.ts";

const pass = (name: string): Check => ({ name, status: "pass" });
const fail = (name: string, ...findings: string[]): Check => ({
  name,
  status: "fail",
  detail: "boom",
  findings,
});
const skip = (name: string): Check => ({ name, status: "skip" });

test("classify: a check failing only after the scaffold is new", () => {
  const c = classify(
    [pass("render/homelab/addons"), skip("gitops/homelab/ssa")],
    [fail("render/homelab/addons", "x"), fail("gitops/homelab/ssa", "y")],
  );
  assertEquals(
    c.newFailures.map((x) => x.name),
    ["render/homelab/addons", "gitops/homelab/ssa"],
  );
  assertEquals(c.preExisting, []);
  assertEquals(c.worsened, []);
});

test("classify: a check absent from the baseline and failing is new", () => {
  const c = classify([], [fail("snapshot/homelab/new-app-config")]);
  assertEquals(c.newFailures.length, 1);
});

test("classify: failing in both with the same findings is pre-existing", () => {
  const c = classify(
    [fail("snapshot/homelab/gitops", "a", "b")],
    [fail("snapshot/homelab/gitops", "b", "a")],
  );
  assertEquals(
    c.preExisting.map((x) => x.name),
    ["snapshot/homelab/gitops"],
  );
  assertEquals(c.newFailures, []);
  assertEquals(c.worsened, []);
});

test("classify: failing in both with extra findings is worsened", () => {
  const c = classify(
    [fail("kubeconform/homelab", "old")],
    [fail("kubeconform/homelab", "old", "new: Widget has no schema")],
  );
  assertEquals(c.worsened.length, 1);
  assertEquals(c.worsened[0].added, ["new: Widget has no schema"]);
});

test("classify: failing before and passing or gone after is fixed", () => {
  const c = classify(
    [fail("snapshot/homelab/addons"), fail("snapshot/localdev/gone")],
    [pass("snapshot/homelab/addons")],
  );
  assertEquals(c.fixed, ["snapshot/homelab/addons", "snapshot/localdev/gone"]);
});

function result(over: Partial<CaseResult>): CaseResult {
  return {
    id: "helm",
    description: "d",
    dir: "/tmp/x",
    scaffoldErrors: [],
    extras: [],
    classification: {
      newFailures: [],
      worsened: [],
      preExisting: [],
      fixed: [],
    },
    ...over,
  };
}

test("casePassed: clean case passes, pre-existing failures do not count", () => {
  assert(casePassed(result({})));
  assert(
    casePassed(
      result({
        classification: {
          newFailures: [],
          worsened: [],
          preExisting: [fail("x")],
          fixed: [],
        },
      }),
    ),
  );
});

test("casePassed: scaffold errors, missing level 0, new failures and failed extras fail", () => {
  assert(!casePassed(result({ scaffoldErrors: ["exit 2"] })));
  assert(!casePassed(result({ verifyError: "no JSON" })));
  assert(!casePassed(result({ classification: undefined })));
  assert(
    !casePassed(
      result({
        classification: {
          newFailures: [fail("a")],
          worsened: [],
          preExisting: [],
          fixed: [],
        },
      }),
    ),
  );
  assert(
    !casePassed(
      result({
        classification: {
          newFailures: [],
          worsened: [{ check: fail("a"), added: ["z"] }],
          preExisting: [],
          fixed: [],
        },
      }),
    ),
  );
  assert(
    !casePassed(
      result({ extras: [{ name: "yamllint", status: "fail", detail: "" }] }),
    ),
  );
  assert(
    casePassed(
      result({
        extras: [{ name: "chainsaw lint", status: "skip", detail: "" }],
      }),
    ),
  );
});

test("parseVerifyOutput: tolerates wrapper noise around the JSON", () => {
  const r = parseVerifyOutput(
    'task: [verify] go run ...\n{"level":0,"pass":false,"checks":[{"name":"a","status":"fail"}]}\ntask: Failed\n',
  );
  assertEquals(r.level, 0);
  assertEquals(r.checks[0].name, "a");
});

test("parseVerifyOutput: rejects output without a result", () => {
  assertThrows(() => parseVerifyOutput("Error: boom"), Error, "no JSON object");
  assertThrows(() => parseVerifyOutput('{"level":0}'), Error, "checks");
});

const SCAFFOLD_OUT = [
  "\x1b[32m[OK]\x1b[0m scaffolded x (helm pattern, charts/applications)",
  "[OK] modified .github/renovate.json5",
  "[OK] created  charts/applications/templates/x.yaml",
  "[OK] modified configuration/templates/helm-apps.tmpl",
  "[OK] created  charts/x-config/values-homelab.yaml",
  "[OK] created  charts/bootstrap/files/health/example.com_Widget.lua",
  "[OK] created  tests/e2e/x/chainsaw-test.yaml",
  "[OK] modified charts/applications/values-localdev.yaml",
  "[OK] snapshot homelab/applications",
].join("\n");

test("createdPaths / changedPaths parse the scaffolder output", () => {
  assertEquals(createdPaths(SCAFFOLD_OUT), [
    "charts/applications/templates/x.yaml",
    "charts/x-config/values-homelab.yaml",
    "charts/bootstrap/files/health/example.com_Widget.lua",
    "tests/e2e/x/chainsaw-test.yaml",
  ]);
  assertEquals(changedPaths(SCAFFOLD_OUT).length, 7);
  assert(changedPaths(SCAFFOLD_OUT).includes(".github/renovate.json5"));
});

test("target filters pick the right files", () => {
  const paths = changedPaths(SCAFFOLD_OUT);
  assertEquals(yamllintTargets(createdPaths(SCAFFOLD_OUT)), [
    "charts/x-config/values-homelab.yaml",
    "tests/e2e/x/chainsaw-test.yaml",
  ]);
  assertEquals(healthStems(paths), ["example.com_Widget"]);
  assertEquals(e2eTests(paths), ["tests/e2e/x/chainsaw-test.yaml"]);
  assertEquals(guardTargets(paths), [
    "configuration/templates/helm-apps.tmpl",
    "charts/x-config/values-homelab.yaml",
  ]);
});

test("parseArgs: flags, lists and errors", () => {
  assertEquals(parseArgs([]), {
    help: false,
    keep: false,
    dryRun: false,
    only: [],
    bin: null,
  });
  const a = parseArgs([
    "--only",
    "helm,operator",
    "--keep",
    "--bin=bin/homelab",
  ]);
  assertEquals(a.only, ["helm", "operator"]);
  assertEquals(a.keep, true);
  assertEquals(a.bin, "bin/homelab");
  assertEquals(parseArgs(["--only=combined", "--dry-run"]).dryRun, true);
  assertThrows(() => parseArgs(["--only", "nope"]), UsageError, "unknown case");
  assertThrows(() => parseArgs(["--bin"]), UsageError, "requires a value");
  assertThrows(
    () => parseArgs(["--frobnicate"]),
    UsageError,
    "unknown argument",
  );
});

test("CASES cover every pattern once each, with unique ids", () => {
  const ids = CASES.map((c) => c.id);
  assertEquals(new Set(ids).size, ids.length);
  for (const pattern of ["operator", "helm", "deps-main-config"]) {
    const single = CASES.find((c) => c.id === pattern);
    assert(single, `missing case ${pattern}`);
    assertEquals(single.apps.length, 1);
    assert(single.apps[0].args.includes(pattern));
  }
  const combined = CASES.find((c) => c.id === "combined")!;
  const names = combined.apps.map((a) => a.name);
  assertEquals(new Set(names).size, names.length);
});

test("renderSummary names verdicts, causes and pre-existing failures", () => {
  const out = renderSummary([
    result({ id: "operator" }),
    result({
      id: "helm",
      classification: {
        newFailures: [fail("policy/homelab", "[app-ssa] x")],
        worsened: [],
        preExisting: [fail("snapshot/homelab/gitops")],
        fixed: ["snapshot/homelab/addons"],
      },
    }),
  ]);
  assertStringIncludes(out, "[PASS] operator");
  assertStringIncludes(out, "[FAIL] helm");
  assertStringIncludes(out, "NEW  policy/homelab: boom");
  assertStringIncludes(out, "[app-ssa] x");
  assertStringIncludes(out, "pre-existing (ignored) snapshot/homelab/gitops");
  assertStringIncludes(out, "1 of 2 case(s) failed: helm");
});
