#!/usr/bin/env -S bun test
/**
 * Unit tests for the event-contract gate: the subject grammar, the internal
 * consistency rules, and the backward-compatibility rules that make a breaking
 * change to contracts/events/ fail CI instead of failing a consumer.
 *
 * The last block runs the rules against the real checked-in contract, so this
 * file is both a unit test and the regression test for the contract itself.
 *
 *   bun test scripts/contract-check_test.ts
 */

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "./lib/assert.ts";
import {
  type BaselineEntry,
  checkCompatibility,
  loadBaseline,
  loadRegistry,
  loadTaxonomy,
  parseSubject,
  type RegisteredType,
  type Registry,
  renderSubject,
  renderViolations,
  streamsFor,
  subjectMatches,
  tailOfType,
  type Taxonomy,
  toBaseline,
  validateRegistry,
} from "./contract-check.ts";

// ============================================================================
// Fixtures — a minimal but structurally real taxonomy and registry
// ============================================================================

const TAXONOMY: Taxonomy = {
  version: 1,
  grammar: {
    pattern:
      "^pf\\.[a-z0-9][a-z0-9-]{0,62}\\.[a-z0-9]+\\.[a-z0-9]+\\.[a-z0-9]+\\.v[1-9][0-9]*\\.(ev|rq|wq|rs)$",
    tokens: 7,
    root: "pf",
  },
  domains: { workload: "workloads", gitops: "argocd" },
  streams: [
    {
      name: "PF_EVENTS",
      subjects: ["pf.*.*.*.*.*.ev"],
      delivery: "at_least_once",
      ordering: "per_subject",
    },
    {
      name: "PF_WORK",
      subjects: ["pf.*.*.*.*.*.wq"],
      delivery: "at_least_once",
      ordering: "none",
    },
  ],
};

const DEPLOYED: RegisteredType = {
  type: "com.mcafeeconsulting.platform.workload.deployment.deployed.v1",
  subject: "pf.<tenant>.workload.deployment.deployed.v1.ev",
  pattern: "pubsub",
  delivery: "at_least_once",
  ordering: "per_subject",
  dataschema: "data/workload.deployment.deployed.v1.schema.json",
  requires: ["subject"],
  producer: "workload-operator",
  status: "stable",
};

const PROMOTE: RegisteredType = {
  type: "com.mcafeeconsulting.platform.workload.deployment.promote.v1",
  subject: "pf.<tenant>.workload.deployment.promote.v1.wq",
  pattern: "request_reply",
  durable_request: true,
  delivery: "at_least_once",
  ordering: "none",
  dataschema: "data/workload.deployment.promote.v1.schema.json",
  requires: ["correlationid", "subject"],
  producer: "platform-api",
  status: "stable",
};

const DESCRIBE: RegisteredType = {
  type: "com.mcafeeconsulting.platform.workload.deployment.describe.v1",
  subject: "pf.<tenant>.workload.deployment.describe.v1.rq",
  pattern: "request_reply",
  durable_request: false,
  delivery: "at_most_once",
  ordering: "none",
  dataschema: "data/workload.deployment.describe.v1.schema.json",
  requires: ["replyto", "correlationid", "subject"],
  producer: "platform-api",
  status: "stable",
};

const registry = (...types: RegisteredType[]): Registry => ({
  version: 1,
  types,
});
const rules = (r: Registry) => validateRegistry(r, TAXONOMY).map((v) => v.rule);
const mutate = (t: RegisteredType, patch: Partial<RegisteredType>) => ({
  ...t,
  ...patch,
});

// ============================================================================
// Subject grammar
// ============================================================================

test("renderSubject substitutes the tenant placeholder", () => {
  assertEquals(
    renderSubject("pf.<tenant>.workload.deployment.deployed.v1.ev", "acme"),
    "pf.acme.workload.deployment.deployed.v1.ev",
  );
});

