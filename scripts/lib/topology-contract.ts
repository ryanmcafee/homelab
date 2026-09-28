/**
 * Reads contracts/cluster/topology.v1.yaml — the normative control-plane
 * topology, etcd quorum rule and health predicates (ADR-035) — for the
 * TypeScript consumer, and evaluates a named predicate over an observation.
 *
 * This is the TypeScript half of internal/topology + internal/etcd.Evaluate.
 * The two exist because one safety rule has two consumers in two languages and
 * a constant in either that restates a value from the file is a review failure
 * (ADR-031). So nothing here hard-codes a member count, a quorum, a raft
 * tolerance, an observation bound, or which predicate guards which evaluation
 * point: every one of those is read from the file. What this module supplies is
 * the implementation of the formulas and the conditions.
 *
 * Fail-closed is a property of the loader, not only of the caller. A contract
 * naming a condition this implementation does not know fails to load rather
 * than silently evaluating a subset — a guard that skips the condition it did
 * not recognise is worse than one that refuses to start.
 *
 * Deliberately NOT here: parsing `talosctl etcd status` / `etcd members`. That
 * is an adapter to one release of one CLI's human-readable table, it is private
 * to whichever binary shells out, and the contract says two of them are
 * acceptable. The caller reduces its own tables to the primitives below.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "./yaml.ts";

/** One health condition atom from `health.conditions`. */
export type ConditionId =
  | "member-count"
  | "quorum-present"
  | "absences-are-declared"
  | "membership-accounts-for-expected"
  | "no-errors"
  | "no-learners"
  | "single-leader"
  | "raft-index-converged";

/**
 * Every condition this consumer can evaluate. The loader rejects a contract
 * naming one outside this set, so extending the contract fails this suite
 * rather than quietly weakening the guard.
 */
export const IMPLEMENTED_CONDITIONS: readonly ConditionId[] = [
  "member-count",
  "quorum-present",
  "absences-are-declared",
  "membership-accounts-for-expected",
  "no-errors",
  "no-learners",
  "single-leader",
  "raft-index-converged",
];

/** An evaluation point from `evaluation.points`. */
export type PointId =
  | "preflight"
  | "before-destructive-step"
  | "resume"
  | "completion";

/**
 * The only entry semantics and selector this consumer implements. A contract
 * declaring anything else refuses to load: reading a different entry rule as
 * this one is how a guard evaluates the door's predicate mid-procedure.
 */
export const ENTRY_EXCLUSIVE = "exclusive";
export const SELECTOR_OBSERVED_MEMBERSHIP =
  "declared-target-present-in-observed-membership";

export interface Predicate {
  readonly id: string;
  readonly summary: string;
  readonly evaluatedOver: string;
  readonly conditions: readonly ConditionId[];
}

export interface QuorumRow {
  readonly count: number;
  readonly quorum: number;
  readonly maxUnavailable: number;
}

export interface RunShape {
  readonly id: string;
  readonly when: string;
  readonly sequence: readonly PointId[];
}

/** Raised for a contract this consumer will not evaluate. */
export class TopologyContractError extends Error {
  override name = "TopologyContractError";
}

/**
 * One `talosctl etcd status` row, reduced to what the conditions read. The
 * caller's parser produces these; the extra columns it keeps are its own.
 */
export interface StatusRow {
  readonly node: string;
  /** This row's own member ID; `leader === member` identifies the leader. */
  readonly member: string;
  /** The member ID this row believes is leader. */
  readonly leader: string;
  readonly raftIndex: number;
  readonly learner: boolean;
  readonly errors: string;
}

/**
 * What one evaluation point actually saw. It is the whole input to a
 * predicate: nothing is read from a constant or from the environment, so a
 * gate is reproducible from its observation alone.
 */
