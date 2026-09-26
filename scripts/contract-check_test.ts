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
  type Baseline,
  type BaselinePayload,
  checkCompatibility,
  checkEnvelopeCompatibility,
  checkPayloadCompatibility,
  checkTaxonomyCompatibility,
  deadLetterSubjectOf,
  durationSeconds,
  type Envelope,
  filterCovers,
  filtersOverlap,
  loadBaseline,
  loadEnvelope,
  loadPayloads,
  loadRegistry,
  loadTaxonomy,
  narrowedLengthBounds,
  parseSubject,
  type PayloadSchema,
  toBaselinePayload,
  type RegisteredType,
  type Registry,
  renderSubject,
  renderViolations,
  type Stream,
  streamsFor,
  subjectMatches,
  tailOfType,
  type Taxonomy,
  toBaseline,
  validateRegistry,
  validateTaxonomy,
} from "./contract-check.ts";

// ============================================================================
// Fixtures — a minimal but structurally real taxonomy and registry
// ============================================================================

const stream = (p: Partial<Stream> & { name: string }): Stream => ({
  subjects: [],
  replicas: "<replicas>",
  retention: "limits",
  max_age: "168h",
  discard: "old",
  delivery: "at_least_once",
  ordering: "per_subject",
  ...p,
});

const TAXONOMY: Taxonomy = {
  version: 1,
  grammar: {
    pattern:
      "^pf\\.[a-z0-9][a-z0-9-]{0,62}\\.[a-z0-9]+(-[a-z0-9]+)*\\.[a-z0-9]+(-[a-z0-9]+)*\\.[a-z0-9]+(-[a-z0-9]+)*\\.v[1-9][0-9]*\\.(ev|rq|wq|dl)$",
    tokens: 7,
    root: "pf",
  },
  domains: { workload: "workloads", gitops: "argocd" },
  streams: [
    stream({ name: "PF_EVENTS", subjects: ["pf.*.*.*.*.*.ev"] }),
    stream({
      name: "PF_WORK",
      subjects: ["pf.*.*.*.*.*.wq"],
      retention: "workqueue",
      max_age: "24h",
      discard: "new",
      ordering: "none",
    }),
    stream({ name: "PF_DLQ", subjects: ["pf.*.*.*.*.*.dl"], max_age: "720h" }),
  ],
};

const ENVELOPE: Envelope = {
  required: ["id", "source", "type"],
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      pattern:
        "^com\\.mcafeeconsulting\\.platform\\.[a-z0-9]+(-[a-z0-9]+)*(\\.[a-z0-9]+(-[a-z0-9]+)*)*\\.v[1-9][0-9]*$",
    },
    // The length window the real envelope declares on these two. `source` is
    // the M19 repro below; `id` is the only attribute with both bounds.
    id: { type: "string", minLength: 1, maxLength: 128 },
    source: { type: "string", maxLength: 253 },
    time: { type: "string", format: "date-time" },
    specversion: { const: "1.0" },
    // Optional, and the attribute `consumers.ordering_reality` tells every
    // consumer to rely on — so the one most worth pinning.
    sequence: { type: "string", pattern: "^[0-9]{1,20}$" },
  },
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
  delivery: "at_least_once",
  ordering: "none",
  dataschema: "data/workload.deployment.promote.v1.schema.json",
  requires: ["correlationid", "subject"],
  completion: "com.mcafeeconsulting.platform.workload.deployment.promoted.v1",
  producer: "platform-api",
  status: "stable",
};

/** The completion half of PROMOTE: a `wq` request has no synchronous reply. */
const PROMOTED: RegisteredType = {
  type: "com.mcafeeconsulting.platform.workload.deployment.promoted.v1",
  subject: "pf.<tenant>.workload.deployment.promoted.v1.ev",
  pattern: "pubsub",
  delivery: "at_least_once",
  ordering: "per_subject",
  dataschema: "data/workload.deployment.promoted.v1.schema.json",
  requires: ["subject", "correlationid"],
  producer: "workload-operator",
  status: "stable",
};

