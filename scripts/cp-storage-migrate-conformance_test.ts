#!/usr/bin/env -S bun test
/**
 * The TypeScript consumer's conformance test against
 * contracts/cluster/topology.v1.yaml (ADR-030's shape: the checker is tested,
 * not trusted). scripts/topology-contract_test.ts asserts the contract is
 * internally consistent; this asserts that scripts/cp-storage-migrate.ts
 * actually computes the numbers that file pins, evaluates the conditions it
 * names, and applies them at the points it maps them to.
 *
 * It reads the checked-in contract, so a change to the file changes what these
 * assertions see. That is the point: edit a `quorum.table` row, or drop a
 * condition from a predicate, and this suite goes red rather than the consumer
 * quietly enforcing a different rule from the Go one.
 *
 * What is deliberately NOT asserted here: the `evaluation.entry` clause. It
 * binds a consumer that runs the destructive member-removal procedure, and
 * `migrate` does not run one — see RUN_SHAPE in the script.
 *
 *   bun test scripts/cp-storage-migrate-conformance_test.ts
 */

import { test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  etcdGate,
  RUN_SHAPE,
  TOPOLOGY,
  topologyGate,
} from "./cp-storage-migrate.ts";
import { assert, assertEquals } from "./lib/assert.ts";
import {
  type ConditionId,
  evaluatePredicate,
  IMPLEMENTED_CONDITIONS,
  type Observation,
  parseTopologyContract,
  type PointId,
  type StatusRow,
  TOPOLOGY_CONTRACT_PATH,
  TopologyContractError,
} from "./lib/topology-contract.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "./lib/yaml.ts";

/** RFC 5737 TEST-NET-1: no real topology belongs in this repository. */
const ADDRESSES = [
  "192.0.2.11",
  "192.0.2.12",
  "192.0.2.13",
  "192.0.2.14",
  "192.0.2.15",
  "192.0.2.16",
  "192.0.2.17",
];
const LEADER = "3f9a1b2c3d4e5f60";

function status(node: string, over: Partial<StatusRow> = {}): StatusRow {
  return {
    node,
    member: `member-${node}`,
    leader: LEADER,
    raftIndex: 14876322,
    learner: false,
    errors: "",
    ...over,
  };
}

/**
 * A control plane of `count` members where every member answered and nothing
 * is wrong. Each fixture below states only the thing it breaks, so a gate that
 * refuses does so for the reason the test named.
 */
function whole(count: number, over: Partial<Observation> = {}): Observation {
  const expected = ADDRESSES.slice(0, count);
  return {
    expected,
    membership: expected,
    statuses: expected.map((ip) => status(ip)),
    declared: [],
    transportErrors: [],
    observedAt: Date.now(),
    ...over,
  };
}

// ----------------------------------------------------------------------------
// The quorum table
// ----------------------------------------------------------------------------

test("this consumer computes the contract's worked quorum row for every count", () => {
  // The clause that binds every consumer. A Go implementation and a TypeScript
  // one that disagree about the quorum of a 5-member control plane are two
  // different safety rules wearing one contract.
  for (const row of TOPOLOGY.quorumTable) {
    assertEquals(
      TOPOLOGY.quorum(row.count),
      row.quorum,
      `quorum for ${row.count} members: the contract's table says ${row.quorum}`,
    );
    assertEquals(
      TOPOLOGY.maxUnavailable(row.count),
      row.maxUnavailable,
      `maxUnavailable for ${row.count} members: the contract's table says ${row.maxUnavailable}`,
    );
  }
});

test("the quorum table decides a real gate, it is not arithmetic nobody acts on", () => {
  // The narrow regression for "data nobody reads looks like a rule and enforces
  // nothing". Each row is driven through the gate that consumes it: exactly
  // maxUnavailable declared absences must pass, one more must refuse.
  for (const row of TOPOLOGY.quorumTable) {
    const expected = ADDRESSES.slice(0, row.count);
    const absent = (n: number): Observation =>
      whole(row.count, {
        statuses: expected.slice(n).map((ip) => status(ip)),
        declared: expected.slice(0, n),
      });

    if (row.maxUnavailable > 0) {
      const atTheLimit = etcdGate(
        "before-destructive-step",
        absent(row.maxUnavailable),
      );
      assertEquals(
        atTheLimit.ok,
        true,
        `a ${row.count}-member control plane tolerates ${row.maxUnavailable} declared ` +
          `absence(s) by the contract's own table, but the gate refused: ${atTheLimit.detail}`,
      );
    }

    const overTheLimit = etcdGate(
      "before-destructive-step",
      absent(row.maxUnavailable + 1),
    );
    assertEquals(
      overTheLimit.ok,
      false,
      `a ${row.count}-member control plane must refuse ${row.maxUnavailable + 1} absences`,
    );
    assert(
      overTheLimit.detail.includes(`needs a quorum of ${row.quorum}`) ||
        overTheLimit.detail.includes(`tolerates at most ${row.maxUnavailable}`),
      `the refusal must show the contract's arithmetic, got: ${overTheLimit.detail}`,
    );
  }
});

