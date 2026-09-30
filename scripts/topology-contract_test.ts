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
    vocabulary: { absent: string; unrepresented: string; whyItMatters: string };
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
    points: { id: string; predicate: string; kind: string; rule: string }[];
    entry: string;
    entryPoints: string[];
    entrySelector: string;
    entrySelectorIsObserved: boolean;
    deadDeclaredTarget: string;
    deadDeclaredTargetGuidance: string;
    runShapes: { id: string; when: string; sequence: string[] }[];
  };
  consumers: {
    id: string;
    language: string;
    path: string;
    role: string;
    conformant: string;
    runShapes?: string[];
  }[];
}

const contract = parseYaml(
  readFileSync(CONTRACT_PATH, "utf8"),
) as TopologyContract;

/** The rule the contract states in prose, implemented once, here, to check the table. */
const quorumOf = (count: number): number => Math.floor(count / 2) + 1;

/**
 * The normative statement of a rule: its first sentence, with cross-references to
 * other clauses removed.
 *
 * Both halves are required, and mutation found the need for each. A search over the
 * whole rule is satisfied by the explanatory prose that follows the statement, so the
 * sentence stating the arithmetic could drop a defined word and still pass. Scoping to
 * the first sentence is not enough either: a parenthetical cross-reference sits inside
 * that sentence and carries the referenced clause's vocabulary, so `... that are
 * missing (vocabulary.unrepresented — ...)` passed a search for "unrepresented" while
 * the statement used the one synonym this contract forbids (MCAA-483).
 *
 * A parenthetical counts as a cross-reference when it contains whitespace or a dotted
 * path. `quorum(count)` is an application of a named formula, not a reference, and
 * survives stripping — which is what keeps the quorum-present search meaningful.
 */
const normative = (rule: string): string =>
  rule.replace(/\([^)]*[\s.][^)]*\)/g, " ").split(/(?<=\.)\s/)[0];

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
    "membership-accounts-for-expected",
    "no-errors",
    "no-learners",
    "quorum-present",
    "raft-index-converged",
    "single-leader",
  ]);

  // Defining an atom is not enforcing it: a condition dropped from `whole` is
  // still defined, and still referenced by `survivable`, so every other test in
  // this file stayed green while the gate at the door stopped checking it.
  // Found by mutating this file and watching nothing fail (MCAA-482). Both
  // consumers read the composition, so this is where it is pinned; changing it
  // is a contract decision (ADR-035), made here deliberately and in one commit.
  const byId = new Map(contract.health.predicates.map((p) => [p.id, p]));
  assertEquals([...byId.get("whole")!.conditions].sort(), [
    "member-count",
    "no-errors",
    "no-learners",
    "raft-index-converged",
    "single-leader",
  ]);
  assertEquals([...byId.get("survivable")!.conditions].sort(), [
    "absences-are-declared",
    "membership-accounts-for-expected",
    "no-errors",
    "no-learners",
    "quorum-present",
    "raft-index-converged",
    "single-leader",
  ]);
});

test("a missing member's two senses are defined once, and each has a condition that sees it", () => {
  // MCAA-407: the contract used "absent" for two different observations — a member in
  // the member list that did not answer, and a configured address with no member at
  // all. Only the first is an "expected member", so only the first is visible to
  // absences-are-declared. A reader who collapsed them would believe one condition
  // covered both, which is exactly how the resumed shape came to have no backstop.
  const vocab = contract.health.vocabulary;
  assert(vocab !== undefined, "health.vocabulary must define the two senses");
  // Scoped to each definition's own first sentence. Unscoped, a mutation that dropped
  // "did not answer" from the definition and left it in the sentence after it passed —
  // and a definition whose first sentence no longer says what the term means is not a
  // definition, however well the paragraph explains it.
  assert(
    /did not answer/i.test(normative(vocab.absent)),
    `vocabulary.absent defines itself as "${normative(vocab.absent)}", which never says "did not answer": the in-membership sense is the one absences-are-declared can see, and it is the answering that distinguishes it`,
  );
  assert(
    /member in etcd's membership at all/i.test(normative(vocab.unrepresented)),
    `vocabulary.unrepresented defines itself as "${normative(vocab.unrepresented)}", which never says there is no member in the membership at all: that is the whole difference from an absence`,
  );
  const byId = new Map(contract.health.predicates.map((p) => [p.id, p]));
  const survivable = new Set(byId.get("survivable")!.conditions);
  assert(
    survivable.has("absences-are-declared"),
    "survivable must enforce absences-are-declared to see the in-membership sense",
  );
  assert(
    survivable.has("membership-accounts-for-expected"),
    "survivable must enforce membership-accounts-for-expected to see the unrepresented sense",
  );
});

