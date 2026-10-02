#!/usr/bin/env -S bun test
/**
 * Consistency tests for contracts/cluster/topology.v1.yaml — the control-plane
 * topology and etcd quorum contract (ADR-035).
 *
 * This file is the contract's own gate, in the shape ADR-030 requires: the rule set
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
    countSource: string;
    countKeyPattern: string;
    countRequired: boolean;
    countSourceSchemaReady: boolean;
    permittedCounts: number[];
    degradedCounts: number[];
  };
  quorum: {
    formula: string;
    maxUnavailableFormula: string;
    table: QuorumRow[];
    removalOfLastMember: string;
    removalOfLastMemberGuidance: string;
  };
  health: {
    conditions: { id: string; rule: string }[];
    raftIndexTolerance: number;
    predicates: {
      id: string;
      summary: string;
      evaluatedOver: string;
      conditions: string[];
      rule: string;
      resumeSemantics?: string;
    }[];
  };
  evaluation: {
    onIndeterminate: string;
    guarantee: string;
    revalidateBeforeDestructiveStep: boolean;
    points: { id: string; predicate: string; rule: string }[];
  };
  consumers: { id: string; language: string; path: string; role: string }[];
}

const contract = parseYaml(
  readFileSync(CONTRACT_PATH, "utf8"),
) as TopologyContract;

/** The rule the contract states in prose, implemented once, here, to check the table. */
const quorumOf = (count: number): number => Math.floor(count / 2) + 1;