export interface Observation {
  /**
   * The control-plane addresses derived from the ConfigSet. Their COUNT is the
   * expectation the observation is compared against — never the enumeration
   * the member set is built from. A consumer that dials the addresses it
   * derived and then asserts that many answered has restated its own input;
   * see `health.memberSetSource`.
   */
  readonly expected: readonly string[];
  /**
   * etcd's own membership, from `etcd members`: one address per member. This,
   * and not the address list, is the observed member set. Null means the
   * membership could not be read — unknown, not empty.
   */
  readonly membership: readonly string[] | null;
  /**
   * The `etcd status` rows that came back. A member of the observed membership
   * with no row here did not answer.
   */
  readonly statuses: readonly StatusRow[];
  /** The addresses this operation declared as its targets. */
  readonly declared: readonly string[];
  /**
   * Dial, deadline or apid failures encountered while reading. The contract
   * forbids flattening these into "N member(s) answered".
   */
  readonly transportErrors: readonly string[];
  /** When the member set was read (epoch ms), or null when it never was. */
  readonly observedAt: number | null;
  /** Defaults to now; set explicitly to make staleness testable. */
  readonly evaluatedAt?: number;
}

export interface Verdict {
  readonly ok: boolean;
  readonly predicate: string;
  /** The failed conditions, named individually with their arithmetic. */
  readonly problems: readonly string[];
  /** Members of etcd's membership that did not answer. */
  readonly absent: readonly string[];
  /** The absent members this operation did not declare. */
  readonly undeclared: readonly string[];
  /** How many members of etcd's membership reported a status. */
  readonly answered: number;
  /** Configured addresses with no member in etcd's membership at all. */
  readonly unrepresented: readonly string[];
  /** The unrepresented addresses this operation did not declare. */
  readonly unrepresentedUndeclared: readonly string[];
}

interface RawContract {
  version?: number;
  controlPlane?: {
    countKeyPattern?: string;
    permittedCounts?: number[];
    degradedCounts?: number[];
  };
  quorum?: {
    table?: QuorumRow[];
    removalOfLastMember?: string;
    removalOfLastMemberGuidance?: string;
  };
  health?: {
    conditions?: { id?: string }[];
    raftIndexTolerance?: number;
    predicates?: {
      id?: string;
      summary?: string;
      evaluatedOver?: string;
      conditions?: string[];
    }[];
  };
  evaluation?: {
    onIndeterminate?: string;
    maxObservationAgeSeconds?: number;
    observationDeadlineSeconds?: number;
    transportFailureIsNotMemberFailure?: boolean;
    points?: { id?: string; predicate?: string; kind?: string }[];
    entry?: string;
    entryPoints?: string[];
    entrySelector?: string;
    entrySelectorIsObserved?: boolean;
    runShapes?: { id?: string; when?: string; sequence?: string[] }[];
  };
  consumers?: { id?: string; path?: string; conformant?: string }[];
}

/** The validated contract. Construct it with `parseTopologyContract`. */
export class TopologyContract {
  readonly version: number;
  readonly countKeyPattern: string;
  readonly permittedCounts: readonly number[];
  readonly degradedCounts: readonly number[];
  readonly removalOfLastMember: string;
  readonly removalOfLastMemberGuidance: string;
  readonly raftIndexTolerance: number;
  /** `evaluation.maxObservationAgeSeconds`, in milliseconds. */
  readonly maxObservationAgeMs: number;
  /** `evaluation.observationDeadlineSeconds`, in milliseconds. */
  readonly observationDeadlineMs: number;
  readonly onIndeterminate: string;
  readonly transportFailureIsNotMemberFailure: boolean;
  readonly entry: string;
  readonly entrySelector: string;
  readonly entrySelectorIsObserved: boolean;
  readonly quorumTable: readonly QuorumRow[];
  readonly runShapes: readonly RunShape[];
  readonly entryPoints: readonly PointId[];

  private readonly predicates: ReadonlyMap<string, Predicate>;
  private readonly points: ReadonlyMap<string, string>;

