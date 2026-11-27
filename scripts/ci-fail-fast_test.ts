#!/usr/bin/env -S bun test
/**
 * Unit tests for ci-fail-fast.ts, and the gate itself: the last tests read the
 * real .github/workflows, so a new pull_request job without the fail-fast
 * step, or a ci-autofix.yml list edit without the matching keep-own-run,
 * fails CI.
 *
 *   bun test scripts/ci-fail-fast_test.ts
 */

import { join } from "node:path";
import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "./lib/assert.ts";
import {
  ACTION_PATH,
  AUTOFIX_WORKFLOW,
  actionProtectedWorkflow,
  expectedKeepOwnRun,
  FAIL_FAST_IF,
  FAIL_FAST_USES,
  failFastFindings,
  PROTECTED_WORKFLOW,
  parseAutofixWorkflows,
  RENOVATE_AWARE_KEEP,
  readWorkflows,
  readYaml,
  WORKFLOWS_DIR,
  type Workflow,
  workflowName,
} from "./ci-fail-fast.ts";

const CHECKOUT = { uses: "actions/checkout@abc # v7" };

function failFastStep(keepOwnRun?: string | boolean) {
  return {
    name: "Cancel the other CI runs for this PR head",
    if: FAIL_FAST_IF,
    "continue-on-error": true,
    uses: FAIL_FAST_USES,
    ...(keepOwnRun === undefined
      ? {}
      : { with: { "keep-own-run": keepOwnRun } }),
  };
}

function workflow(name: string, jobs: Record<string, unknown>): Workflow {
  return {
    file: `${name.toLowerCase().replaceAll(" ", "-")}.yml`,
    doc: {
      name,
      on: { pull_request: null, push: null },
      permissions: { contents: "read", actions: "write" },
      jobs,
    },
  };
}

function lintJob(...extra: unknown[]) {
  return {
    "runs-on": "ubuntu-latest",
    steps: [CHECKOUT, { run: "lint" }, ...extra],
  };
}

test("a job ending with the fail-fast step passes", () => {
  assertEquals(
    failFastFindings([workflow("Lint", { lint: lintJob(failFastStep()) })], []),
    [],
  );
});

test("a pull_request job without the fail-fast step is reported", () => {
  const findings = failFastFindings(
    [workflow("Lint", { lint: lintJob() })],
    [],
  );
  assertEquals(findings.length, 1);
  assertStringIncludes(findings[0], "lint.yml job lint");
  assertStringIncludes(findings[0], FAIL_FAST_USES);
});

test("the fail-fast step must be the last step", () => {
  const findings = failFastFindings(
    [workflow("Lint", { lint: lintJob(failFastStep(), { run: "later" }) })],
    [],
  );
  assertEquals(findings.length, 1);
});

test("a wrong if or a missing continue-on-error is reported", () => {
  const { "continue-on-error": _dropped, ...rest } = failFastStep();
  const step = { ...rest, if: "failure()" };
  const findings = failFastFindings(
    [workflow("Lint", { lint: lintJob(step) })],
    [],
  );
  assertEquals(findings.length, 2);
});

test("workflows that are not pull_request-triggered are ignored", () => {
  const scheduled = workflow("Nightly", { run: lintJob() });
  scheduled.doc.on = { schedule: [{ cron: "0 0 * * *" }] };
  const target = workflow("Triage", { run: lintJob() });
  target.doc.on = { pull_request_target: null };
  assertEquals(failFastFindings([scheduled, target], []), []);
});

test("jobs without a workspace checkout and push-only jobs are exempt", () => {
  const apiOnly = { "runs-on": "ubuntu-latest", steps: [{ run: "gh api" }] };
  const subdir = {
    "runs-on": "ubuntu-latest",
    steps: [{ ...CHECKOUT, with: { path: "tool" } }],
  };
  const pushOnly = { ...lintJob(), if: "github.event_name == 'push'" };
  assertEquals(
    failFastFindings([workflow("Mixed", { apiOnly, subdir, pushOnly })], []),
    [],
  );
});

test("the token must carry actions: write", () => {
  const wf = workflow("Lint", {
    lint: { ...lintJob(failFastStep()), permissions: { contents: "read" } },
  });
  const findings = failFastFindings([wf], []);
  assertEquals(findings.length, 1);
  assertStringIncludes(findings[0], "actions: write");
});

test("keep-own-run follows the ci-autofix workflow list", () => {
  assertEquals(expectedKeepOwnRun("Lint", ["Lint"]), RENOVATE_AWARE_KEEP);
  assertEquals(expectedKeepOwnRun("Lint", []), undefined);
  assertEquals(expectedKeepOwnRun(PROTECTED_WORKFLOW, []), "true");
  assertEquals(
    expectedKeepOwnRun(PROTECTED_WORKFLOW, [PROTECTED_WORKFLOW]),
    "true",
  );

  const listed = workflow("Lint", { lint: lintJob(failFastStep()) });
  const findings = failFastFindings([listed], ["Lint"]);
  assertEquals(findings.length, 1);
  assertStringIncludes(findings[0], "keep-own-run is unset");

  const unlisted = workflow("Build", {
    build: lintJob(failFastStep(RENOVATE_AWARE_KEEP)),
  });
  assertEquals(failFastFindings([unlisted], []).length, 1);

  const upgrade = workflow(PROTECTED_WORKFLOW, {
    upgrade: lintJob(failFastStep(true)),
  });
  assertEquals(failFastFindings([upgrade], [PROTECTED_WORKFLOW]), []);
});

test("an autofix entry naming no workflow is reported", () => {
  const findings = failFastFindings([], ["Renamed"]);
  assertEquals(findings.length, 1);
  assertStringIncludes(findings[0], '"Renamed"');
});

test("parseAutofixWorkflows reads on.workflow_run.workflows", () => {
  assertEquals(
    parseAutofixWorkflows({
      on: { workflow_run: { workflows: ["A", "B"], types: ["completed"] } },
    }),
    ["A", "B"],
  );
});

const realWorkflows = readWorkflows();
const realAutofix = parseAutofixWorkflows(
  readYaml(join(WORKFLOWS_DIR, AUTOFIX_WORKFLOW)),
);

test("every pull_request job in .github/workflows ends with the fail-fast step", () => {
  assertEquals(failFastFindings(realWorkflows, realAutofix), []);
});

test("the action protects the workflow upgrade.yml is named", () => {
  const upgrade = realWorkflows.find((w) => w.file === "upgrade.yml");
  assertEquals(upgrade && workflowName(upgrade), PROTECTED_WORKFLOW);
  assertEquals(
    actionProtectedWorkflow(readYaml(ACTION_PATH)),
    PROTECTED_WORKFLOW,
  );
});