test("every permitted count is accepted and an unpermitted one is refused", () => {
  for (const count of TOPOLOGY.permittedCounts) {
    const gate = topologyGate(count);
    assertEquals(gate.ok, true, `${count} is permitted: ${gate.detail}`);
    assertEquals(
      gate.detail.includes("DEGRADED"),
      TOPOLOGY.degradedCounts.includes(count),
      `${count} must be reported as degraded exactly when the contract lists it`,
    );
  }
  for (let count = 0; count <= 8; count++) {
    if (TOPOLOGY.permittedCounts.includes(count)) continue;
    assertEquals(
      topologyGate(count).ok,
      false,
      `${count} is not a permitted topology and must be refused`,
    );
  }
});

// ----------------------------------------------------------------------------
// The conditions
// ----------------------------------------------------------------------------

/**
 * One observation per condition, each breaking that condition, with what EVERY
 * condition says about it. The predicate's expected refusal is then assembled
 * from the contract's own composition — `says[c]` for each `c` the predicate
 * names, in the contract's order — and compared exactly.
 *
 * Exactly, in both directions, is what makes the file decide behaviour: drop a
 * condition from a predicate and the problems it reported disappear; add one
 * and a problem appears that this table did not attribute to it.
 */
const FIXTURES: {
  name: string;
  observation: Observation;
  says: Partial<Record<ConditionId, string[]>>;
}[] = [
  {
    name: "one member of the membership did not answer, and it is the declared target",
    observation: whole(3, {
      statuses: [status(ADDRESSES[0]), status(ADDRESSES[2])],
      declared: [ADDRESSES[1]],
    }),
    says: {
      "member-count": ["1 of 3 member(s) did not answer: 192.0.2.12"],
    },
  },
  {
    name: "two of three members are gone, both declared: below quorum either way",
    observation: whole(3, {
      statuses: [status(ADDRESSES[2])],
      declared: [ADDRESSES[0], ADDRESSES[1]],
    }),
    says: {
      "member-count": [
        "2 of 3 member(s) did not answer: 192.0.2.11, 192.0.2.12",
      ],
      "quorum-present": [
        "only 1 member(s) answered; a 3-member control plane needs a quorum of 2",
        "2 member(s) absent (192.0.2.11, 192.0.2.12) but a 3-member control plane tolerates at most 1",
      ],
    },
  },
  {
    name: "one member is absent and nobody declared it: degraded, not mid-procedure",
    observation: whole(3, {
      statuses: [status(ADDRESSES[0]), status(ADDRESSES[2])],
    }),
    says: {
      "member-count": ["1 of 3 member(s) did not answer: 192.0.2.12"],
      "absences-are-declared": [
        "member(s) 192.0.2.12 are absent and are not a declared target of this operation " +
          "(declared: none) — this cluster is degraded, not mid-procedure",
      ],
    },
  },
  {
    name: "a configured address has no member at all, and every member answered",
    // The unrepresented sense. Quorum holds and nothing is absent, so
    // absences-are-declared is blind to it: only a condition comparing the
    // membership against the derived count can see it.
    observation: whole(3, {
      membership: [ADDRESSES[0], ADDRESSES[1]],
      statuses: [status(ADDRESSES[0]), status(ADDRESSES[1])],
    }),
    says: {
      "member-count": [
        "etcd has 2 member(s) (192.0.2.11, 192.0.2.12) but 3 control-plane address(es) are " +
          "configured (192.0.2.11, 192.0.2.12, 192.0.2.13)",
      ],
      "membership-accounts-for-expected": [
        "control-plane address(es) 192.0.2.13 have no member in etcd's membership at all and are " +
          "not a declared target of this operation (declared: none) — the membership was already " +
          "short before this run, which no absence check can see",
      ],
    },
  },
  {
    name: "etcd reports a member that is not a configured control-plane address",
    // member-count compares SIZES, so a stranger swapped in for a configured
    // address balances it and `whole` says nothing. That is the contract's
    // composition, shared with the Go consumer, and it is exactly why
    // membership-accounts-for-expected does the accounting rather than the
    // counting.
    observation: whole(3, {
      membership: [ADDRESSES[0], ADDRESSES[1], "192.0.2.99"],
      statuses: [
        status(ADDRESSES[0]),
        status(ADDRESSES[1]),
        status("192.0.2.99"),
      ],
    }),
    says: {
      "membership-accounts-for-expected": [
        "control-plane address(es) 192.0.2.13 have no member in etcd's membership at all and are " +
          "not a declared target of this operation (declared: none) — the membership was already " +
          "short before this run, which no absence check can see",
        "etcd has 3 member(s) (192.0.2.11, 192.0.2.12, 192.0.2.99) and 1 configured address(es) " +
          "unrepresented, which does not account for the 3 control-plane address(es) configured " +
          "(192.0.2.11, 192.0.2.12, 192.0.2.13): etcd reports a member that is not a configured " +
          "control-plane address",
      ],
    },
  },
  {
    name: "a member reports a non-empty ERRORS field",
    observation: whole(3, {
      statuses: [
        status(ADDRESSES[0]),
        status(ADDRESSES[1], { errors: "etcdserver: no leader" }),
        status(ADDRESSES[2]),
      ],
    }),
    says: { "no-errors": ["192.0.2.12: ERRORS etcdserver: no leader"] },
  },
  {
    name: "a member is a learner, so it does not vote and does not count",
    observation: whole(3, {
      statuses: [
        status(ADDRESSES[0]),
        status(ADDRESSES[1], { learner: true }),
        status(ADDRESSES[2]),
      ],
    }),
    says: { "no-learners": ["192.0.2.12 is a learner"] },
  },
  {
    name: "the members disagree about which one is leader",
    observation: whole(3, {
      statuses: [
        status(ADDRESSES[0]),
        status(ADDRESSES[1], { leader: "a1b2c3d4e5f60718" }),
        status(ADDRESSES[2]),
      ],
    }),
    says: {
      "single-leader": [
        "members disagree about the leader (3f9a1b2c3d4e5f60, a1b2c3d4e5f60718)",
      ],
    },
  },
  {
    name: "a member is further behind the highest RAFT INDEX than the tolerance",
    observation: whole(3, {
      statuses: [
        status(ADDRESSES[0]),
        status(ADDRESSES[1], { raftIndex: 14870001 }),
        status(ADDRESSES[2]),
      ],
    }),
    says: {
      "raft-index-converged": [
        `192.0.2.12 RAFT INDEX 14870001 is 6321 behind 14876322 (tolerance ${TOPOLOGY.raftIndexTolerance})`,
      ],
    },
  },
];