  /** @internal — use parseTopologyContract. */
  constructor(fields: {
    version: number;
    countKeyPattern: string;
    permittedCounts: readonly number[];
    degradedCounts: readonly number[];
    removalOfLastMember: string;
    removalOfLastMemberGuidance: string;
    raftIndexTolerance: number;
    maxObservationAgeMs: number;
    observationDeadlineMs: number;
    onIndeterminate: string;
    transportFailureIsNotMemberFailure: boolean;
    entry: string;
    entrySelector: string;
    entrySelectorIsObserved: boolean;
    quorumTable: readonly QuorumRow[];
    runShapes: readonly RunShape[];
    entryPoints: readonly PointId[];
    predicates: ReadonlyMap<string, Predicate>;
    points: ReadonlyMap<string, string>;
  }) {
    this.version = fields.version;
    this.countKeyPattern = fields.countKeyPattern;
    this.permittedCounts = fields.permittedCounts;
    this.degradedCounts = fields.degradedCounts;
    this.removalOfLastMember = fields.removalOfLastMember;
    this.removalOfLastMemberGuidance = fields.removalOfLastMemberGuidance;
    this.raftIndexTolerance = fields.raftIndexTolerance;
    this.maxObservationAgeMs = fields.maxObservationAgeMs;
    this.observationDeadlineMs = fields.observationDeadlineMs;
    this.onIndeterminate = fields.onIndeterminate;
    this.transportFailureIsNotMemberFailure =
      fields.transportFailureIsNotMemberFailure;
    this.entry = fields.entry;
    this.entrySelector = fields.entrySelector;
    this.entrySelectorIsObserved = fields.entrySelectorIsObserved;
    this.quorumTable = fields.quorumTable;
    this.runShapes = fields.runShapes;
    this.entryPoints = fields.entryPoints;
    this.predicates = fields.predicates;
    this.points = fields.points;
  }

  /** `quorum.formula`: the minimum members a cluster of `count` needs. */
  quorum(count: number): number {
    return count <= 0 ? 0 : Math.floor(count / 2) + 1;
  }

  /** `quorum.maxUnavailableFormula`: how many may be absent and keep quorum. */
  maxUnavailable(count: number): number {
    return count <= 0 ? 0 : count - this.quorum(count);
  }

  /**
   * The predicate the contract assigns to an evaluation point. An unmapped
   * point throws rather than defaulting: evaluating the wrong predicate at the
   * wrong moment either aborts every procedure or consents to starting on a
   * degraded cluster, and both are one line away.
   */
  predicateAt(point: PointId): Predicate {
    const id = this.points.get(point);
    if (id === undefined) {
      throw new TopologyContractError(
        `contracts/cluster/topology.v1.yaml declares no predicate for evaluation point "${point}"`,
      );
    }
    return this.predicateById(id);
  }

  predicateById(id: string): Predicate {
    const p = this.predicates.get(id);
    if (p === undefined) {
      throw new TopologyContractError(
        `contracts/cluster/topology.v1.yaml defines no predicate "${id}"`,
      );
    }
    return p;
  }

  /** The contract's worked row for a count, or null when it has none. */
  quorumRow(count: number): QuorumRow | null {
    return this.quorumTable.find((r) => r.count === count) ?? null;
  }

  runShape(id: string): RunShape | null {
    return this.runShapes.find((s) => s.id === id) ?? null;
  }

  isEntryPoint(point: PointId): boolean {
    return this.entryPoints.includes(point);
  }

  /**
   * Validates a derived control-plane count against `permittedCounts` and
   * reports whether the contract calls it degraded.
   *
   * A degraded count is permitted, not healthy: a one-node control plane is a
   * real fork, and the guard says so out loud rather than reporting a cluster
   * with no fault tolerance as fine.
   */
  checkCount(count: number): { degraded: boolean; error: string | null } {
    if (!this.permittedCounts.includes(count)) {
      return {
        degraded: false,
        error:
          `${count} control-plane address(es) are configured, but ` +
          `contracts/cluster/topology.v1.yaml permits only ${this.permittedCounts.join(", ")}: ` +
          "an even member count adds a failure to tolerate without adding one it can survive",
      };
    }
    return { degraded: this.degradedCounts.includes(count), error: null };
  }
}

function required<T>(value: T | undefined | null, field: string): T {
  if (value === undefined || value === null) {
    throw new TopologyContractError(
      `contracts/cluster/topology.v1.yaml is missing ${field}`,
    );
  }
  return value;
}