const DESCRIBE: RegisteredType = {
  type: "com.mcafeeconsulting.platform.workload.deployment.describe.v1",
  subject: "pf.<tenant>.workload.deployment.describe.v1.rq",
  pattern: "request_reply",
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
const rules = (r: Registry) =>
  validateRegistry(r, TAXONOMY, ENVELOPE).map((v) => v.rule);
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
  assertEquals(rules(registry(DEPLOYED, PROMOTE, PROMOTED, DESCRIBE)), []);
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

test("the subject suffix must match the interaction pattern", () => {
  // pubsub is `ev`, request_reply is `wq` or `rq`. Which of the two a
  // request_reply is is no longer declared anywhere — it IS the suffix.
  assert(
    rules(
      registry(
        mutate(DEPLOYED, {
          subject: "pf.<tenant>.workload.deployment.deployed.v1.wq",
        }),
      ),
    ).includes("suffix-mismatch"),
  );
  assert(
    rules(
      registry(
        mutate(DESCRIBE, {
          subject: "pf.<tenant>.workload.deployment.describe.v1.ev",
        }),
      ),
    ).includes("suffix-mismatch"),
  );
});

test("moving a durable request onto the synchronous suffix is caught", () => {
  // It is no longer a `suffix-mismatch` — `rq` is a legal request_reply suffix
  // — but every consequence of the move now fires instead, which is the point:
  // the suffix decides the guarantee rather than restating a flag.
  const moved = mutate(PROMOTE, {
    subject: "pf.<tenant>.workload.deployment.promote.v1.rq",
  });
  const r = rules(registry(moved, PROMOTED));
  assert(r.includes("core-request-delivery")); // rq is at_most_once
  assert(r.includes("replyto-required")); // rq must carry a reply inbox
  assert(r.includes("completion-on-synchronous-request")); // rq replies, not completes
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

test("durability is read off the subject suffix, not declared twice", () => {
  // There is no `durable_request` field to disagree with the suffix any more.
  // `wq` IS durable and `rq` is not, and the delivery rules follow from that
  // alone — so the class of drift those three old rules existed to reconcile
  // cannot occur (ADR-038).
  assertEquals(rules(registry(PROMOTE, PROMOTED)), []);
  assertEquals(rules(registry(DESCRIBE)), []);
});

test("a durable request must name a registered, correlated `.ev` completion", () => {
  const orphan = { ...PROMOTE };
  delete (orphan as Partial<RegisteredType>).completion;
  assert(rules(registry(orphan)).includes("completion-required"));

  // A `wq` request with no completion and no reply leaves the requester with no
  // way to learn the work finished; that is a hole in the pattern, not a doc gap.
  assert(rules(registry(PROMOTE)).includes("completion-unregistered"));

  const syncCompletion = mutate(PROMOTED, {
    subject: "pf.<tenant>.workload.deployment.promoted.v1.rq",
  });
  assert(
    rules(registry(PROMOTE, syncCompletion)).includes("completion-not-event"),
  );

  const uncorrelated = mutate(PROMOTED, { requires: ["subject"] });
  assert(
    rules(registry(PROMOTE, uncorrelated)).includes("completion-uncorrelated"),
  );

  // An inbox does not survive the wait that made the request durable.
  assert(
    rules(
      registry(mutate(PROMOTE, { requires: ["correlationid", "replyto"] })),
    ).includes("durable-request-replyto"),
  );
});

test("a `dl` subject is derived, never registered as a type's own subject", () => {
  const bad = mutate(PROMOTE, {
    subject: "pf.<tenant>.workload.deployment.promote.v1.dl",
  });
  assert(rules(registry(bad)).includes("dead-letter-not-registerable"));
  assertEquals(
    deadLetterSubjectOf("pf.t0.workload.deployment.promote.v1.wq"),
    "pf.t0.workload.deployment.promote.v1.dl",
  );
});

test("a `wq` type with nowhere to dead-letter has no failure path", () => {
  const noDlq: Taxonomy = {
    ...TAXONOMY,
    streams: TAXONOMY.streams.filter((s) => s.name !== "PF_DLQ"),
  };
  const found = validateRegistry(
    registry(PROMOTE, PROMOTED),
    noDlq,
    ENVELOPE,
  ).map((v) => v.rule);
  assert(found.includes("no-dead-letter-stream"));
});

test("a hard-coded tenant in a NEW type is rejected", () => {
  // The baseline cannot catch this: it only pins subjects it has already seen.
  const forked = mutate(DEPLOYED, {
    type: "com.mcafeeconsulting.platform.workload.deployment.deployed.v1",
    subject: "pf.someprodcluster.workload.deployment.deployed.v1.ev",
  });
  assert(rules(registry(forked)).includes("tenant-placeholder"));
});

test("a registry type the envelope schema would reject at runtime is rejected here", () => {
  const bad = mutate(DEPLOYED, {
    type: "com.example.workload.deployment.deployed.v1",
  });
  assert(rules(registry(bad)).includes("type-pattern"));
});

test("hyphens are legal inside a token and do not change the token count", () => {
  const hyphenated = mutate(DEPLOYED, {
    type: "com.mcafeeconsulting.platform.workload.analysis-run.step-completed.v1",
    subject: "pf.<tenant>.workload.analysis-run.step-completed.v1.ev",
  });
  assertEquals(rules(registry(hyphenated)), []);
  assertEquals(
    parseSubject("pf.t0.workload.analysis-run.step-completed.v1.ev")?.entity,
    "analysis-run",
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
  // But not both: a type either has a body with a published shape, or no body.
  assert(
    rules(registry({ ...DEPLOYED, dataless: true })).includes(
      "dataless-with-dataschema",
    ),
  );
});

test("a dataschema that does not resolve to a file is rejected", () => {
  // Every registered dataschema once pointed at a file that did not exist, and
  // the gate was green: "a payload whose shape is not published is not a
  // contract" has to be enforced, not asserted.
  const found = validateRegistry(
    registry(DEPLOYED),
    TAXONOMY,
    ENVELOPE,
    "contracts/events",
  ).map((v) => v.rule);
  assert(found.includes("dataschema-missing-file"));
});

test("an event subject no stream covers is a violation", () => {
  const orphan: Taxonomy = { ...TAXONOMY, streams: [TAXONOMY.streams[1]!] };
  const found = validateRegistry(registry(DEPLOYED), orphan, ENVELOPE).map(
    (v) => v.rule,
  );
  assert(found.includes("no-stream"));
});

test("a `wq` type claiming a guarantee its stream does not offer is rejected", () => {
  // This rule used to run for `pattern: pubsub` only, so exactly the durable
  // path it mattered most on was unchecked.
  const weakWork: Taxonomy = {
    ...TAXONOMY,
    streams: TAXONOMY.streams.map((s) =>
      s.name === "PF_WORK" ? { ...s, delivery: "at_most_once" as const } : s,
    ),
  };
  const found = validateRegistry(
    registry(PROMOTE, PROMOTED),
    weakWork,
    ENVELOPE,
  ).map((v) => v.rule);
  assert(found.includes("stream-delivery-mismatch"));
});

test("a synchronous request captured by a stream is a violation", () => {
  const greedy: Taxonomy = {
    ...TAXONOMY,
    streams: [stream({ name: "PF_WORK", subjects: ["pf.*.*.*.*.*.rq"] })],
  };
  const found = validateRegistry(registry(DESCRIBE), greedy, ENVELOPE).map(
    (v) => v.rule,
  );
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

const baselineOf = (...types: RegisteredType[]): Baseline =>
  toBaseline(registry(...types), TAXONOMY, ENVELOPE);

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

test("changing a type's required attributes is breaking in BOTH directions", () => {
  const stricter = mutate(DEPLOYED, { requires: ["subject", "correlationid"] });
  assert(compat([DEPLOYED], [stricter]).includes("required-attribute-added"));

  // Dropping one used to pass. The gate reasoned only from the producer's side
  // — "existing producers do not set them" — and missed that `requires` is
  // equally a promise TO CONSUMERS that the attribute is always present, which
  // is why they do not null-check it.
  const looser = mutate(DEPLOYED, { requires: [] });
  assert(compat([DEPLOYED], [looser]).includes("required-attribute-removed"));
});

test("demoting a stable type to experimental is breaking", () => {
  // It used to be invisible: `status` was not in the baseline, so the demotion
  // passed, and the next legitimate `baseline --write` then dropped the type
  // from the baseline entirely and left every later change to it unguarded.
  const demoted = mutate(DEPLOYED, { status: "experimental" });
  assert(compat([DEPLOYED], [demoted]).includes("status-demoted"));
});

test("emptying a type's body with dataless is breaking", () => {
  const bodyless = { ...DEPLOYED, dataless: true };
  delete (bodyless as Partial<RegisteredType>).dataschema;
  assert(compat([DEPLOYED], [bodyless]).includes("body-removed"));
});

test("reassigning a type's producer is breaking", () => {
  // `producer` is a trust boundary: publish permission is granted per subject
  // prefix to that component's credential, so reassigning it silently moves the
  // grant. It needs an ADR, not a passing gate.
  const stolen = mutate(DEPLOYED, { producer: "some-other-component" });
  assert(compat([DEPLOYED], [stolen]).includes("producer-reassigned"));
});

test("repointing a durable request's completion type is breaking", () => {
  const repointed = mutate(PROMOTE, {
    completion: "com.mcafeeconsulting.platform.workload.deployment.deployed.v1",
  });
  assert(
    compat([PROMOTE, PROMOTED], [repointed, PROMOTED, DEPLOYED]).includes(
      "completion-changed",
    ),
  );
});

test("changing the interaction pattern is breaking", () => {
  const repatterned = mutate(DEPLOYED, { pattern: "request_reply" });
  assert(compat([DEPLOYED], [repatterned]).includes("pattern-changed"));
});

test("experimental types are outside the compatibility gate", () => {
  const experimental = mutate(DEPLOYED, { status: "experimental" });
  assertEquals(baselineOf(experimental).types, []);
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
// The stream set, the envelope and the grammar
//
// None of these were in the baseline. Six breaking changes walked past the gate
// green because of it, and one stream in the set could not be created at all.
// ============================================================================

const taxonomyWith = (...streams: Stream[]): Taxonomy => ({
  ...TAXONOMY,
  streams,
});
const taxRules = (t: Taxonomy) => validateTaxonomy(t).map((v) => v.rule);

test("two streams with overlapping subject filters cannot both be created", () => {
  // `nats stream add PF_AUDIT --subjects 'pf.*.identity.*.*.*.ev,...'` against a
  // real nats-server: "subjects overlap with an existing stream (10065)". The
  // audit stream as first specified did not merely duplicate deliveries — it
  // did not exist. This rule is why the gate can no longer be green about that.
  const overlapping = taxonomyWith(
    stream({ name: "PF_EVENTS", subjects: ["pf.*.*.*.*.*.ev"] }),
    stream({
      name: "PF_AUDIT",
      subjects: ["pf.*.identity.*.*.*.ev", "pf.*.control.*.*.*.ev"],
    }),
  );
  assert(taxRules(overlapping).includes("stream-subject-overlap"));

  // The fix: PF_AUDIT ingests nothing of its own and sources from PF_EVENTS.
  const sourced = taxonomyWith(
    stream({ name: "PF_EVENTS", subjects: ["pf.*.*.*.*.*.ev"] }),
    stream({
      name: "PF_AUDIT",
      subjects: [],
      max_age: "8760h",
      discard: "new",
      sources: [
        {
          name: "PF_EVENTS",
          filters: ["pf.*.identity.*.*.*.ev", "pf.*.control.*.*.*.ev"],
        },
      ],
    }),
  );
  assertEquals(taxRules(sourced), []);
});

test("filtersOverlap is the 10065 rule, not a string comparison", () => {
  assert(filtersOverlap("pf.*.*.*.*.*.ev", "pf.*.identity.*.*.*.ev"));
  assert(filtersOverlap("pf.>", "pf.a.b.c.d.e.ev"));
  assert(filtersOverlap("pf.*.a.b.c.v1.ev", "pf.t0.a.b.c.v1.ev"));
  assert(!filtersOverlap("pf.*.*.*.*.*.ev", "pf.*.*.*.*.*.wq"));
  assert(!filtersOverlap("pf.*.identity.*.*.*.ev", "pf.*.workload.*.*.*.ev"));
  assert(!filtersOverlap("pf.a.b", "pf.a.b.c"));
});

test("filterCovers tells an additive filter change from a narrowing one", () => {
  assert(filterCovers("pf.*.*.*.*.*.ev", "pf.*.identity.*.*.*.ev"));
  assert(filterCovers("pf.>", "pf.*.*.*.*.*.ev"));
  assert(!filterCovers("pf.*.identity.*.*.*.ev", "pf.*.*.*.*.*.ev"));
  assert(!filterCovers("pf.*.a.b.c.v1.ev", "pf.>"));
});

test("a sourced stream may only mirror what its upstream captures", () => {
  const bad = taxonomyWith(
    stream({ name: "PF_EVENTS", subjects: ["pf.*.*.*.*.*.ev"] }),
    stream({
      name: "PF_AUDIT",
      sources: [{ name: "PF_EVENTS", filters: ["pf.*.identity.*.*.*.wq"] }],
    }),
  );
  assert(taxRules(bad).includes("source-filter-uncovered"));

  const unknown = taxonomyWith(
    stream({
      name: "PF_AUDIT",
      sources: [{ name: "PF_NOPE", filters: ["pf.*.*.*.*.*.ev"] }],
    }),
  );
  assert(taxRules(unknown).includes("source-stream-unknown"));
});

test("a hard-coded replicas breaks the fork-ability contract at stream one", () => {
  // "replicas > 1 not supported in non-clustered mode (10074)" — a stranger
  // forking onto a single-node box could not create ANY of the three streams.
  const pinned = taxonomyWith(
    stream({ name: "PF_EVENTS", subjects: ["pf.*.*.*.*.*.ev"], replicas: 3 }),
  );
  assert(taxRules(pinned).includes("replicas-hardcoded"));
});

test("a stream that ingests nothing at all is rejected", () => {
  assert(
    taxRules(taxonomyWith(stream({ name: "PF_VOID" }))).includes(
      "stream-ingests-nothing",
    ),
  );
});

test("grammar.tokens is load-bearing, not decorative", () => {
  // It was never read: `parseSubject` hard-coded 7, so `tokens: 8` changed
  // nothing and nothing noticed.
  const eight: Taxonomy = {
    ...TAXONOMY,
    grammar: { ...TAXONOMY.grammar, tokens: 8 },
  };
  assert(taxRules(eight).includes("grammar-token-count"));
});

test("the subject grammar is pinned by the baseline", () => {
  // `validateRegistry` compiles the grammar from the file under test, so a
  // loosened grammar — an eighth suffix, a different root — validates happily
  // against itself. Only the baseline can catch that.
  const base = baselineOf(DEPLOYED);
  const loosened: Taxonomy = {
    ...TAXONOMY,
    grammar: { ...TAXONOMY.grammar, pattern: "^pf\\..*$" },
  };
  const found = checkTaxonomyCompatibility(base, loosened).map((v) => v.rule);
  assert(found.includes("grammar-changed"));
});

test("shortening a retention or narrowing a filter is breaking", () => {
  const base = baselineOf(DEPLOYED);

  // 7d -> 1h destroys the replayability the contract promises. `no-stream` only
  // fires when NOTHING matches, so this passed.
  const shortened = taxonomyWith(
    stream({ name: "PF_EVENTS", subjects: ["pf.*.*.*.*.*.ev"], max_age: "1h" }),
    ...TAXONOMY.streams.slice(1),
  );
  assert(
    checkTaxonomyCompatibility(base, shortened)
      .map((v) => v.rule)
      .includes("retention-shortened"),
  );

  const narrowed = taxonomyWith(
    stream({ name: "PF_EVENTS", subjects: ["pf.*.identity.*.*.*.ev"] }),
    ...TAXONOMY.streams.slice(1),
  );
  assert(
    checkTaxonomyCompatibility(base, narrowed)
      .map((v) => v.rule)
      .includes("stream-filter-narrowed"),
  );

  const dropped = taxonomyWith(...TAXONOMY.streams.slice(1));
  assert(
    checkTaxonomyCompatibility(base, dropped)
      .map((v) => v.rule)
      .includes("stream-removed"),
  );

  assertEquals(checkTaxonomyCompatibility(base, TAXONOMY), []);
});

test("silently stopping an audit mirror is breaking", () => {
  const audited = taxonomyWith(
    ...TAXONOMY.streams,
    stream({
      name: "PF_AUDIT",
      max_age: "8760h",
      sources: [
        {
          name: "PF_EVENTS",
          filters: ["pf.*.control.*.*.*.ev", "pf.*.identity.*.*.*.ev"],
        },
      ],
    }),
  );
  const base = toBaseline(registry(DEPLOYED), audited, ENVELOPE);

  const halfAudited = taxonomyWith(
    ...TAXONOMY.streams,
    stream({
      name: "PF_AUDIT",
      max_age: "8760h",
      sources: [{ name: "PF_EVENTS", filters: ["pf.*.identity.*.*.*.ev"] }],
    }),
  );
  assert(
    checkTaxonomyCompatibility(base, halfAudited)
      .map((v) => v.rule)
      .includes("stream-source-narrowed"),
  );
});

test("changing a stream's retention model or discard policy is breaking", () => {
  const base = baselineOf(DEPLOYED);
  const rewritten = taxonomyWith(
    stream({
      name: "PF_EVENTS",
      subjects: ["pf.*.*.*.*.*.ev"],
      retention: "workqueue",
      discard: "new",
    }),
    ...TAXONOMY.streams.slice(1),
  );
  const found = checkTaxonomyCompatibility(base, rewritten).map((v) => v.rule);
  assert(found.includes("stream-retention-changed"));
  assert(found.includes("stream-discard-changed"));
});

test("durationSeconds parses the Go-style durations the stream set uses", () => {
  assertEquals(durationSeconds("24h"), 86400);
  assertEquals(durationSeconds("2m"), 120);
  assertEquals(durationSeconds("720h"), 2592000);
  assertEquals(durationSeconds("8760h"), 31536000);
  assertEquals(durationSeconds(null), null);
  assertEquals(durationSeconds("forever"), null);
});

test("the envelope's own required list is pinned, in both directions", () => {
  // event-contract.md claimed the gate rejected "adding a newly required
  // envelope attribute". It did not: the gate never opened the envelope file.
  const base = baselineOf(DEPLOYED);
  const stricter: Envelope = {
    ...ENVELOPE,
    required: [...ENVELOPE.required, "traceparent"],
  };
  assert(
    checkEnvelopeCompatibility(base, stricter)
      .map((v) => v.rule)
      .includes("envelope-attribute-required"),
  );

  const looser: Envelope = { ...ENVELOPE, required: ["id", "source"] };
  assert(
    checkEnvelopeCompatibility(base, looser)
      .map((v) => v.rule)
      .includes("envelope-attribute-unrequired"),
  );

  assertEquals(checkEnvelopeCompatibility(base, ENVELOPE), []);
});

// --- D1: the properties block, not just `required` -------------------------
// Pinning `required` alone left the one file every event on the bus validates
// against guarded by an eight-element string array, while payload schemas were
// pinned property by property. These three mutations all passed that gate.

const envelopeWithout = (attr: string): Envelope => {
  const properties = { ...ENVELOPE.properties };
  delete properties[attr];
  return { ...ENVELOPE, properties };
};

const envelopeRules = (e: Envelope) =>
  checkEnvelopeCompatibility(baselineOf(DEPLOYED), e).map((v) => v.rule);

test("deleting an optional envelope attribute is rejected", () => {
  // `sequence` is optional, so removing it never touches `required` and the
  // required-only pin could not see it — in the same contract that tells every
  // consumer to use `sequence` to detect reordering.
  assert(
    envelopeRules(envelopeWithout("sequence")).includes(
      "envelope-attribute-removed",
    ),
  );
});

test("adding an envelope attribute is rejected even when it is optional", () => {
  // additionalProperties: false means a consumer validating against an older
  // vendored copy REJECTS every event carrying it. Optional is not additive.
  const wider: Envelope = {
    ...ENVELOPE,
    properties: { ...ENVELOPE.properties, partitionkey: { type: "string" } },
  };
  assert(envelopeRules(wider).includes("envelope-attribute-added"));
});

test("retyping an envelope attribute is rejected", () => {
  const retyped: Envelope = {
    ...ENVELOPE,
    properties: { ...ENVELOPE.properties, sequence: { type: "integer" } },
  };
  assert(envelopeRules(retyped).includes("envelope-attribute-retyped"));
});

test("narrowing an envelope pattern, format or const is rejected", () => {
  // Nothing about the attribute's *type* changes, but values that validated
  // before stop validating — here, every hyphenated type the grammar allows.
  const narrowed: Envelope = {
    ...ENVELOPE,
    properties: {
      ...ENVELOPE.properties,
      type: {
        type: "string",
        pattern: "^com\\.mcafeeconsulting\\.platform\\.[a-z0-9]+$",
      },
    },
  };
  assert(envelopeRules(narrowed).includes("envelope-pattern-changed"));

  const reformatted: Envelope = {
    ...ENVELOPE,
    properties: {
      ...ENVELOPE.properties,
      time: { type: "string", format: "date" },
    },
  };
  assert(envelopeRules(reformatted).includes("envelope-pattern-changed"));

  const reconsted: Envelope = {
    ...ENVELOPE,
    properties: { ...ENVELOPE.properties, specversion: { const: "1.1" } },
  };
  assert(envelopeRules(reconsted).includes("envelope-pattern-changed"));
});

test("opening the envelope to additional properties is rejected", () => {
  // The flag the whole coordinated-rollout rule rests on.
  const opened: Envelope = { ...ENVELOPE, additionalProperties: true };
  assert(
    envelopeRules(opened).includes("envelope-additional-properties-changed"),
  );
});

// --- length bounds, both directions ----------------------------------------
// The four constraint keys above — type, pattern, format, const — were the whole
// comparator, and `minLength`/`maxLength` appeared nowhere in the file. M19:
// `source.maxLength` 253 -> 64 passed `contracts:check` clean while rejecting
// every fully-qualified service URI longer than 64 characters.

/** Replace one envelope attribute wholesale. */
const envelopeWith = (attr: string, def: Envelope["properties"][string]) => ({
  ...ENVELOPE,
  properties: { ...ENVELOPE.properties, [attr]: def },
});

test("narrowing an envelope maxLength is rejected (M19)", () => {
  assertEquals(
    envelopeRules(
      envelopeWith("source", { type: "string", maxLength: 64 }),
    ).filter((r) => r === "envelope-length-narrowed"),
    ["envelope-length-narrowed"],
  );
});

test("widening an envelope maxLength passes", () => {
  // Additive: every value that validated still validates. A gate that blocked
  // this would teach people to regenerate the baseline past red, which is how a
  // real narrowing gets waved through later.
  assertEquals(
    envelopeRules(envelopeWith("source", { type: "string", maxLength: 512 })),
    [],
  );
  // Dropping the bound entirely is the widest widening there is.
  assertEquals(envelopeRules(envelopeWith("source", { type: "string" })), []);
});

test("introducing an envelope maxLength where there was none is a narrowing", () => {
  // No `maxLength` means unbounded in JSON Schema, so this rejects values that
  // validated a moment ago — the same break as tightening an existing bound.
  assertEquals(
    envelopeRules(
      envelopeWith("sequence", {
        type: "string",
        pattern: "^[0-9]{1,20}$",
        maxLength: 20,
      }),
    ),
    ["envelope-length-narrowed"],
  );
});

test("an envelope minLength narrows upward and widens downward", () => {
  assertEquals(
    envelopeRules(
      envelopeWith("id", { type: "string", minLength: 8, maxLength: 128 }),
    ),
    ["envelope-length-narrowed"],
  );
  assertEquals(
    envelopeRules(
      envelopeWith("id", { type: "string", minLength: 0, maxLength: 128 }),
    ),
    [],
  );
  // Absent is the same constraint as 0, so neither narrows the other.
  assertEquals(
    envelopeRules(envelopeWith("id", { type: "string", maxLength: 128 })),
    [],
  );
});

test("an envelope baseline predating the length pin adopts its bounds", () => {
  // The properties block is pinned but each attribute object is missing the two
  // new keys. Reading absent as "unbounded" would fail the build on every
  // bounded attribute at once — `baseline --write` must be able to adopt.
  const base = baselineOf(DEPLOYED);
  const legacy = {
    ...base,
    envelope: {
      ...base.envelope,
      properties: Object.fromEntries(
        Object.entries(base.envelope.properties).map(([name, p]) => {
          const { minLength: _min, maxLength: _max, ...rest } = p;
          return [name, rest];
        }),
      ),
    },
  } as Baseline;
  assertEquals(checkEnvelopeCompatibility(legacy, ENVELOPE), []);
  // And the adoption is not a blanket amnesty: the other four keys still fire.
  assertEquals(
    checkEnvelopeCompatibility(
      legacy,
      envelopeWith("source", { type: "integer", maxLength: 253 }),
    ).map((v) => v.rule),
    ["envelope-attribute-retyped"],
  );
});

test("absent, null and a number are three distinct states for a bound", () => {
  // The distinction the adoption path rests on, stated directly.
  assertEquals(
    narrowedLengthBounds(undefined, { minLength: 1, maxLength: 8 }),
    [
      // A baseline predating the pin compares as nothing at all.
    ],
  );
  assertEquals(
    narrowedLengthBounds(
      { minLength: null, maxLength: null },
      { minLength: null, maxLength: 8 },
    ),
    ["maxLength (none) -> 8"],
  );
  assertEquals(
    narrowedLengthBounds(
      { minLength: null, maxLength: 8 },
      { minLength: null, maxLength: null },
    ),
    [],
  );
});

test("an envelope baseline predating the properties pin is adopted, not failed", () => {
  // `baseline --write` is the documented way to take the new pin; an older
  // baseline must not fail the build on every attribute at once.
  const base = baselineOf(DEPLOYED);
  const legacy = {
    ...base,
    envelope: { required: base.envelope.required },
  } as Baseline;
  assertEquals(checkEnvelopeCompatibility(legacy, ENVELOPE), []);
});

// ============================================================================
// Payload (dataschema) compatibility
// ============================================================================

/** The shape the twelve published payload schemas actually use. */
const PAYLOAD: PayloadSchema = {
  properties: {
    namespace: { type: "string", maxLength: 253 },
    name: { type: "string", maxLength: 253 },
    revision: { type: "string" },
    replicas: { type: "integer" },
  },
  required: ["namespace", "name"],
  additionalProperties: false,
};

/** Replace one payload property wholesale. */
const payloadWith = (
  prop: string,
  def: NonNullable<PayloadSchema["properties"]>[string],
): PayloadSchema => ({
  ...PAYLOAD,
  properties: { ...PAYLOAD.properties, [prop]: def },
});

/** A baseline pinning DEPLOYED's payload, the way `baseline --write` now does. */
const payloadBase = (schema: PayloadSchema = PAYLOAD): Baseline =>
  toBaseline(
    registry(DEPLOYED),
    TAXONOMY,
    ENVELOPE,
    new Map([[DEPLOYED.type, schema]]),
  );

const payloadCompat = (after: PayloadSchema, before: PayloadSchema = PAYLOAD) =>
  checkPayloadCompatibility(
    payloadBase(before),
    new Map([[DEPLOYED.type, after]]),
  ).map((v) => v.rule);

test("an unchanged payload schema is compatible", () => {
  assertEquals(payloadCompat(PAYLOAD), []);
});

test("adding an optional payload property is additive", () => {
  assertEquals(
    payloadCompat({
      ...PAYLOAD,
      properties: { ...PAYLOAD.properties, image: { type: "string" } },
    }),
    [],
  );
});

test("a newly required payload property is breaking", () => {
  // This is the gap ADR-038 left open: it published the payload schemas and
  // made them normative, while the gate pinned only the `dataschema` path. A
  // required addition passed, and every deployed producer would fail validation.
  assertEquals(
    payloadCompat({ ...PAYLOAD, required: ["namespace", "name", "revision"] }),
    ["payload-required-added"],
  );
});

test("un-requiring a payload property is breaking", () => {
  // Same reasoning as `required-attribute-removed` on the envelope: consumers
  // were promised presence and do not null-check.
  assertEquals(payloadCompat({ ...PAYLOAD, required: ["namespace"] }), [
    "payload-required-removed",
  ]);
});

test("removing a payload property is breaking", () => {
  const { revision: _dropped, ...rest } = PAYLOAD.properties!;
  assertEquals(payloadCompat({ ...PAYLOAD, properties: rest }), [
    "payload-property-removed",
  ]);
});

test("retyping a payload property is breaking", () => {
  assertEquals(
    payloadCompat({
      ...PAYLOAD,
      properties: { ...PAYLOAD.properties, replicas: { type: "string" } },
    }),
    ["payload-property-retyped"],
  );
});

test("closing a payload schema to additions forecloses the additive path", () => {
  // The one direction that is breaking for CONSUMERS rather than producers: a
  // consumer validating against this schema starts rejecting events that carry
  // a property added after it shipped.
  assertEquals(
    payloadCompat(
      { ...PAYLOAD, additionalProperties: false },
      {
        ...PAYLOAD,
        additionalProperties: true,
      },
    ),
    ["payload-closed-to-additions"],
  );
  // Opening it back up is a relaxation, and safe.
  assertEquals(payloadCompat({ ...PAYLOAD, additionalProperties: true }), []);
});

// --- the same gap on the payload side --------------------------------------
// One gap on both sides of the same comparator: neither pinned a length bound.
// All twelve published payload schemas declare at least one `maxLength`.

test("narrowing a payload maxLength is rejected", () => {
  assertEquals(
    payloadCompat(payloadWith("namespace", { type: "string", maxLength: 63 })),
    ["payload-length-narrowed"],
  );
});

test("widening a payload maxLength passes", () => {
  assertEquals(
    payloadCompat(payloadWith("namespace", { type: "string", maxLength: 512 })),
    [],
  );
  assertEquals(payloadCompat(payloadWith("namespace", { type: "string" })), []);
});

test("introducing a payload length bound on an existing property is a narrowing", () => {
  // `revision` is unbounded in the baseline, so every value longer than 40
  // characters validated until this edit.
  assertEquals(
    payloadCompat(payloadWith("revision", { type: "string", maxLength: 40 })),
    ["payload-length-narrowed"],
  );
});

test("a length bound on a newly added payload property is additive", () => {
  // Adding an optional property is additive, and so are the bounds it arrives
  // with — there is no older, wider window for them to narrow.
  assertEquals(
    payloadCompat({
      ...PAYLOAD,
      properties: {
        ...PAYLOAD.properties,
        image: { type: "string", maxLength: 512 },
      },
    }),
    [],
  );
});

test("a payload baseline predating the length pin adopts its bounds", () => {
  // Same adoption precedent as `envelope.properties`: an older baseline has no
  // `lengths` map at all, and must not fail the build on every bounded property.
  const base = payloadBase();
  const legacy = {
    ...base,
    types: base.types.map((t) =>
      t.payload ? { ...t, payload: { ...t.payload, lengths: undefined } } : t,
    ),
  } as Baseline;
  assertEquals(
    checkPayloadCompatibility(legacy, new Map([[DEPLOYED.type, PAYLOAD]])),
    [],
  );
  // Adoption is scoped to the new keys; the pre-existing rules still fire.
  assertEquals(
    checkPayloadCompatibility(
      legacy,
      new Map([[DEPLOYED.type, payloadWith("namespace", { type: "integer" })]]),
    ).map((v) => v.rule),
    ["payload-property-retyped"],
  );
});

test("a payload schema that stops resolving is breaking, not invisible", () => {
  // Deleting the file must not silently un-pin 4 properties on a stable type.
  assertEquals(
    checkPayloadCompatibility(payloadBase(), new Map()).map((v) => v.rule),
    ["payload-schema-unreadable"],
  );
});

test("an absent additionalProperties is recorded as open, per JSON Schema", () => {
  const open: BaselinePayload = toBaselinePayload({
    properties: { a: { type: "string" } },
    required: [],
  });
  assertEquals(open.additionalProperties, true);
  // A schema with no bounds pins an EMPTY lengths map, not an absent one: absent
  // is reserved for a baseline predating the pin, and the two must not collide.
  assertEquals(open.lengths, {});
  // An untyped property is pinned as "unknown" rather than dropped, so adding a
  // type to it later still reads as a change a reviewer sees.
  assertEquals(
    toBaselinePayload({ properties: { a: {} } }).properties.a,
    "unknown",
  );
});

// ============================================================================
// The real contract in contracts/events/
// ============================================================================

test("every stable type's payload schema is pinned by the baseline", () => {
  // The rules above are only worth anything if the baseline actually carries a
  // payload for each stable type; a null payload silently skips every one.
  const unpinned = loadBaseline()
    .types.filter((t) => !t.dataless && t.payload === null)
    .map((t) => t.type);
  assertEquals(unpinned, []);
});

test("the checked-in payload schemas are compatible with the baseline", () => {
  const registry = loadRegistry();
  assertEquals(
    renderViolations(
      checkPayloadCompatibility(loadBaseline(), loadPayloads(registry)),
    ),
    "contract ok",
  );
});

test("the checked-in contract is internally consistent", () => {
  assertEquals(
    renderViolations([
      ...validateTaxonomy(loadTaxonomy()),
      ...validateRegistry(
        loadRegistry(),
        loadTaxonomy(),
        loadEnvelope(),
        "contracts/events",
      ),
    ]),
    "contract ok",
  );
});

test("the checked-in contract is compatible with its baseline", () => {
  assertEquals(
    renderViolations([
      ...checkCompatibility(loadBaseline(), loadRegistry()),
      ...checkEnvelopeCompatibility(loadBaseline(), loadEnvelope()),
      ...checkTaxonomyCompatibility(loadBaseline(), loadTaxonomy()),
    ]),
    "contract ok",
  );
});

test("every registered dataschema resolves to a file that exists", () => {
  // The document's justification for requiring `dataschema` is that an
  // unpublished payload is not a contract. All eleven once pointed at nothing.
  const missing = validateRegistry(
    loadRegistry(),
    loadTaxonomy(),
    loadEnvelope(),
    "contracts/events",
  ).filter((v) => v.rule === "dataschema-missing-file");
  assertEquals(missing, []);
});

test("the baseline file is in sync with the registry, streams, envelope and payloads", () => {
  // Guards the failure mode where someone edits registry.v1.yaml additively and
  // forgets `bun scripts/contract-check.ts baseline --write`; the next breaking
  // change would then be diffed against a stale, permissive baseline.
  const registry = loadRegistry();
  assertEquals(
    loadBaseline(),
    toBaseline(
      registry,
      loadTaxonomy(),
      loadEnvelope(),
      loadPayloads(registry),
    ),
  );
});