test("parseSubject splits the seven tokens", () => {
  const p = parseSubject("pf.acme.workload.deployment.deployed.v2.ev");
  assert(p !== null, "expected a parse");
  assertEquals(p?.tenant, "acme");
  assertEquals(p?.domain, "workload");
  assertEquals(p?.entity, "deployment");
  assertEquals(p?.action, "deployed");
  assertEquals(p?.major, "v2");
  assertEquals(p?.suffix, "ev");
});

test("parseSubject rejects a wrong token count or unknown suffix", () => {
  assertEquals(parseSubject("pf.acme.workload.deployed.v1.ev"), null);
  assertEquals(
    parseSubject("pf.acme.workload.deployment.deployed.v1.ev.extra"),
    null,
  );
  assertEquals(
    parseSubject("pf.acme.workload.deployment.deployed.v1.xx"),
    null,
  );
});

test("tailOfType reads domain, entity and action from the type", () => {
  assertEquals(
    tailOfType("com.mcafeeconsulting.platform.workload.deployment.deployed.v1"),
    { domain: "workload", entity: "deployment", action: "deployed" },
  );
});

test("subjectMatches implements NATS * and > wildcards", () => {
  assert(
    subjectMatches(
      "pf.*.*.*.*.*.ev",
      "pf.acme.workload.deployment.deployed.v1.ev",
    ),
  );
  assert(
    !subjectMatches(
      "pf.*.*.*.*.*.ev",
      "pf.acme.workload.deployment.promote.v1.wq",
    ),
  );
  // `*` is exactly one token, so a wildcard filter cannot swallow a deeper subject.
  assert(
    !subjectMatches("pf.*.workload.*.*.*.ev", "pf.acme.workload.a.b.c.v1.ev"),
  );
  assert(
    subjectMatches("pf.acme.>", "pf.acme.workload.deployment.deployed.v1.ev"),
  );
  assert(!subjectMatches("pf.acme.>", "pf.acme"));
});

test("streamsFor finds every covering stream, including overlaps", () => {
  const overlapping: Taxonomy = {
    ...TAXONOMY,
    streams: [
      ...TAXONOMY.streams,
      {
        name: "PF_AUDIT",
        subjects: ["pf.*.workload.*.*.*.ev"],
        delivery: "at_least_once",
        ordering: "per_subject",
      },
    ],
  };
  const names = streamsFor(
    overlapping,
    "pf.t0.workload.deployment.deployed.v1.ev",
  ).map((s) => s.name);
  assertEquals(names, ["PF_EVENTS", "PF_AUDIT"]);
});

// ============================================================================
// Internal consistency
// ============================================================================

test("a well-formed registry produces no violations", () => {
  assertEquals(rules(registry(DEPLOYED, PROMOTE, DESCRIBE)), []);
});

test("a subject that breaks the grammar is rejected", () => {
  const bad = mutate(DEPLOYED, {
    subject: "pf.<tenant>.workload.deployed.v1.ev",
  });
  assert(rules(registry(bad)).includes("subject-grammar"));
});

test("an undeclared domain is rejected", () => {
  const bad = mutate(DEPLOYED, {
    type: "com.mcafeeconsulting.platform.billing.invoice.deployed.v1",
    subject: "pf.<tenant>.billing.invoice.deployed.v1.ev",
  });
  assert(rules(registry(bad)).includes("unknown-domain"));
});

test("the type version and the subject version must agree", () => {
  const bad = mutate(DEPLOYED, {
    type: "com.mcafeeconsulting.platform.workload.deployment.deployed.v2",
  });
  assert(rules(registry(bad)).includes("version-mismatch"));
});

test("the type tail and the subject tokens must agree", () => {
  const bad = mutate(DEPLOYED, {
    type: "com.mcafeeconsulting.platform.workload.deployment.rolledout.v1",
  });
  assert(rules(registry(bad)).includes("action-mismatch"));
  const bad2 = mutate(DEPLOYED, {
    type: "com.mcafeeconsulting.platform.workload.replicaset.deployed.v1",
  });
  assert(rules(registry(bad2)).includes("entity-mismatch"));
});