test("the resumed shape can see a second unrepresented address without member-count", () => {
  // The hole exclusive entry opened, closed. The resumed shape never evaluates `whole`
  // before the destructive work, so `member-count` — the only condition comparing
  // membership size against the derived count — is out of reach. On 5 or 7 members the
  // quorum arithmetic does not close the gap: with one undeclared address already out
  // of the membership, 3 answered >= quorum 3 and 0 non-answering members <=
  // maxUnavailable 2, so `survivable` consented to wiping a node on a control plane
  // that was never whole.
  const resumed = contract.evaluation.runShapes.find(
    (s) => s.id === "resumed",
  )!;
  const predicateAt = (id: string) =>
    contract.evaluation.points.find((p) => p.id === id)!.predicate;
  const byId = new Map(contract.health.predicates.map((p) => [p.id, p]));

  const beforeCompletion = resumed.sequence.slice(
    0,
    resumed.sequence.indexOf("completion"),
  );
  assert(
    beforeCompletion.length > 0,
    "the resumed shape must gate on something before completion",
  );
  for (const point of beforeCompletion) {
    const conditions = new Set(byId.get(predicateAt(point))!.conditions);
    assert(
      conditions.has("membership-accounts-for-expected") ||
        conditions.has("member-count"),
      `the resumed shape gates at ${point} with ${predicateAt(point)}, which compares nothing against the derived count: an undeclared unrepresented address is invisible there`,
    );
  }

  // Both branches, stated. The condition refuses on two different observations and the
  // one-clause version fails open: |membership| + |DECLARED unrepresented| == count is
  // satisfied by a stranger member cancelling an undeclared unrepresented address, so a
  // cluster carrying both faults adds up and the guard consents. The Go consumer always
  // checked both; only the contract's sentence was weaker (MCAA-483). "not only" is the
  // token that distinguishes the arithmetic over ALL unrepresented addresses from the
  // arithmetic over the declared ones.
  const statement = normative(
    contract.health.conditions.find(
      (c) => c.id === "membership-accounts-for-expected",
    )!.rule,
  );
  for (const token of ["derived", "unrepresented", "declared", "not only"]) {
    assert(
      statement.includes(token),
      `membership-accounts-for-expected states its arithmetic as "${statement}", which never says "${token}": it must state BOTH branches — the membership plus ALL unrepresented addresses ("not only" the declared ones) equals the DERIVED count, and every unrepresented address is a DECLARED target`,
    );
  }
});