/** The point whose predicate is `id`, so the gate is driven the way migrate drives it. */
function pointFor(id: string): PointId {
  const point = (
    ["preflight", "before-destructive-step", "completion"] as const
  ).find((p) => TOPOLOGY.predicateAt(p).id === id);
  assert(
    point !== undefined,
    `no evaluation point this consumer uses applies ${id}`,
  );
  return point as PointId;
}

test("this consumer implements every condition the contract declares, and each is exercised", () => {
  // The loader refuses a contract naming a condition it cannot evaluate; this
  // is the other direction. Nothing declared may go unimplemented, and nothing
  // a predicate names may go without a fixture that shows the gate enforcing it.
  const implemented = new Set<ConditionId>(IMPLEMENTED_CONDITIONS);
  for (const predicateId of ["whole", "survivable"]) {
    for (const cond of TOPOLOGY.predicateById(predicateId).conditions) {
      assert(
        implemented.has(cond),
        `predicate ${predicateId} names condition ${cond}, which this consumer does not implement`,
      );
      assert(
        FIXTURES.some((f) => (f.says[cond] ?? []).length > 0),
        `no fixture breaks ${cond}, so nothing here proves the gate enforces it`,
      );
    }
  }
});

test("each predicate refuses exactly the conditions the contract composes into it", () => {
  for (const predicateId of ["whole", "survivable"]) {
    const predicate = TOPOLOGY.predicateById(predicateId);
    const point = pointFor(predicateId);
    for (const fixture of FIXTURES) {
      const expected = predicate.conditions.flatMap(
        (c) => fixture.says[c] ?? [],
      );
      const gate = etcdGate(point, fixture.observation);
      assertEquals(
        gate.ok,
        expected.length === 0,
        `${predicateId} at ${point}, ${fixture.name}: expected ${
          expected.length === 0 ? "a pass" : "a refusal"
        }, got "${gate.detail}"`,
      );
      // The verdict's own list, not the gate's joined detail: a problem may
      // itself contain the separator, and a split would mis-attribute it.
      assertEquals(
        [
          ...evaluatePredicate(TOPOLOGY, predicate, fixture.observation)
            .problems,
        ],
        expected,
        `${predicateId} at ${point}, ${fixture.name}: the refusal must be exactly the problems ` +
          "the conditions this predicate composes report",
      );
    }
  }
});

// ----------------------------------------------------------------------------
// The evaluation points
// ----------------------------------------------------------------------------