test("contract is v1 and derives the count from the address keys, not a constant", () => {
  assertEquals(contract.version, 1);
  // ADR-029: a fork's topology is operator configuration. A literal member count in
  // the contract would be the same defect as EXPECTED_MEMBERS = 3 in either language.
  // ADR-035: and it is derived, not a second key — the address list already states the
  // control plane, so a separate count key is a second source of truth that can disagree.
  assertEquals(contract.controlPlane.countSource, "config-set-key-pattern");
  assert(
    !("countKey" in contract.controlPlane),
    "a scalar countKey reintroduces the second source of truth ADR-035 rejected",
  );
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

test("the health conditions keep everything the TypeScript gate enforced", () => {
  // Regression guard on the port (#39): member-count, no-errors, no-learners,
  // single-leader and raft-index-converged are the conditions etcdHealth() in
  // scripts/cp-storage-migrate.ts checks today. Dropping one here would silently
  // weaken the rule for both consumers at once.
  //
  // quorum-present and absences-are-declared are additions, not replacements: they
  // exist so `survivable` can be stated without relaxing any of the five above.
  const ids = contract.health.conditions.map((c) => c.id).sort();
  assertEquals(ids, [
    "absences-are-declared",
    "member-count",
    "no-errors",
    "no-learners",
    "quorum-present",
    "raft-index-converged",
    "single-leader",
  ]);
});

test("every condition is reachable from a predicate, and every predicate names defined conditions", () => {
  // This is the defect that prompted the predicates: the first revision of this
  // contract defined `quorum` and `maxUnavailable` in full, with a worked table, and
  // then no stated condition consumed either of them. Data nobody reads looks like a
  // rule and enforces nothing. Both directions are asserted so neither can rot.
  const defined = new Set(contract.health.conditions.map((c) => c.id));
  const referenced = new Set(
    contract.health.predicates.flatMap((p) => p.conditions),
  );
  for (const p of contract.health.predicates) {
    for (const id of p.conditions) {
      assert(
        defined.has(id),
        `predicate ${p.id} names condition ${id}, which is not defined in health.conditions`,
      );
    }
  }
  for (const id of defined) {
    assert(
      referenced.has(id),
      `condition ${id} is defined but no predicate evaluates it — a rule no gate consumes`,
    );
  }
});

test("the quorum rule is consumed by a condition, not merely published", () => {
  // The narrow regression test for the same defect, aimed at the specific values.
  const quorumRule = contract.health.conditions.find(
    (c) => c.id === "quorum-present",
  );
  assert(
    quorumRule !== undefined,
    "no condition consumes quorum/maxUnavailable; the quorum table would be decoration",
  );
  for (const token of ["quorum(count)", "maxUnavailable(count)"]) {
    assert(
      quorumRule!.rule.includes(token),
      `quorum-present must state that it reads ${token} from the quorum table`,
    );
  }
});

test("survivable relaxes `whole` in exactly one way and no other", () => {
  // The safety argument for having two predicates rests entirely on this: the only
  // thing `survivable` forgives is the declared target's absence. If it ever drops
  // no-errors, no-learners, single-leader or raft-index-converged, the guard at the
  // most dangerous moment of the procedure has become weaker than the one at the
  // door, and this test is the thing standing between that and a lost quorum.
  const byId = new Map(contract.health.predicates.map((p) => [p.id, p]));
  const whole = byId.get("whole");
  const survivable = byId.get("survivable");
  assert(whole !== undefined, "predicate `whole` must exist");
  assert(survivable !== undefined, "predicate `survivable` must exist");

  const survivableSet = new Set(survivable!.conditions);
  for (const id of whole!.conditions) {
    if (id === "member-count") continue; // the one relaxation, by construction
    assert(
      survivableSet.has(id),
      `survivable drops ${id}, which whole enforces: that is a weaker gate at a more dangerous moment`,
    );
  }
  assert(
    !survivableSet.has("member-count"),
    "survivable cannot require member-count: at the revalidation point the target is deliberately gone, so it is unsatisfiable by construction",
  );
  for (const id of ["quorum-present", "absences-are-declared"]) {
    assert(
      survivableSet.has(id),
      `survivable must enforce ${id}; without it the relaxation is not bounded to the declared target`,
    );
  }
  assertEquals(whole!.evaluatedOver, "expected-members");
  assertEquals(survivable!.evaluatedOver, "answering-members");
});

test("every evaluation point names a real predicate, and every predicate is used", () => {
  const predicateIds = new Set(contract.health.predicates.map((p) => p.id));
  const used = new Set(contract.evaluation.points.map((pt) => pt.predicate));
  for (const pt of contract.evaluation.points) {
    assert(
      predicateIds.has(pt.predicate),
      `evaluation point ${pt.id} names predicate ${pt.predicate}, which does not exist`,
    );
  }
  for (const id of predicateIds) {
    assert(
      used.has(id),
      `predicate ${id} is defined but no evaluation point uses it`,
    );
  }
});

test("the destructive and resume gates use survivable, the entry and exit gates use whole", () => {
  // The mapping is the contract. `whole` before the destructive step aborts every
  // procedure mid-flight; `survivable` at preflight consents to starting on a cluster
  // that was already a member short. Both are one-line edits away and both are wrong.
  const at = (id: string) =>
    contract.evaluation.points.find((p) => p.id === id);
  for (const id of [
    "preflight",
    "before-destructive-step",
    "resume",
    "completion",
  ]) {
    assert(at(id) !== undefined, `evaluation point ${id} is missing`);
  }
  assertEquals(at("preflight")!.predicate, "whole");
  assertEquals(at("before-destructive-step")!.predicate, "survivable");
  assertEquals(at("resume")!.predicate, "survivable");
  assertEquals(at("completion")!.predicate, "whole");
  assert(
    contract.evaluation.revalidateBeforeDestructiveStep,
    "the before-destructive-step point only means something if revalidation is required",
  );
});

test("a count with no fault tolerance refuses removal and names the procedure that applies", () => {
  // count: 1 has maxUnavailable 0, so `survivable` can never hold for a removal. The
  // guard must say that recreating a single-member control plane is a restore, not
  // report a quorum error the operator will try to argue with.
  const single = contract.quorum.table.find((r) => r.count === 1);
  assert(
    single !== undefined,
    "count 1 is permitted and must have a worked row",
  );
  assertEquals(single!.maxUnavailable, 0);
  assertEquals(contract.quorum.removalOfLastMember, "refuse");
  assert(
    /runbook|restore|snapshot/i.test(
      contract.quorum.removalOfLastMemberGuidance,
    ),
    "the refusal must point at the restore procedure, not just refuse",
  );
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
  // ADR-031: "a second implementation of the same logic is a review failure". The
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

  // The symmetric half: while countSourceSchemaReady is false, the derivation may not
  // be implemented either. Without this, appending a ^CP([0-9]+)_IP$ derivation to a
  // declared consumer leaves the suite fully green, and the flag is documentation no
  // test reads. Shipping the derivation early is strictly worse than the constant it
  // replaces — it resolves to 3 for every fork and is now invisible — so the flag is
  // the gate and this is what makes it load-bearing.
  if (contract.controlPlane.countSourceSchemaReady === false) {
    const patternSource = contract.controlPlane.countKeyPattern;
    // Either the literal pattern string lifted out of this file, or a regex of the
    // same shape written by hand. Both mean the same thing: a consumer deriving the
    // count from CP*_IP keys.
    const cpRegexShape = /CP\(?\[0-9\]\+\)?_IP|CP\(?\\d\+\)?_IP/;
    const premature: string[] = [];
    for (const consumer of contract.consumers) {
      const src = readFileSync(join(repoRoot, consumer.path), "utf8");
      if (src.includes(patternSource) || cpRegexShape.test(src)) {
        premature.push(consumer.path);
      }
    }
    assertEquals(
      premature,
      [],
      `countSourceSchemaReady is false, so no consumer may derive the control-plane count from ${patternSource} yet: configuration/schema/network.schema.yaml still fixes the key set at three, so the derivation resolves to 3 for every fork. Land the schema change and flip countSourceSchemaReady to true in the same commit, then this assertion stops applying`,
    );
  }
});

test("the count key pattern matches the control-plane address keys and nothing else", () => {
  // ADR-035: the derived count is only as good as the pattern that finds the keys.
  const re = new RegExp(contract.controlPlane.countKeyPattern);
  for (const key of ["CP1_IP", "CP2_IP", "CP3_IP", "CP10_IP"]) {
    assert(
      re.test(key),
      `${key} should be read as a control-plane address key`,
    );
  }
  // CP_VIP is the shared virtual IP, not a member; the worker keys are not the control
  // plane. Counting either would overstate the expected member count, and this guard is
  // destructive-path-adjacent: too high means it refuses on a healthy cluster, too low
  // means it consents to losing quorum.
  for (const key of [
    "CP_VIP",
    "WORKER1_IP",
    "PROXMOX_IP",
    "TRUENAS_IP",
    "GATEWAY_IP",
  ]) {
    assert(
      !re.test(key),
      `${key} must not be counted as a control-plane member`,
    );
  }
});

test("countSourceSchemaReady tells the truth about the ConfigSet schema", () => {
  // ADR-035 makes the schema change a MERGE CONDITION on #39 rather than a follow-up:
  // while CP1_IP/CP2_IP/CP3_IP are three individually required scalars, the pattern
  // resolves to exactly 3 for every fork on earth — parameterised in form, constant in
  // effect, which is worse than an honest constant because it looks solved.
  //
  // This test exists so that condition cannot be forgotten. When the schema admits the
  // pattern, this flips to green and countSourceSchemaReady must be set true in the
  // same change; until then, claiming readiness fails here.
  const schema = parseYaml(
    readFileSync(
      join(
        import.meta.dir,
        "..",
        "configuration",
        "schema",
        "network.schema.yaml",
      ),
      "utf8",
    ),
  ) as { keys?: Record<string, { required?: boolean }> };
  const keys = schema.keys ?? {};
  const fixedRequired = ["CP2_IP", "CP3_IP"].filter(
    (k) => keys[k]?.required === true,
  );
  const schemaAdmitsVariableTopology = fixedRequired.length === 0;

  assertEquals(
    contract.controlPlane.countSourceSchemaReady,
    schemaAdmitsVariableTopology,
    schemaAdmitsVariableTopology
      ? "the schema no longer pins the topology to three nodes — set countSourceSchemaReady: true"
      : `the schema still requires ${fixedRequired.join(", ")}, so every fork resolves to 3 members; countSourceSchemaReady must stay false until CP1_IP is the only required control-plane address`,
  );
});