test("no normative statement uses a synonym for the two senses of a missing member", () => {
  // The contract says out loud that "Missing" is not a term of it, because the two
  // senses have different conditions and collapsing them is what left the resumed shape
  // with no backstop. That prohibition was prose no test read: a mutation that put
  // "missing" into the arithmetic's normative statement, keeping the word in the
  // parenthetical cross-reference after it, left both suites green (MCAA-483). The
  // vocabulary is only defined once if nothing else may say it a second way.
  const forbidden = /\bmissing\b/i;
  const statements: [string, string][] = [
    ...contract.health.conditions.map((c): [string, string] => [
      `condition ${c.id}`,
      c.rule,
    ]),
    ...contract.health.predicates.flatMap((p): [string, string][] => [
      [`predicate ${p.id} summary`, p.summary],
      [`predicate ${p.id}`, p.rule],
    ]),
    ["vocabulary.absent", contract.health.vocabulary.absent],
    ["vocabulary.unrepresented", contract.health.vocabulary.unrepresented],
  ];
  for (const [where, text] of statements) {
    assert(
      !forbidden.test(normative(text)),
      `${where} says "missing" in its normative statement: the contract defines "absent" and "unrepresented" precisely because one word for both senses reads as total while covering one`,
    );
  }
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
  // Scoped the same way as the arithmetic above: the unscoped search passed a mutation
  // that dropped maxUnavailable(count) from the statement and left it in the prose after
  // it, so the condition consumed half the quorum table and the suite stayed green.
  const statement = normative(quorumRule!.rule);
  for (const token of ["quorum(count)", "maxUnavailable(count)"]) {
    assert(
      statement.includes(token),
      `quorum-present states itself as "${statement}", which never says ${token}: a condition that names only one of the two numbers leaves the other as data no predicate reads`,
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

test("entry is exclusive, and the entry points are the ones marked as such", () => {
  // `points` is a map from point to predicate, not a pipeline. Read as a sequence it
  // refuses its own resume path: a crashed recreate is short a member by construction,
  // so `whole` at preflight fires before `resume` is ever consulted.
  assertEquals(contract.evaluation.entry, "exclusive");
  const declared = contract.evaluation.points
    .filter((p) => p.kind === "entry")
    .map((p) => p.id);
  assertEquals([...contract.evaluation.entryPoints].sort(), declared.sort());
  assertEquals([...contract.evaluation.entryPoints].sort(), [
    "preflight",
    "resume",
  ]);
  for (const pt of contract.evaluation.points) {
    assert(
      pt.kind === "entry" || pt.kind === "in-run",
      `evaluation point ${pt.id} has kind ${pt.kind}, which is neither entry nor in-run`,
    );
  }
});

test("the entry point is chosen from the observed membership, never asserted by the caller", () => {
  // ADR-035 rejected a `--resume` flag: it moves "is this absence the one I asked
  // for" out of a tested predicate and into an operator typing a flag on a degraded
  // control plane. An asserted entry point is that same flag — asserting `resume` is
  // how a caller gets `survivable` at the door.
  assert(
    contract.evaluation.entrySelectorIsObserved,
    "an entry point the caller may assert reintroduces the --resume flag ADR-035 rejected",
  );
  // Asserted as a value, not matched as a substring. A /observed|membership/i test is
  // satisfied by `caller-asserted-membership-mode`, which announces the rejected design
  // in its own name and still passed (MCAA-407). The selector is a closed set of one.
  assertEquals(
    contract.evaluation.entrySelector,
    "declared-target-present-in-observed-membership",
  );
});

test("every run shape enters at exactly one entry point and ends whole", () => {
  const entryPoints = new Set(contract.evaluation.entryPoints);
  const pointIds = new Set(contract.evaluation.points.map((p) => p.id));
  const at = (id: string) =>
    contract.evaluation.points.find((p) => p.id === id);
  assert(
    contract.evaluation.runShapes.length >= 2,
    "a resume path is a run shape",
  );
  for (const shape of contract.evaluation.runShapes) {
    assert(shape.sequence.length > 0, `run shape ${shape.id} is empty`);
    for (const id of shape.sequence) {
      assert(
        pointIds.has(id),
        `run shape ${shape.id} names point ${id}, which does not exist`,
      );
    }
    const entries = shape.sequence.filter((id) => entryPoints.has(id));
    assertEquals(
      entries.length,
      1,
      `run shape ${shape.id} passes through ${entries.length} entry points; entry is exclusive`,
    );
    assertEquals(
      shape.sequence[0],
      entries[0],
      `run shape ${shape.id} does not start at its entry point`,
    );
    assertEquals(
      shape.sequence[shape.sequence.length - 1],
      "completion",
      `run shape ${shape.id} does not end at completion`,
    );
    assertEquals(at("completion")!.predicate, "whole");
  }
  for (const id of pointIds) {
    assert(
      contract.evaluation.runShapes.some((s) => s.sequence.includes(id)),
      `evaluation point ${id} belongs to no run shape, so no consumer can know when to evaluate it`,
    );
  }
});

test("the resumed shape never evaluates whole before the replacement rejoins", () => {
  // This is the defect MCAA-404 exists to pin. A resumed run is short a member from
  // its first observation to its last-but-one, so any `whole` gate other than
  // `completion` is unsatisfiable and aborts the recovery it was meant to finish.
  const resumed = contract.evaluation.runShapes.find((s) => s.id === "resumed");
  assert(resumed !== undefined, "the resumed run shape is missing");
  const predicateAt = (id: string) =>
    contract.evaluation.points.find((p) => p.id === id)!.predicate;
  for (const id of resumed!.sequence.slice(0, -1)) {
    assertEquals(
      predicateAt(id),
      "survivable",
      `the resumed shape evaluates ${predicateAt(id)} at ${id}, which a cluster short its target cannot satisfy`,
    );
  }
  assert(
    !resumed!.sequence.includes("preflight"),
    "resume is entered instead of preflight, not after it",
  );
  assert(
    !resumed!.sequence.includes("before-destructive-step"),
    "a resumed run skips the removal; it never removes a second member",
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

/** The calls that mark where a consumer's guard lives, per `consumers[].language`. */
const GUARD_MARKERS: Record<string, { evaluate: string; selectEntry: string }> =
  {
    go: { evaluate: "Evaluate", selectEntry: "SelectEntry" },
    typescript: { evaluate: "evaluatePredicate", selectEntry: "selectEntry" },
  };

/** The run shapes a consumer runs; an omitted list means every shape the contract defines. */
const runShapesOf = (
  consumer: TopologyContract["consumers"][number],
): string[] =>
  consumer.runShapes ?? contract.evaluation.runShapes.map((s) => s.id);

test("every consumer's run shapes are ones the contract defines", () => {
  const defined = contract.evaluation.runShapes.map((s) => s.id);
  for (const consumer of contract.consumers) {
    const shapes = runShapesOf(consumer);
    assert(shapes.length > 0, `consumer ${consumer.id} declares no run shapes`);
    for (const shape of shapes) {
      assert(
        defined.includes(shape),
        `consumer ${consumer.id} runs shape "${shape}", which evaluation.runShapes does not define (${defined.join(", ")})`,
      );
    }
  }
});

test("the fully conformant consumer's path is where the guard actually is", () => {
  // An existence check cannot tell the difference: this contract named
  // cmd/homelab/commands/talos.go, which exists and contains none of the guard — the
  // entry selection and every predicate evaluation are in talos_etcd.go (MCAA-483). A
  // path that merely exists sends the next reader to the wrong file, and a reviewer
  // checking conformance would find nothing there to check.
  const repoRoot = join(import.meta.dir, "..");
  for (const consumer of contract.consumers) {
    if (consumer.conformant !== "full") continue;
    const markers = GUARD_MARKERS[consumer.language];
    assert(
      markers !== undefined,
      `consumer ${consumer.id} is written in ${consumer.language}, which has no guard markers here (${Object.keys(GUARD_MARKERS).join(", ")})`,
    );
    const required = runShapesOf(consumer).includes("resumed")
      ? [markers.selectEntry, markers.evaluate]
      : [markers.evaluate];
    const src = readFileSync(join(repoRoot, consumer.path), "utf8");
    for (const marker of required) {
      assert(
        src.includes(marker),
        `consumer ${consumer.id} declares conformant: full at ${consumer.path}, which never calls ${marker}: the entry selection and predicate evaluation are what conformance means, so this path points at the wrong file`,
      );
    }
  }
});

test("the ordinary dead-target case refuses and names the procedure that applies", () => {
  // Row 2 of the entry table, which the table omitted while claiming to be total
  // (MCAA-483). A target that is still a member and not answering is the everyday
  // reason to run a recreate, and it fails member-count at preflight. Refusing is
  // correct — the cluster is already short — but refusing with bare arithmetic on the
  // common case sends the operator looking for a flag to bypass.
  assertEquals(contract.evaluation.deadDeclaredTarget, "refuse");
  const guidance = contract.evaluation.deadDeclaredTargetGuidance;
  assert(
    /remove-member|remove the dead member/i.test(guidance),
    "the guidance must name the step that makes the target unrepresented, not restate the refusal",
  );
  assert(
    guidance.includes("resume"),
    "the guidance must say which entry point the re-run then takes; otherwise it tells the operator to remove a member and stops",
  );
  assert(
    /runbook|docs\//i.test(guidance),
    "the guidance must point at the runbook, the way quorum.removalOfLastMemberGuidance does",
  );
});

test("every consumer states how far its conformance actually goes", () => {
  // A contract that lists a consumer reads as a contract that binds one. Both
  // consumers are `full` today (MCAA-482), each with its own conformance test; the
  // partial level stays in the vocabulary so a new consumer states where it actually
  // is instead of being listed here and silently assumed to comply.
  const levels = ["full", "count-key-pattern-only"];
  for (const consumer of contract.consumers) {
    assert(
      levels.includes(consumer.conformant),
      `consumer ${consumer.id} declares conformant: ${consumer.conformant ?? "(nothing)"}, which is not one of ${levels.join(", ")}`,
    );
  }
  assert(
    contract.consumers.some((c) => c.conformant === "full"),
    "no consumer is fully conformant, so nothing holds this contract to its own clauses",
  );
});

test("no consumer restates a contract value as a literal constant", () => {
  // ADR-031: "a second implementation of the same logic is a review failure". This
  // named the TypeScript consumer's EXPECTED_MEMBERS as debt while #39 was in flight,
  // and flipped to an assertion the moment both consumers read the contract
  // (MCAA-482). The raft tolerance is here for the same reason: a `= 10` in either
  // language is health.raftIndexTolerance restated, and changing it is a contract
  // change (ADR-030), not an edit to a constant.
  const repoRoot = join(import.meta.dir, "..");
  const offenders: string[] = [];
  for (const consumer of contract.consumers) {
    const src = readFileSync(join(repoRoot, consumer.path), "utf8");
    if (
      /EXPECTED_MEMBERS\s*=\s*\d/.test(src) ||
      /RAFT_TOLERANCE\s*=\s*\d/.test(src)
    ) {
      offenders.push(consumer.path);
    }
  }
  assertEquals(
    offenders,
    [],
    "a consumer hard-codes a value this contract states; move it to the contract rather than relaxing this expectation",
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