/** Validates and returns the contract in the given YAML. */
export function parseTopologyContract(text: string): TopologyContract {
  const parsed = parseYaml(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TopologyContractError(
      "contracts/cluster/topology.v1.yaml is not a YAML mapping",
    );
  }
  const raw = parsed as RawContract;
  if (raw.version !== 1) {
    throw new TopologyContractError(
      `topology contract version ${raw.version} is not 1; this consumer implements v1`,
    );
  }

  const cp = required(raw.controlPlane, "controlPlane");
  const quorum = required(raw.quorum, "quorum");
  const health = required(raw.health, "health");
  const evaluation = required(raw.evaluation, "evaluation");

  const quorumTable = required(quorum.table, "quorum.table");
  if (quorumTable.length === 0) {
    throw new TopologyContractError(
      "quorum.table is empty: the formula would have nothing holding it honest",
    );
  }
  const permittedCounts = required(
    cp.permittedCounts,
    "controlPlane.permittedCounts",
  );
  if (permittedCounts.length === 0) {
    throw new TopologyContractError(
      "controlPlane.permittedCounts is empty: no control-plane size would be allowed",
    );
  }

  const declared = new Set<ConditionId>();
  for (const cond of required(health.conditions, "health.conditions")) {
    const id = required(cond.id, "health.conditions[].id");
    if (!IMPLEMENTED_CONDITIONS.includes(id as ConditionId)) {
      throw new TopologyContractError(
        `the topology contract declares health condition "${id}", which this TypeScript consumer ` +
          "does not implement: refusing to load rather than evaluate a guard with a condition missing",
      );
    }
    declared.add(id as ConditionId);
  }

  const predicates = new Map<string, Predicate>();
  for (const p of required(health.predicates, "health.predicates")) {
    const id = required(p.id, "health.predicates[].id");
    const conditions = required(p.conditions, `predicate ${id} conditions`);
    for (const c of conditions) {
      if (!declared.has(c as ConditionId)) {
        throw new TopologyContractError(
          `predicate "${id}" names condition "${c}", which health.conditions does not define`,
        );
      }
    }
    predicates.set(id, {
      id,
      summary: (p.summary ?? "").trim(),
      evaluatedOver: required(p.evaluatedOver, `predicate ${id} evaluatedOver`),
      conditions: conditions as ConditionId[],
    });
  }

  const points = new Map<string, string>();
  for (const pt of required(evaluation.points, "evaluation.points")) {
    const id = required(pt.id, "evaluation.points[].id");
    const predicate = required(
      pt.predicate,
      `evaluation point ${id} predicate`,
    );
    if (!predicates.has(predicate)) {
      throw new TopologyContractError(
        `evaluation point "${id}" names predicate "${predicate}", which the contract does not define`,
      );
    }
    points.set(id, predicate);
  }

  const entry = evaluation.entry ?? "";
  if (entry !== "" && entry !== ENTRY_EXCLUSIVE) {
    throw new TopologyContractError(
      `evaluation.entry is "${entry}"; this consumer implements only "${ENTRY_EXCLUSIVE}"`,
    );
  }
  const entrySelector = evaluation.entrySelector ?? "";
  if (entrySelector !== "" && entrySelector !== SELECTOR_OBSERVED_MEMBERSHIP) {
    throw new TopologyContractError(
      `evaluation.entrySelector is "${entrySelector}"; this consumer implements only ` +
        `"${SELECTOR_OBSERVED_MEMBERSHIP}" — an entry point the caller may assert reintroduces ` +
        "the --resume flag ADR-035 rejected",
    );
  }

  const maxObservationAgeMs =
    required(
      evaluation.maxObservationAgeSeconds,
      "evaluation.maxObservationAgeSeconds",
    ) * 1000;
  const observationDeadlineMs =
    required(
      evaluation.observationDeadlineSeconds,
      "evaluation.observationDeadlineSeconds",
    ) * 1000;
  if (observationDeadlineMs > maxObservationAgeMs) {
    throw new TopologyContractError(
      "evaluation.observationDeadlineSeconds exceeds maxObservationAgeSeconds: a read allowed to " +
        "take longer than a result may live produces a reading that is stale the moment it arrives",
    );
  }

  return new TopologyContract({
    version: raw.version,
    countKeyPattern: required(
      cp.countKeyPattern,
      "controlPlane.countKeyPattern",
    ),
    permittedCounts,
    degradedCounts: cp.degradedCounts ?? [],
    removalOfLastMember: quorum.removalOfLastMember ?? "",
    removalOfLastMemberGuidance: (
      quorum.removalOfLastMemberGuidance ?? ""
    ).trim(),
    raftIndexTolerance: required(
      health.raftIndexTolerance,
      "health.raftIndexTolerance",
    ),
    maxObservationAgeMs,
    observationDeadlineMs,
    onIndeterminate: required(
      evaluation.onIndeterminate,
      "evaluation.onIndeterminate",
    ),
    transportFailureIsNotMemberFailure:
      evaluation.transportFailureIsNotMemberFailure ?? false,
    entry,
    entrySelector,
    entrySelectorIsObserved: evaluation.entrySelectorIsObserved ?? false,
    quorumTable,
    runShapes: (evaluation.runShapes ?? []).map((s) => ({
      id: required(s.id, "evaluation.runShapes[].id"),
      when: (s.when ?? "").trim(),
      sequence: (s.sequence ?? []) as PointId[],
    })),
    entryPoints: (evaluation.entryPoints ?? []) as PointId[],
    predicates,
    points,
  });
}