test("each gate applies the predicate the contract maps to its point", () => {
  // `whole` immediately before the destructive step aborts every procedure;
  // `survivable` at the door consents to starting on a cluster that was already
  // a member short. Both are one-line edits away, so the mapping is asserted
  // through the gates themselves rather than by reading the file twice.
  const declaredAbsence = whole(3, {
    statuses: [status(ADDRESSES[0]), status(ADDRESSES[2])],
    declared: [ADDRESSES[1]],
  });
  for (const point of ["preflight", "before-destructive-step", "completion"]) {
    const id = point as PointId;
    const gate = etcdGate(id, declaredAbsence);
    const predicate = TOPOLOGY.predicateAt(id);
    assertEquals(gate.name, `etcd is ${predicate.id} at ${id}`);
    assertEquals(
      gate.ok,
      predicate.id === "survivable",
      `at ${id} the contract applies ${predicate.id}: a declared absence must ` +
        `${predicate.id === "survivable" ? "pass" : "refuse"}, got ${gate.detail}`,
    );
  }
});

test("migrate runs the contract's fresh shape, and that shape has no resume gate", () => {
  const shape = TOPOLOGY.runShape(RUN_SHAPE);
  assert(shape !== null, `the contract declares no run shape "${RUN_SHAPE}"`);
  assertEquals(shape!.sequence, [
    "preflight",
    "before-destructive-step",
    "completion",
  ]);
  assert(
    !shape!.sequence.includes("resume"),
    "this consumer never removes an etcd member, so no observation may select resume",
  );
  // Every point of the shape resolves to a predicate this consumer can build a
  // gate from: an unmapped point throws rather than defaulting to something.
  for (const point of shape!.sequence) {
    assert(TOPOLOGY.predicateAt(point).conditions.length > 0);
  }
});

test("an indeterminate reading is unsafe at every point", () => {
  // evaluation.onIndeterminate: silence is never consent on a path that stops a
  // control-plane node, and "nothing was read" is not "nothing is wrong".
  for (const point of ["preflight", "before-destructive-step", "completion"]) {
    assertEquals(
      etcdGate(point as PointId, null, "talosctl: no answer").ok,
      null,
    );
    assertEquals(
      etcdGate(point as PointId, whole(3, { membership: null, statuses: [] }))
        .ok,
      false,
    );
  }
});

// ----------------------------------------------------------------------------
// The loader
// ----------------------------------------------------------------------------

function mutatedContract(
  mutate: (doc: Record<string, unknown>) => void,
): string {
  const doc = parseYaml(readFileSync(TOPOLOGY_CONTRACT_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(doc);
  return stringifyYaml(doc);
}

test("a contract naming a condition this consumer cannot evaluate refuses to load", () => {
  // The same fail-closed rule as the Go loader, and the reason a new
  // health.conditions entry is a coordinated change across both consumers
  // rather than an additive edit to the file. A guard that skips the condition
  // it did not recognise is worse than one that refuses to start.
  let threw: unknown;
  try {
    parseTopologyContract(
      mutatedContract((doc) => {
        const health = doc.health as { conditions: { id: string }[] };
        health.conditions.push({ id: "disk-space-available" });
      }),
    );
  } catch (err) {
    threw = err;
  }
  assert(
    threw instanceof TopologyContractError,
    "a contract with an unimplemented condition must refuse to load",
  );
  assert(
    (threw as Error).message.includes("disk-space-available"),
    "the refusal must name the condition it does not implement",
  );
});

test("a contract asserting the entry point rather than observing it refuses to load", () => {
  // ADR-035 rejected a `--resume` flag. A selector this consumer does not
  // implement is that flag by another name, and loading it as though it were
  // the observed one is how a caller gets `survivable` at the door.
  let threw: unknown;
  try {
    parseTopologyContract(
      mutatedContract((doc) => {
        const evaluation = doc.evaluation as Record<string, unknown>;
        evaluation.entrySelector = "caller-asserted-membership-mode";
      }),
    );
  } catch (err) {
    threw = err;
  }
  assert(
    threw instanceof TopologyContractError,
    "an entry selector this consumer does not implement must refuse to load",
  );
});

test("a predicate naming an undefined condition refuses to load", () => {
  let threw: unknown;
  try {
    parseTopologyContract(
      mutatedContract((doc) => {
        const health = doc.health as {
          conditions: { id: string }[];
          predicates: { id: string; conditions: string[] }[];
        };
        health.conditions = health.conditions.filter(
          (c) => c.id !== "no-learners",
        );
      }),
    );
  } catch (err) {
    threw = err;
  }
  assert(
    threw instanceof TopologyContractError,
    "a predicate composing a condition the contract no longer defines must refuse to load",
  );
});