test("pub/sub may not claim anything but at-least-once, per-subject", () => {
  const r = rules(
    registry(mutate(DEPLOYED, { delivery: "at_most_once", ordering: "none" })),
  );
  assert(r.includes("pubsub-delivery"));
  assert(r.includes("pubsub-ordering"));
});

test("exactly-once is not an offered guarantee", () => {
  const bad = mutate(DEPLOYED, {
    delivery: "exactly_once" as unknown as RegisteredType["delivery"],
  });
  assert(rules(registry(bad)).includes("delivery-guarantee"));
});

test("the subject suffix must match the pattern and durability", () => {
  // A durable request published on the synchronous `rq` suffix.
  const bad = mutate(PROMOTE, {
    subject: "pf.<tenant>.workload.deployment.promote.v1.rq",
  });
  assert(rules(registry(bad)).includes("suffix-mismatch"));
});

test("a durable request must be at-least-once and a synchronous one at-most-once", () => {
  assert(
    rules(registry(mutate(PROMOTE, { delivery: "at_most_once" }))).includes(
      "durable-request-delivery",
    ),
  );
  assert(
    rules(registry(mutate(DESCRIBE, { delivery: "at_least_once" }))).includes(
      "core-request-delivery",
    ),
  );
});

test("a synchronous request must require replyto and correlationid", () => {
  const r = rules(registry(mutate(DESCRIBE, { requires: ["subject"] })));
  assert(r.includes("replyto-required"));
  assert(r.includes("correlationid-required"));
});

test("request_reply must declare durable_request; pubsub must not", () => {
  const noDurability = { ...DESCRIBE };
  delete (noDurability as Partial<RegisteredType>).durable_request;
  assert(rules(registry(noDurability)).includes("durable-request-missing"));
  assert(
    rules(registry(mutate(DEPLOYED, { durable_request: true }))).includes(
      "durable-request-on-pubsub",
    ),
  );
});

test("a type with a body must publish a dataschema", () => {
  const bare = { ...DEPLOYED };
  delete (bare as Partial<RegisteredType>).dataschema;
  assert(rules(registry(bare)).includes("dataschema-required"));
  // …unless it is explicitly dataless.
  assert(
    !rules(registry({ ...bare, dataless: true })).includes(
      "dataschema-required",
    ),
  );
});

test("an event subject no stream covers is a violation", () => {
  const orphan: Taxonomy = { ...TAXONOMY, streams: [TAXONOMY.streams[1]!] };
  const found = validateRegistry(registry(DEPLOYED), orphan).map((v) => v.rule);
  assert(found.includes("no-stream"));
});

test("a synchronous request captured by a stream is a violation", () => {
  const greedy: Taxonomy = {
    ...TAXONOMY,
    streams: [
      {
        name: "PF_WORK",
        subjects: ["pf.*.*.*.*.*.rq"],
        delivery: "at_least_once",
        ordering: "none",
      },
    ],
  };
  const found = validateRegistry(registry(DESCRIBE), greedy).map((v) => v.rule);
  assert(found.includes("synchronous-request-persisted"));
});

test("duplicate types and duplicate subjects are rejected", () => {
  const r = rules(registry(DEPLOYED, DEPLOYED));
  assert(r.includes("duplicate-type"));
  assert(r.includes("duplicate-subject"));
});

// ============================================================================
// Backward compatibility
// ============================================================================

const baselineOf = (...types: RegisteredType[]): BaselineEntry[] =>
  toBaseline(registry(...types));

const compat = (before: RegisteredType[], after: RegisteredType[]) =>
  checkCompatibility(baselineOf(...before), registry(...after)).map(
    (v) => v.rule,
  );

test("an unchanged registry is compatible", () => {
  assertEquals(compat([DEPLOYED, PROMOTE], [DEPLOYED, PROMOTE]), []);
});

test("adding a type is additive", () => {
  assertEquals(compat([DEPLOYED], [DEPLOYED, PROMOTE]), []);
});