export const TOPOLOGY_CONTRACT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "contracts",
  "cluster",
  "topology.v1.yaml",
);

let cached: TopologyContract | null = null;

/**
 * The checked-in contract. Reads the real file on first call, so a change to
 * the contract changes what every consumer and every test sees.
 */
export function loadTopologyContract(
  path: string = TOPOLOGY_CONTRACT_PATH,
): TopologyContract {
  if (path === TOPOLOGY_CONTRACT_PATH && cached !== null) return cached;
  const contract = parseTopologyContract(readFileSync(path, "utf8"));
  if (path === TOPOLOGY_CONTRACT_PATH) cached = contract;
  return contract;
}

/**
 * The per-member condition atoms, over the members that answered. One branch
 * per condition id, dispatched from the predicate's own condition list, is
 * what keeps the two consumers honest against each other: a predicate cannot
 * skip a check by being written differently, only by the contract naming
 * fewer conditions.
 */
function conditionProblems(
  cond: ConditionId,
  statuses: readonly StatusRow[],
  tolerance: number,
): string[] {
  const problems: string[] = [];
  switch (cond) {
    case "no-errors":
      for (const m of statuses) {
        if (m.errors !== "") problems.push(`${m.node}: ERRORS ${m.errors}`);
      }
      break;
    case "no-learners":
      for (const m of statuses) {
        if (m.learner) problems.push(`${m.node} is a learner`);
      }
      break;
    case "raft-index-converged": {
      for (const m of statuses) {
        if (!Number.isFinite(m.raftIndex)) {
          problems.push(`${m.node} has no RAFT INDEX`);
        }
      }
      const indices = statuses
        .filter((m) => Number.isFinite(m.raftIndex))
        .map((m) => m.raftIndex);
      if (indices.length > 1) {
        const highest = Math.max(...indices);
        for (const m of statuses) {
          if (
            Number.isFinite(m.raftIndex) &&
            highest - m.raftIndex > tolerance
          ) {
            problems.push(
              `${m.node} RAFT INDEX ${m.raftIndex} is ${highest - m.raftIndex} behind ` +
                `${highest} (tolerance ${tolerance})`,
            );
          }
        }
      }
      break;
    }
    case "single-leader": {
      const leaders = [
        ...new Set(statuses.map((m) => m.leader).filter((l) => l !== "")),
      ].sort();
      if (statuses.length > 0 && leaders.length !== 1) {
        problems.push(
          leaders.length === 0
            ? "no leader reported"
            : `members disagree about the leader (${leaders.join(", ")})`,
        );
      }
      break;
    }
    default:
      break;
  }
  return problems;
}

/**
 * The contract's observation window. A reading older than
 * `maxObservationAgeSeconds` is not "immediately before" anything, so it is
 * indeterminate and must be taken again rather than reused.
 */
function staleness(c: TopologyContract, obs: Observation): string | null {
  if (obs.observedAt === null) {
    return "the member set carries no observation time, so its age cannot be checked";
  }
  const age = (obs.evaluatedAt ?? Date.now()) - obs.observedAt;
  if (age > c.maxObservationAgeMs) {
    return (
      `this reading of etcd is ${Math.round(age / 1000)}s old and the contract allows at most ` +
      `${Math.round(c.maxObservationAgeMs / 1000)}s: a stale observation is indeterminate, so it ` +
      "is taken again rather than acted on"
    );
  }
  return null;
}

/**
 * The fail-closed gate: applies exactly the conditions the contract composes
 * into the given predicate, and anything it could not establish counts against
 * proceeding. An unparseable status table produces no rows, so every member
 * reads as absent and the verdict is not-ok — never "nothing to report".
 */
