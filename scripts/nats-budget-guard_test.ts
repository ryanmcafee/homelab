#!/usr/bin/env -S bun test
/**
 * Render regression for charts/nats-config's storage-budget guard
 * (`nats-config.assertMaxBytesBudget`).
 *
 * The guard's whole audience is a forker sizing their own JetStream file store:
 * homelab and localdev sit far under the ceiling, so nothing else would notice
 * if the check stopped checking. Two ways it can stop: the sum rule itself stops
 * rejecting an overcommitted stream set, or `maxBytesBudgetFraction` accepts a
 * value above the ADR-042 ceiling and the sum is then compared against a budget
 * larger than the store.
 *
 * These are render assertions rather than value assertions on purpose. The
 * static drift gate (nats-streams-contract_test.ts) reads values.yaml, which no
 * `--set` or parent-Application override passes through; only a real
 * `helm template` exercises the override path an operator actually uses.
 *
 *   bun test scripts/nats-budget-guard_test.ts
 */

import { test } from "bun:test";
import { join } from "node:path";
import { assert, assertStringIncludes } from "./lib/assert.ts";

const ROOT = join(import.meta.dir, "..");
const CHART_DIR = join(ROOT, "charts", "nats-config");

/** The ceiling the chart template names; every rejection below is relative to it. */
const CEILING = "0.75";

/** A store smaller than the 6 GiB the four default limits sum to. */
const OVERCOMMITTED_STORE = "4Gi";

interface Render {
  code: number;
  output: string;
}

function render(...args: string[]): Render {
  const proc = Bun.spawnSync([
    "helm",
    "template",
    "nats-config",
    CHART_DIR,
    ...args,
  ]);
  if (proc.exitCode === null) {
    throw new Error(`helm template was killed by a signal: ${proc.signalCode}`);
  }
  return {
    code: proc.exitCode,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

function assertRejected(result: Render, expected: string, what: string): void {
  assert(
    result.code !== 0,
    `${what}: helm template exited 0, so the guard accepted it\n${result.output}`,
  );
  assertStringIncludes(result.output, expected, `${what}: wrong rejection`);
}

function assertRendered(result: Render, what: string): void {
  assert(
    result.code === 0,
    `${what}: helm template exited ${result.code}\n${result.output}`,
  );
  assertStringIncludes(
    result.output,
    "maxBytes:",
    `${what}: rendered no stream`,
  );
}

test("the shipped defaults and both surface value files still render", () => {
  assertRendered(render(), "chart defaults");
  for (const surface of ["homelab", "localdev"]) {
    assertRendered(
      render("-f", join(CHART_DIR, `values-${surface}.yaml`)),
      `values-${surface}.yaml`,
    );
  }
});

test("a stream set summing above the budget is refused", () => {
  assertRejected(
    render("--set", `fileStoreSize=${OVERCOMMITTED_STORE}`),
    "exceeds the 3221225472-byte budget",
    "6 GiB of limits on a 4 GiB store",
  );
});

test("a fraction above the ADR-042 ceiling cannot buy the budget past the store", () => {
  // The defect this file was added for: `maxBytesBudgetFraction` was unbounded,
  // so the same overcommitted stream set that is refused above rendered clean
  // once the fraction was raised, against a 8589934592-byte "budget" on a
  // 4294967296-byte store.
  for (const fraction of ["2", "1", "0.76"]) {
    assertRejected(
      render(
        "--set",
        `fileStoreSize=${OVERCOMMITTED_STORE}`,
        "--set",
        `maxBytesBudgetFraction=${fraction}`,
      ),
      `maxBytesBudgetFraction ${fraction} exceeds the ADR-042 ceiling of ${CEILING}`,
      `fraction ${fraction}`,
    );
  }
});

test("a fraction at or below the ceiling is still honoured, not clamped up", () => {
  // The ceiling must not become the value: a conservative operator's 0.5 has to
  // keep rejecting a stream set that 0.75 would have passed.
  assertRendered(
    render("--set", `maxBytesBudgetFraction=${CEILING}`),
    "at the ceiling",
  );
  assertRejected(
    // 20 GiB * 0.25 = 5 GiB, under the 6 GiB the default limits sum to.
    render("--set", "maxBytesBudgetFraction=0.25"),
    "exceeds the 5368709120-byte budget",
    "a fraction below the ceiling still binds",
  );
});

test("a fraction that is not a finite positive decimal is refused, not coerced", () => {
  // NaN fails every ordered comparison, so a guard written only as `> ceiling`
  // lets it through and then renders a NaN budget that nothing is above.
  for (const fraction of ["NaN", "Inf", "-0.5", "abc", "1e10"]) {
    assertRejected(
      render("--set-string", `maxBytesBudgetFraction=${fraction}`),
      `maxBytesBudgetFraction "${fraction}" is not a finite positive decimal`,
      `fraction ${fraction}`,
    );
  }
  assertRejected(
    render("--set", "maxBytesBudgetFraction=0"),
    "budgets no bytes at all",
    "fraction 0",
  );
  assertRejected(
    render("--set", "maxBytesBudgetFraction=null"),
    "maxBytesBudgetFraction is unset",
    "unset fraction",
  );
});