test("adding a new major alongside the old one is additive", () => {
  const v2 = mutate(DEPLOYED, {
    type: "com.mcafeeconsulting.platform.workload.deployment.deployed.v2",
    subject: "pf.<tenant>.workload.deployment.deployed.v2.ev",
    dataschema: "data/workload.deployment.deployed.v2.schema.json",
    requires: ["subject", "correlationid"],
  });
  assertEquals(compat([DEPLOYED], [DEPLOYED, v2]), []);
  // …and this is the whole point: v2 is only additive while v1 stays published.
  assertEquals(compat([DEPLOYED], [v2]), ["removed-stable-type"]);
});

test("removing a stable type is breaking", () => {
  assertEquals(compat([DEPLOYED, PROMOTE], [PROMOTE]), ["removed-stable-type"]);
});

test("moving a subject within the same major is breaking", () => {
  const moved = mutate(DEPLOYED, {
    subject: "pf.<tenant>.gitops.deployment.deployed.v1.ev",
  });
  assert(compat([DEPLOYED], [moved]).includes("subject-moved"));
});

test("weakening the delivery guarantee is breaking; strengthening it is not", () => {
  const weaker = mutate(DESCRIBE, { delivery: "at_most_once" });
  const stronger = mutate(DESCRIBE, { delivery: "at_least_once" });
  assert(compat([stronger], [weaker]).includes("delivery-weakened"));
  assertEquals(compat([weaker], [stronger]), []);
});

test("weakening ordering is breaking", () => {
  const unordered = mutate(DEPLOYED, { ordering: "none" });
  assert(compat([DEPLOYED], [unordered]).includes("ordering-weakened"));
});

test("swapping the data schema in place is breaking", () => {
  const swapped = mutate(DEPLOYED, {
    dataschema: "data/something.else.v1.schema.json",
  });
  assert(compat([DEPLOYED], [swapped]).includes("dataschema-replaced"));
});

test("newly requiring an envelope attribute is breaking; dropping one is not", () => {
  const stricter = mutate(DEPLOYED, { requires: ["subject", "correlationid"] });
  assert(compat([DEPLOYED], [stricter]).includes("required-attribute-added"));
  const looser = mutate(DEPLOYED, { requires: [] });
  assertEquals(compat([DEPLOYED], [looser]), []);
});

test("changing the interaction pattern is breaking", () => {
  const repatterned = mutate(DEPLOYED, {
    pattern: "request_reply",
    durable_request: true,
  });
  assert(compat([DEPLOYED], [repatterned]).includes("pattern-changed"));
});

test("experimental types are outside the compatibility gate", () => {
  const experimental = mutate(DEPLOYED, { status: "experimental" });
  assertEquals(baselineOf(experimental), []);
  assertEquals(compat([experimental], []), []);
});

test("renderViolations prints the rule key so CI output can be grepped", () => {
  const out = renderViolations(
    checkCompatibility(baselineOf(DEPLOYED, PROMOTE), registry(PROMOTE)),
  );
  assertStringIncludes(out, "removed-stable-type");
  assertStringIncludes(out, DEPLOYED.type);
  assertEquals(renderViolations([]), "contract ok");
});

// ============================================================================
// The real contract in contracts/events/
// ============================================================================

test("the checked-in contract is internally consistent", () => {
  assertEquals(
    renderViolations(validateRegistry(loadRegistry(), loadTaxonomy())),
    "contract ok",
  );
});

test("the checked-in contract is compatible with its baseline", () => {
  assertEquals(
    renderViolations(checkCompatibility(loadBaseline(), loadRegistry())),
    "contract ok",
  );
});

test("the baseline file is in sync with the registry", () => {
  // Guards the failure mode where someone edits registry.v1.yaml additively and
  // forgets `bun scripts/contract-check.ts baseline --write`; the next breaking
  // change would then be diffed against a stale, permissive baseline.
  assertEquals(loadBaseline(), toBaseline(loadRegistry()));
});