export function evaluatePredicate(
  c: TopologyContract,
  p: Predicate,
  obs: Observation,
): Verdict {
  // The derived count is the expectation; etcd's membership is the observation.
  // Keeping these apart is what makes member-count able to fail at all.
  const count = obs.expected.length;
  const membership = obs.membership ?? [];
  const answeredAt = new Set(
    obs.statuses.map((s) => s.node).filter((n) => n !== ""),
  );

  const problems: string[] = [];
  const absent: string[] = [];
  const undeclared: string[] = [];
  const unrepresented: string[] = [];
  const unrepresentedUndeclared: string[] = [];
  let answered = 0;

  for (const ip of obs.expected) {
    if (!membership.includes(ip)) {
      unrepresented.push(ip);
      if (!obs.declared.includes(ip)) unrepresentedUndeclared.push(ip);
    }
  }
  for (const ip of membership) {
    if (answeredAt.has(ip)) {
      answered++;
      continue;
    }
    absent.push(ip);
    if (!obs.declared.includes(ip)) undeclared.push(ip);
  }

  // Indeterminate inputs, before any condition. Silence is never consent on a
  // path that stops a control-plane node.
  if (count === 0) {
    problems.push(
      "no control-plane addresses are configured, so there is no expected size to measure against",
    );
  }
  if (obs.membership === null || obs.membership.length === 0) {
    problems.push(
      "etcd reported no membership: the member set is unknown, not empty",
    );
  }
  for (const e of obs.transportErrors) {
    problems.push(
      "could not reach etcd, so this is a transport fault and not a member fault: " +
        e,
    );
  }
  const stale = staleness(c, obs);
  if (stale !== null) problems.push(stale);

  const declaredList =
    obs.declared.length > 0 ? obs.declared.join(", ") : "none";

  for (const cond of p.conditions) {
    switch (cond) {
      case "member-count":
        if (membership.length !== count) {
          problems.push(
            `etcd has ${membership.length} member(s) (${membership.join(", ")}) but ${count} ` +
              `control-plane address(es) are configured (${obs.expected.join(", ")})`,
          );
        }
        if (absent.length > 0) {
          problems.push(
            `${absent.length} of ${membership.length} member(s) did not answer: ${absent.join(", ")}`,
          );
        }
        break;
      case "quorum-present": {
        const q = c.quorum(count);
        if (answered < q) {
          problems.push(
            `only ${answered} member(s) answered; a ${count}-member control plane needs a quorum of ${q}`,
          );
        }
        const mu = c.maxUnavailable(count);
        if (absent.length > mu) {
          problems.push(
            `${absent.length} member(s) absent (${absent.join(", ")}) but a ${count}-member ` +
              `control plane tolerates at most ${mu}`,
          );
        }
        break;
      }
      case "absences-are-declared":
        if (undeclared.length > 0) {
          problems.push(
            `member(s) ${undeclared.join(", ")} are absent and are not a declared target of this ` +
              `operation (declared: ${declaredList}) — this cluster is degraded, not mid-procedure`,
          );
        }
        break;
      case "membership-accounts-for-expected":
        if (unrepresentedUndeclared.length > 0) {
          problems.push(
            `control-plane address(es) ${unrepresentedUndeclared.join(", ")} have no member in ` +
              `etcd's membership at all and are not a declared target of this operation ` +
              `(declared: ${declaredList}) — the membership was already short before this run, ` +
              "which no absence check can see",
          );
        }
        if (membership.length + unrepresented.length !== count) {
          problems.push(
            `etcd has ${membership.length} member(s) (${membership.join(", ")}) and ` +
              `${unrepresented.length} configured address(es) unrepresented, which does not ` +
              `account for the ${count} control-plane address(es) configured ` +
              `(${obs.expected.join(", ")}): etcd reports a member that is not a configured ` +
              "control-plane address",
          );
        }
        break;
      default:
        problems.push(
          ...conditionProblems(cond, obs.statuses, c.raftIndexTolerance),
        );
        break;
    }
  }

  return {
    ok: problems.length === 0,
    predicate: p.id,
    problems,
    absent,
    undeclared,
    answered,
    unrepresented,
    unrepresentedUndeclared,
  };
}
