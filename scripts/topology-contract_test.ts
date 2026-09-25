#!/usr/bin/env -S bun test
/**
 * Consistency tests for contracts/cluster/topology.v1.yaml — the control-plane
 * topology and etcd quorum contract (ADR-031).
 *
 * This file is the contract's own gate, in the shape ADR-029 requires: the rule set
 * is checked against the checked-in contract, and the checker is tested rather than
 * trusted. It asserts that the contract is internally consistent — that the worked
 * quorum table actually matches the stated formula, that the permitted topologies are
 * ones the formula is safe for, and that both declared consumers still exist.
 *
 * It is deliberately NOT a conformance test for either consumer. Those belong with
 * the consumers (#39 for Go, cp-storage-migrate for TypeScript) and assert that each
 * implementation computes the same numbers this file pins.
 *
 *   bun test scripts/topology-contract_test.ts
 */

import { test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEquals } from "./lib/assert.ts";
import { parse as parseYaml } from "./lib/yaml.ts";

const CONTRACT_PATH = join(
  import.meta.dir,
  "..",
  "contracts",
  "cluster",
  "topology.v1.yaml",
);

interface QuorumRow {
  count: number;
  quorum: number;
  maxUnavailable: number;
}

interface TopologyContract {
  version: number;
  controlPlane: {
    countKey: string;
    countRequired: boolean;
    permittedCounts: number[];
    degradedCounts: number[];
  };
  quorum: {
    formula: string;
    maxUnavailableFormula: string;
    table: QuorumRow[];
  };
  health: {
    conditions: { id: string; rule: string }[];
    raftIndexTolerance: number;
  };
  evaluation: {
    onIndeterminate: string;
    guarantee: string;
    revalidateBeforeDestructiveStep: boolean;
  };
  consumers: { id: string; language: string; path: string; role: string }[];
}

const contract = parseYaml(
  readFileSync(CONTRACT_PATH, "utf8"),
) as TopologyContract;

/** The rule the contract states in prose, implemented once, here, to check the table. */
const quorumOf = (count: number): number => Math.floor(count / 2) + 1;

test("contract is v1 and pins the count to a ConfigSet key, not a constant", () => {
  assertEquals(contract.version, 1);
  // ADR-028: a fork's topology is operator configuration. A literal member count in
  // the contract would be the same defect as EXPECTED_MEMBERS = 3 in either language.
  assertEquals(contract.controlPlane.countKey, "CONTROL_PLANE_COUNT");
  assert(
    contract.controlPlane.countRequired,
    "the count must be required; a default would let a fork come up with the wrong topology",
  );
});

test("the worked quorum table matches the stated formula", () => {
  for (const row of contract.quorum.table) {
    assertEquals(
      row.quorum,
      quorumOf(row.count),
      `quorum for ${row.count} members should be ${quorumOf(row.count)}, table says ${row.quorum}`,
    );
    assertEquals(
      row.maxUnavailable,
      row.count - row.quorum,
      `maxUnavailable for ${row.count} members should be ${row.count - row.quorum}`,
    );
  }
});

test("every permitted count has a row, and every row is a permitted count", () => {
  const permitted = [...contract.controlPlane.permittedCounts].sort(
    (a, b) => a - b,
  );
  const tabled = contract.quorum.table
    .map((r) => r.count)
    .sort((a, b) => a - b);
  // A permitted topology with no worked row is a topology no consumer's conformance
  // test covers — which is how a fork-specific bug reaches a destructive code path.
  assertEquals(tabled, permitted);
});

test("permitted counts are odd", () => {
  for (const count of contract.controlPlane.permittedCounts) {
    assertEquals(
      count % 2,
      1,
      `${count} is even: it tolerates no more failures than ${count - 1} while adding one more thing that can fail`,
    );
  }
});

test("a topology with no fault tolerance is declared degraded", () => {
  for (const row of contract.quorum.table) {
    if (row.maxUnavailable === 0) {
      assert(
        contract.controlPlane.degradedCounts.includes(row.count),
        `${row.count} member(s) can lose nothing and must be listed in degradedCounts so the guard says so out loud`,
      );
    }
  }
});

test("the health predicate keeps every condition the TypeScript gate enforced", () => {
  // Regression guard on the port (#39): these are the conditions etcdHealth() in
  // scripts/cp-storage-migrate.ts checks today. Dropping one here would silently
  // weaken the rule for both consumers at once.
  const ids = contract.health.conditions.map((c) => c.id).sort();
  assertEquals(ids, [
    "member-count",
    "no-errors",
    "no-learners",
    "raft-index-converged",
    "single-leader",
  ]);
});

test("the RAFT INDEX tolerance carries over from the runbook gate", () => {
  assertEquals(contract.health.raftIndexTolerance, 10);
  assert(
    contract.health.raftIndexTolerance > 0,
    "a zero tolerance makes the gate unusable on a cluster that is still taking writes",
  );
});

test("evaluation is fail-closed and re-checked before the destructive step", () => {
  assertEquals(contract.evaluation.onIndeterminate, "unsafe");
  assert(
    contract.evaluation.revalidateBeforeDestructiveStep,
    "a check at the start of a multi-step procedure is stale by the time the node is destroyed",
  );
});

test("both declared consumers still exist at the paths the contract names", () => {
  const repoRoot = join(import.meta.dir, "..");
  assert(
    contract.consumers.length >= 2,
    "the contract exists because there are two consumers",
  );
  for (const consumer of contract.consumers) {
    assert(
      existsSync(join(repoRoot, consumer.path)),
      `consumer ${consumer.id} names ${consumer.path}, which does not exist`,
    );
  }
});

test("no consumer restates a contract value as a literal constant", () => {
  // ADR-030: "a second implementation of the same logic is a review failure". The
  // TypeScript consumer still carries EXPECTED_MEMBERS while #39 is in flight; this
  // test names that debt rather than pretending it is gone, and flips to an assertion
  // the moment both consumers read the contract.
  const repoRoot = join(import.meta.dir, "..");
  const offenders: string[] = [];
  for (const consumer of contract.consumers) {
    const src = readFileSync(join(repoRoot, consumer.path), "utf8");
    if (/EXPECTED_MEMBERS\s*=\s*\d/.test(src)) offenders.push(consumer.path);
  }
  assertEquals(
    offenders,
    ["scripts/cp-storage-migrate.ts"],
    "a consumer started or stopped hard-coding the member count; update this expectation deliberately, in the same change that moves it to the contract",
  );
});
