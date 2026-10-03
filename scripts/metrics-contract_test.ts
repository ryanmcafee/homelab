#!/usr/bin/env -S bun test
/**
 * Consistency tests for contracts/observability/metrics.v1.yaml -- the RED metric
 * contract for first-party control-plane services.
 *
 * This file is the contract's own gate, in the shape ADR-030 requires: the rule set is
 * checked against the checked-in contract, and the checker is tested rather than
 * trusted. It asserts the contract is internally consistent -- that the bucket
 * boundaries and their `le` strings are the same list, that the stated cardinality
 * ceiling actually holds for the label ceilings next to it, that no label is both
 * required and forbidden, and that the tenancy vocabulary is the event envelope's
 * rather than a second one.
 *
 * It also checks the companion document, because a worked query naming a label the
 * contract does not declare is the failure mode that makes a contract unusable
 * without asking its author a follow-up question.
 *
 * It is deliberately NOT a conformance test for any service. That is the level-1
 * exposition scrape named in the contract's enforcement section, and it does not
 * exist yet -- which the contract says out loud rather than implying a running gate.
 *
 *   bun test scripts/metrics-contract_test.ts
 */

import { test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEquals } from "./lib/assert.ts";
import { parse as parseYaml } from "./lib/yaml.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const CONTRACT_PATH = join(
  REPO_ROOT,
  "contracts",
  "observability",
  "metrics.v1.yaml",
);
const DOC_PATH = join(REPO_ROOT, "docs", "contracts", "metric-contract.md");
const ENVELOPE_PATH = join(
  REPO_ROOT,
  "contracts",
  "events",
  "envelope.v1.schema.json",
);
const REGISTRY_PATH = join(
  REPO_ROOT,
  "contracts",
  "events",
  "registry.v1.yaml",
);

interface LabelSpec {
  name: string;
  pattern?: string;
  enum?: string[];
  closed?: boolean;
  maxDistinctValuesPerService?: number;
  singleTenantValue?: string;
  sliExclusionRule?: string;
  tailRule?: string;
}

interface MetricsContract {
  version: number;
  scope: { appliesTo: string; outOfScope: { id: string; path?: string }[] };
  metrics: {
    name: string;
    type: string;
    unit: string;
    required: boolean;
    observation?: Record<string, string>;
  }[];
  metricsObservation?: unknown;
  buckets: {
    boundariesSeconds: number[];
    leLabelValues: string[];
    seriesPerLabelSet: number;
    maxAdjacentRatioAboveOneSecond: number;
  };
  labels: {
    required: LabelSpec[];
    optional: LabelSpec[];
    scrapeAttached: {
      names: string[];
      aggregationRule: string;
      jobIsNotAnException: string;
      canarySelectionCaveats: { id: string; rule: string }[];
    };
  };
  cardinality: {
    forbiddenLabels: string[];
    ceilings: {
      redFamilySeriesPerReplicaPerTenant: number;
      workedExample: string;
      workedExampleBasis: string;
      maxTenantsPerReplica: number;
    };
    breachLegalMoves?: string;
  };
  errorClassification: {
    http: { match: string; outcome: string; code?: string }[];
  };
  exposition: {
    path: string;
    portName: string;
    scrapeIntervalSecondsMax: number;
  };
  guarantees: {
    delivery: string;
    ordering: string;
    absence: string;
    absenceIsNotFailure: string;
    emptyIsNotNaN: string;
  };
  compatibility: {
    v1FreezePoint: string;
    breaking: string[];
    additive: string[];
  };
  enforcement: {
    statusThisWindow: string;
    mechanisms: { id: string; status: string; mechanism: string }[];
  };
  adoption: { new: { obligation: string }; existing: { obligation: string } };
  consumers: { id: string; path: string }[];
}

const contract = parseYaml(
  readFileSync(CONTRACT_PATH, "utf8"),
) as MetricsContract;
const doc = readFileSync(DOC_PATH, "utf8");

const requiredLabels = contract.labels.required.map((l) => l.name);
const optionalLabels = contract.labels.optional.map((l) => l.name);
const labelByName = new Map<string, LabelSpec>(
  [...contract.labels.required, ...contract.labels.optional].map((l) => [
    l.name,
    l,
  ]),
);

test("contract is v1 and declares the one RED family plus build info", () => {
  assertEquals(contract.version, 1);
  const names = contract.metrics.map((m) => m.name);
  assertEquals(names, [
    "platform_request_duration_seconds",
    "platform_build_info",
  ]);
  const red = contract.metrics[0];
  assertEquals(red.type, "histogram");
  // Seconds, not milliseconds: histogram_quantile returns the unit it was given, and
  // one service in milliseconds makes every cross-service panel silently wrong.
  assertEquals(red.unit, "seconds");
  assert(
    red.required,
    "the RED family is not optional; that is the whole contract",
  );
});

test("bucket boundaries are sorted, unique and positive", () => {
  const b = contract.buckets.boundariesSeconds;
  assert(b.length > 0, "a histogram with no boundaries has no quantiles");
  for (let i = 1; i < b.length; i++) {
    assert(
      b[i] > b[i - 1],
      `boundaries must strictly ascend: ${b[i - 1]} is followed by ${b[i]}`,
    );
  }
  assert(b[0] > 0, "a boundary of 0 or less measures nothing");
});

test("le label strings are the boundaries in their exposition form, plus +Inf", () => {
  const b = contract.buckets.boundariesSeconds;
  const le = contract.buckets.leLabelValues;
  // A selector matches `le` by STRING equality. If the contract pins 1 and the
  // exposition renders "1.0", every le="1" query in the platform returns no data and
  // nothing reports an error -- so the string form is part of the contract, and this
  // is the test that keeps the two lists from drifting.
  assertEquals(le.length, b.length + 1);
  assertEquals(le[le.length - 1], "+Inf");
  for (let i = 0; i < b.length; i++) {
    assertEquals(
      le[i],
      String(b[i]),
      `le[${i}] should be the canonical rendering of ${b[i]}`,
    );
  }
});

test("seriesPerLabelSet counts every series the family produces", () => {
  // boundaries + +Inf bucket + _count + _sum. This number is what every cardinality
  // claim in the file multiplies by, so an off-by-one here understates the ceiling.
  assertEquals(
    contract.buckets.seriesPerLabelSet,
    contract.buckets.boundariesSeconds.length + 3,
  );
});

test("the brief's minimum required labels are required, and closed enums are closed", () => {
  for (const name of ["service", "environment", "tenant"]) {
    assert(requiredLabels.includes(name), `${name} must be a required label`);
  }
  assertEquals(labelByName.get("outcome")?.enum, ["success", "error"]);
  assert(
    labelByName.get("outcome")?.closed,
    "outcome must be closed: every error-rate query in the platform is a ratio selected on it",
  );
  assert(labelByName.get("kind")?.closed, "kind must be closed");
  // `code` is the one open enum. Adding a value to it changes no outcome ratio, which
  // is exactly why it is the one that may grow.
  assertEquals(labelByName.get("code")?.closed, false);
});

test("every label name is a valid Prometheus label name", () => {
  const valid = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  for (const name of [...requiredLabels, ...optionalLabels]) {
    assert(valid.test(name), `${name} is not a valid Prometheus label name`);
  }
});

test("no label is both declared and forbidden", () => {
  const forbidden = new Set(contract.cardinality.forbiddenLabels);
  for (const name of [...requiredLabels, ...optionalLabels]) {
    assert(
      !forbidden.has(name),
      `${name} is declared and also forbidden; one of the two is a mistake`,
    );
  }
  // The three the brief names by hand, plus the deploy-churn family that is the
  // subtler version of the same defect.
  for (const name of [
    "request_id",
    "path",
    "agent_run_id",
    "pod_template_hash",
    "version",
  ]) {
    assert(forbidden.has(name), `${name} must be on the forbidden list`);
  }
});

test("the worked cardinality example fits inside the ceiling it is quoted against", () => {
  const routes = labelByName.get("route")?.maxDistinctValuesPerService;
  // The CEILING, not the current enum size. `code` is open by design, so a conformant
  // service may emit every value the ceiling allows; computing this from the four
  // values that happened to exist is how the arithmetic flatters itself and the file
  // teaches a number a conformant service can exceed.
  const codes = labelByName.get("code")?.maxDistinctValuesPerService;
  assert(
    routes !== undefined && codes !== undefined,
    "route and code need ceilings",
  );
  const declared = labelByName.get("code")?.enum?.length ?? 0;
  assert(
    declared <= codes,
    `code declares ${declared} values, over its own ceiling of ${codes}`,
  );
  // One success series set plus one per error code, times the series per label set.
  const worst = routes * (1 + codes) * contract.buckets.seriesPerLabelSet;
  const ceiling =
    contract.cardinality.ceilings.redFamilySeriesPerReplicaPerTenant;
  assert(
    worst <= ceiling,
    `a conformant service at its own label ceilings produces ${worst} series, over the ${ceiling} ceiling`,
  );
  // And the prose has to quote the same arithmetic, or the file teaches a number the
  // rules do not produce.
  assert(
    contract.cardinality.ceilings.workedExample.includes(String(worst)),
    `workedExample should state ${worst}`,
  );
});

test("tenancy is the event envelope's vocabulary, not a second one", () => {
  const envelope = JSON.parse(readFileSync(ENVELOPE_PATH, "utf8")) as {
    properties: { tenant: { pattern: string; description: string } };
  };
  const tenant = labelByName.get("tenant");
  assertEquals(
    tenant?.pattern,
    envelope.properties.tenant.pattern,
    "the metric tenant label and the event tenant attribute must accept the same values",
  );
  const reserved = tenant?.singleTenantValue;
  assert(
    reserved !== undefined,
    "a single-tenant fork needs a stated value to emit",
  );
  assert(
    envelope.properties.tenant.description.includes(`\`${reserved}\``),
    `the envelope reserves a different single-tenant value than ${reserved}`,
  );
});

test("kind carries the event registry's pattern vocabulary", () => {
  const registry = readFileSync(REGISTRY_PATH, "utf8");
  const patterns = new Set(
    [...registry.matchAll(/^\s*pattern:\s*([a-z_]+)\s*$/gm)].map((m) => m[1]),
  );
  assert(patterns.size > 0, "no pattern values found in the event registry");
  const kinds = labelByName.get("kind")?.enum ?? [];
  for (const pattern of patterns) {
    assert(
      kinds.includes(pattern),
      `the registry has pattern ${pattern} with no matching kind label value`,
    );
  }
});

test("the compatibility rule set states the metrics-specific traps", () => {
  const breaking = contract.compatibility.breaking.join(" ").toLowerCase();
  // Adding a label is additive in JSON and breaking here. If that sentence is ever
  // dropped, someone will add a label to this family the way they add a field.
  assert(
    breaking.includes("adding a required label"),
    "adding a label to an existing family must be listed as breaking",
  );
  assert(
    breaking.includes("bucket boundary"),
    "changing a bucket boundary must be listed as breaking",
  );
  assert(
    breaking.includes("closed enum"),
    "changing a closed enum must be listed as breaking",
  );
});

test("the delivery guarantee is stated and is the honest one", () => {
  assertEquals(contract.guarantees.delivery, "best-effort-at-most-once");
  assertEquals(contract.guarantees.ordering, "none");
});

test("enforcement names a shipped mechanism and admits the unshipped ones", () => {
  const known = new Set(["shipped", "specified-not-implemented"]);
  for (const m of contract.enforcement.mechanisms) {
    assert(known.has(m.status), `${m.id} has an unknown status ${m.status}`);
  }
  const shipped = contract.enforcement.mechanisms.filter(
    (m) => m.status === "shipped",
  );
  assert(
    shipped.length > 0,
    "a contract with no running gate is documentation",
  );
  for (const m of shipped) {
    // The shipped mechanism must point at a file that exists, or "shipped" is a claim
    // rather than a gate.
    const path = m.mechanism.match(/([\w./-]+\.(?:ts|go|yaml|yml))/)?.[1];
    assert(path !== undefined, `${m.id} claims shipped without naming a file`);
    assert(
      existsSync(join(REPO_ROOT, path)),
      `${m.id} names ${path}, which does not exist`,
    );
  }
  if (contract.enforcement.mechanisms.some((m) => m.status !== "shipped")) {
    assert(
      contract.enforcement.statusThisWindow.toLowerCase().includes("advisory"),
      "with mechanisms unimplemented the window status must say advisory out loud",
    );
  }
});

test("scope and consumers point at files that exist", () => {
  for (const entry of contract.scope.outOfScope) {
    if (entry.path !== undefined) {
      assert(
        existsSync(join(REPO_ROOT, entry.path)),
        `out-of-scope entry ${entry.id} names ${entry.path}, which does not exist`,
      );
    }
  }
  for (const consumer of contract.consumers) {
    for (const path of consumer.path.split(",").map((p) => p.trim())) {
      assert(
        existsSync(join(REPO_ROOT, path)),
        `consumer ${consumer.id} names ${path}, which does not exist`,
      );
    }
  }
});

test("every metric named in the companion document is declared", () => {
  const declared = new Set(contract.metrics.map((m) => m.name));
  const suffixes = ["_bucket", "_count", "_sum"];
  for (const match of doc.matchAll(/platform_[a-z0-9_]+/g)) {
    let name = match[0];
    for (const suffix of suffixes) {
      if (name.endsWith(suffix)) name = name.slice(0, -suffix.length);
    }
    assert(
      declared.has(name),
      `the document queries ${match[0]}, which the contract does not declare`,
    );
  }
});

test("every label named in the companion document is declared", () => {
  const allowed = new Set([
    ...requiredLabels,
    ...optionalLabels,
    ...contract.labels.scrapeAttached.names,
    "le",
  ]);
  const used = new Set<string>();
  // Selectors: outcome="error", le="0.25", job="{{args.canary-job}}".
  for (const m of doc.matchAll(/([a-z_][a-z0-9_]*)\s*=\s*"/g)) used.add(m[1]);
  // Grouping lists: sum by (service, route), sum without (pod, instance).
  for (const m of doc.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)) {
    for (const name of m[1].split(",").map((n) => n.trim())) {
      if (name.length > 0) used.add(name);
    }
  }
  assert(
    used.size > 0,
    "no labels found in the document; the check is not working",
  );
  for (const name of used) {
    assert(
      allowed.has(name),
      `the document selects on ${name}, which is neither declared nor scrape-attached`,
    );
  }
});

test("the exposition surface is pinned by name, not by port number", () => {
  assertEquals(contract.exposition.path, "/metrics");
  assertEquals(contract.exposition.portName, "metrics");
  // A canary analysis over a 5m window needs samples to rate() over.
  assert(
    contract.exposition.scrapeIntervalSecondsMax <= 30,
    "a scrape slower than 30s leaves a 5m canary window with too few samples",
  );
});

// ---------------------------------------------------------------------------
// The eight conditions from the SRE's acceptance review (MCAA-273). Each one is
// pinned here rather than only fixed, because a condition that is merely applied is
// one refactor away from being un-applied, and four of these are in the closed-enum
// and bucket territory that compatibility.breaking forbids revisiting after v1.
// ---------------------------------------------------------------------------

test("C1: probe and scrape traffic is excluded from the population at the source", () => {
  const red = contract.metrics[0];
  const excluded = red.observation?.excluded ?? "";
  for (const word of ["probe", "readiness", "liveness"]) {
    assert(
      excluded.toLowerCase().includes(word),
      `the excluded population must name ${word}; probe traffic outnumbers user traffic ~10:1 and divides the error ratio by eleven`,
    );
  }
  // Exclusion at the source, not a reserved route the consumer has to filter. A route
  // value every expression must exclude is the `pod` mistake again.
  assert(
    (red.observation?.excludedRule ?? "")
      .toLowerCase()
      .includes("not a reserved route"),
    "the contract must say exclusion happens at the source rather than via a route value",
  );
});

test("C2: kind carries a stream value and bounds what it observes", () => {
  const kinds = labelByName.get("kind")?.enum ?? [];
  assert(
    kinds.includes("stream"),
    "kind must include `stream` in v1: it is a closed enum, so adding it later is breaking",
  );
  const red = contract.metrics[0];
  const stream = red.observation?.stream ?? "";
  assert(
    stream.includes("headers"),
    "observation.stream must stop the clock at response headers, not at connection close",
  );
  assert(
    /not when the connection closes/i.test(stream),
    "observation.stream must say plainly that lifetime is not what is measured",
  );
  // The hole is stated rather than hidden, and its escape hatch is additive.
  assert(
    (red.observation?.streamLimitation ?? "").includes(
      "platform_stream_duration_seconds",
    ),
    "the mid-flight-failure hole must name the additive family that closes it",
  );
});

test("C3: no bucket above one second is wider than the declared ratio", () => {
  const b = contract.buckets.boundariesSeconds;
  const maxRatio = contract.buckets.maxAdjacentRatioAboveOneSecond;
  assert(maxRatio > 1, "a max adjacent ratio of 1 or less is unsatisfiable");
  for (let i = 1; i < b.length; i++) {
    if (b[i - 1] < 1) continue;
    const ratio = b[i] / b[i - 1];
    assert(
      ratio <= maxRatio,
      `the ${b[i - 1]}-to-${b[i]} gap is ${ratio.toFixed(1)}x, over the ${maxRatio}x limit: ` +
        "histogram_quantile interpolates linearly, so the reported quantile's error bar is the bucket width",
    );
  }
  // The specific gap the NATS ack deadline puts every struggling pubsub handler into.
  assert(
    b.includes(15),
    "the 15s boundary is what makes the 10-to-30 band expressible; without it a true p99 of 11s reports as 20s",
  );
});

test("C4: the error taxonomy separates overload shedding from quota denial", () => {
  const codes = labelByName.get("code")?.enum ?? [];
  for (const value of ["throttled", "quota"]) {
    assert(codes.includes(value), `code must carry ${value}`);
  }
  // Both are errors -- neither is invisible -- but only one burns the budget.
  const rule = labelByName.get("code")?.sliExclusionRule ?? "";
  assert(
    rule.includes('code!="quota"'),
    "the contract must give the availability SLI its exact quota exclusion selector",
  );
  const http = contract.errorClassification.http;
  // Rows ABOUT 429, not rows that merely mention it -- "4xx other than 429" is a row
  // about the other 4xx and must not be counted here.
  const from429 = http.filter((row) => row.match.startsWith("429"));
  assertEquals(
    from429.length,
    2,
    "429 must classify into two codes; conflated, one noisy tenant burns the service's budget and blocks everybody's releases at day 31",
  );
  assertEquals(
    new Set(from429.map((r) => r.code)),
    new Set(["throttled", "quota"]),
  );
  for (const row of from429) {
    assertEquals(row.outcome, "error", "both flavours of 429 are still errors");
  }
});

test("the quota exclusion is on BOTH sides of every error ratio, not the numerator alone", () => {
  // Numerator-only exclusion is worse than none: the denials leave the error count and
  // STAY in the population, where they are counted as good events. A tenant retrying
  // into its quota at 900 req/s turns a service failing 10 of 100 user requests (10%,
  // 20x burn, pages) into 10/1010 = 0.99% and a burn rate of 1.98x, which clears no
  // paging tier -- so a noisy tenant can no longer burn the budget but can now HIDE an
  // outage, the worse of the two directions.
  const rule = labelByName.get("code")?.sliExclusionRule ?? "";
  assert(
    /both sides/i.test(rule),
    "sliExclusionRule must require the quota selector on both sides of the ratio",
  );
  // Every ratio in the document that filters quota out of its numerator must filter it
  // out of its denominator too.
  //
  // Checked per EXPRESSION, not per code block: section 4's `platform:request:rate5m` is
  // a deliberate unselected total (a traffic metric, not an SLI) and shares its block
  // with the ratio rule. And a denominator is matched WITH ITS BRACES OPTIONAL -- the
  // defect form is `_count[5m]` with no selector at all, which a regex requiring `{...}`
  // cannot see. That blindness is what let this gate pass a mutation that had genuinely
  // reintroduced the dilution.
  const expressions = [
    ...[...doc.matchAll(/```promql\n([\s\S]*?)```/g)].map((m) => m[1]),
    ...[...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].flatMap((m) =>
      m[1].split(/^ {6}- record: /m).slice(1),
    ),
    ...canaryMetrics.map((m) => m.body),
  ];
  let ratiosChecked = 0;
  for (const raw of expressions) {
    // Argo's `{{args.service}}` closes a `[^}]*` selector scan two braces early, which
    // truncated every canary selector mid-label and reported a false violation.
    const expr = raw.replace(/\{\{[^{}]*\}\}/g, "ARG");
    if (!expr.includes('outcome="error"')) continue;
    ratiosChecked++;
    for (const ref of expr.matchAll(
      /platform_request_duration_seconds_count(\{[^}]*\})?/g,
    )) {
      const selector = ref[1] ?? "";
      assert(
        selector.includes('code!="quota"') ||
          selector.includes('outcome="success"'),
        `an error-ratio expression selects quota out of one side but reads "${ref[0]}" on another; the denials stay in the population and are counted as GOOD events, so a noisy tenant hides a real outage`,
      );
    }
  }
  assert(
    ratiosChecked >= 4,
    `only ${ratiosChecked} error-ratio expressions were reached; section 2, section 4's ratio rule and the two canary error metrics must all be inspected`,
  );
});

test("call 2: route declares the over-budget tail rule, or no real API can adopt this", () => {
  // The series ceiling, not the route ceiling, is the binding constraint: our own
  // control-plane API exposes ~127 "<METHOD> <template>" values, and 127 x 7 x 16 =
  // 14224 against a 3000 ceiling. Even at ONE code value it is 4064. No value of
  // maxDistinctValuesPerService makes that service conformant, so without a tail rule
  // cardinality.breach ("the fix is fewer label values") leaves the contract's own first
  // consumer with no legal move.
  const route = labelByName.get("route");
  const tail = route?.tailRule ?? "";
  assert(
    tail.includes("__other__"),
    "route.tailRule must say the over-budget tail collapses into __other__",
  );
  assert(
    /over-budget/i.test(tail),
    "route.tailRule must cover the OVER-BUDGET case, not only the unmatched one -- they are different failures and only one of them is a scanner",
  );
  assert(
    (contract.cardinality.breachLegalMoves ?? "").includes("tailRule"),
    "cardinality.breach reads as 'your service is too big to be conformant' unless breachLegalMoves points at the tail rule",
  );
  // The ceiling arithmetic must still hold for the routes that DO stay named.
  const routes = route?.maxDistinctValuesPerService ?? 0;
  const codes =
    contract.cardinality.ceilings.redFamilySeriesPerReplicaPerTenant;
  assert(
    routes * 7 * 16 <= codes,
    `${routes} named routes x 7 code values x 16 series exceeds the ${codes} ceiling`,
  );
});

test("C5: job is never retained by an aggregation in the companion document", () => {
  // `job` belongs in a selector (canary analysis) and nowhere else. Retained by an SLO
  // aggregation it is the `pod` failure with a longer fuse: during a rollout the canary
  // pods are scraped under two job values, so one service becomes two rows and the
  // burn rate resets at exactly the moment a deploy is the suspect.
  for (const m of doc.matchAll(/\bby\s*\(([^)]*)\)/g)) {
    const names = m[1].split(",").map((n) => n.trim());
    assert(
      !names.includes("job"),
      `a "by (${m[1].trim()})" grouping retains job; drop it or the SLO splits on every rollout`,
    );
  }
  for (const m of doc.matchAll(/\bwithout\s*\(([^)]*)\)/g)) {
    const names = m[1].split(",").map((n) => n.trim());
    assert(
      names.includes("job"),
      `a "without (${m[1].trim()})" grouping keeps job; every scrape label must go, job included`,
    );
  }
  assert(
    contract.labels.scrapeAttached.jobIsNotAnException.includes("CANARY"),
    "the contract must confine job to canary analysis queries",
  );
});

const canaryTemplate =
  doc.match(/```yaml\n(apiVersion: argoproj\.io[\s\S]*?)```/)?.[1] ?? "";

/**
 * Each `- name: <metric>` block of the canary template, with its query.
 *
 * The C6/C7 gates were originally written against the template as ONE string, which is
 * how they passed while two of three metrics were wrong: a regex `.test()` returns true
 * on the first occurrence, so a guard present on `error-ratio` alone satisfied a check
 * that was meant to hold per metric.
 */
// Sliced from `metrics:` because `spec.args` uses the same `- name:` shape at the same
// indent, and folding the three arg names in made every per-metric assertion fail.
const canaryMetricsBlock = canaryTemplate.slice(
  canaryTemplate.indexOf("\n  metrics:\n") + 1,
);
// Split rather than a lazy match with a `$` lookahead: under /m, `$` matches the end of
// EVERY line, so each captured body stopped at its first newline and the per-metric
// assertions silently inspected one line apiece.
const canaryMetrics = canaryMetricsBlock
  .split(/^ {4}- name: /m)
  .slice(1)
  .map((chunk) => ({
    name: chunk.slice(0, chunk.indexOf("\n")).trim(),
    body: chunk,
  }));

/**
 * Vector-valued subexpressions of `query` that do NOT have a `scalar(` ancestor.
 *
 * Walks the parenthesis nesting rather than matching adjacent text. A regex anchored on
 * `sum(rate(` cannot see `sum by (le) (rate(` -- the grouped form -- and that is exactly
 * where the unwrapped aggregate hid: seven aggregates matched, eight were present.
 *
 * String values are blanked before the walk. `route=~"GET /api/(issues|users)"` is an
 * ordinary canary selector, and its `(` pushed a frame that kept a real `scalar(` on the
 * stack, so a genuinely unwrapped aggregate downstream read as wrapped. The direction was
 * the dangerous one: a `)` in a value was a loud false positive, a `(` a silent miss.
 */
function unscalaredAggregates(query: string): string[] {
  const VECTOR_FNS = new Set(["rate", "increase", "histogram_quantile"]);
  const found: string[] = [];
  const stack: string[] = [];
  const masked = blankStringValues(query);
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "(") {
      const name =
        masked.slice(0, i).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1] ?? "";
      if (VECTOR_FNS.has(name) && !stack.includes("scalar")) found.push(name);
      stack.push(name);
    } else if (masked[i] === ")") {
      stack.pop();
    }
  }
  return found;
}

/**
 * Marks every index of `query` that lies inside a PromQL string literal, quotes included.
 *
 * Three walks below need this, and a hand-rolled `"` toggle in each is how the same
 * blindness keeps reappearing one layer in: a backslash-escaped quote ended the literal
 * early, which put a `(` back into the C6 walk and swallowed `[5m]))>50)` into a C9
 * selector. Backticks are raw -- PromQL reads no escapes inside them.
 */
function stringMask(query: string): boolean[] {
  const mask = new Array<boolean>(query.length).fill(false);
  let quote: string | undefined;
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (quote === undefined) {
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        mask[i] = true;
      }
      continue;
    }
    // A quoted literal cannot span a line. Treating one that does as unterminated keeps a
    // malformed query from masking the rest of the document, which would be a silent miss.
    if (c === "\n" && quote !== "`") {
      quote = undefined;
      continue;
    }
    mask[i] = true;
    if (
      c === "\\" &&
      quote !== "`" &&
      query[i + 1] !== undefined &&
      query[i + 1] !== "\n"
    ) {
      mask[i + 1] = true;
      i++;
      continue;
    }
    if (c === quote) quote = undefined;
  }
  return mask;
}

/** Blanks every PromQL string literal, so a structural character in a value is not read as syntax. */
function blankStringValues(query: string): string {
  const mask = stringMask(query);
  return Array.from(query, (c, i) => (mask[i] ? " " : c)).join("");
}

test("C6: every canary aggregate is wrapped in scalar(), so the absence guard fires", () => {
  assert(
    canaryTemplate.length > 0,
    "the canary AnalysisTemplate block was not found",
  );
  assertEquals(canaryMetrics.length, 3);
  // An empty vector is NOT NaN. rate() over absent series returns nothing, the division
  // never happens, and isNaN(result) never fires -- so an unwrapped guard against "the
  // canary crashed before serving anything" looks correct and does nothing. scalar() of
  // an empty vector IS NaN.
  for (const metric of canaryMetrics) {
    const unscalared = unscalaredAggregates(metric.body);
    assertEquals(
      unscalared.join(","),
      "",
      `canary metric "${metric.name}" has ${unscalared.length} aggregate(s) with no scalar() ancestor (${unscalared.join(", ")}); on no-data it yields an empty vector, which is not NaN, so the !isNaN guard never fires`,
    );
  }
  // Every aggregate is INSPECTED, not merely unrefuted. The previous matcher silently
  // skipped the one that was wrong; this asserts the walker reached all of them.
  const totalAggregates = [
    ...canaryTemplate.matchAll(/\b(?:rate|increase|histogram_quantile)\(/g),
  ].length;
  assertEquals(
    canaryMetrics.reduce(
      (n, m) =>
        n +
        [...m.body.matchAll(/\b(?:rate|increase|histogram_quantile)\(/g)]
          .length,
      0,
    ),
    totalAggregates,
    "some aggregates in the template are outside the per-metric blocks, so the C6 walk did not inspect them",
  );
  assert(
    contract.guarantees.emptyIsNotNaN.includes("scalar()"),
    "the contract must name scalar() as the fix, not just describe the trap",
  );
});

test("the C6 walk is not defeated by a parenthesis inside a label value", () => {
  // Pinned directly on the walker because the checked-in document happens to carry no
  // parenthesised label value: the C6 mutation that proves this only fails while someone
  // remembers to write one into the fixture, and this does not depend on that.
  //
  // The paren must sit in a WRAPPED term that precedes an unwrapped one -- that ordering
  // is the whole defect. A stray frame cannot hide an aggregate the walk already passed,
  // so a one-term case stays green either way and proves nothing.
  const ratio = (numeratorRoute: string) =>
    `scalar(sum(rate(a{route="${numeratorRoute}"}[5m]))) / sum(rate(b{}[5m]))`;

  // The denominator is unwrapped in both. Only the numerator's label value differs.
  assertEquals(unscalaredAggregates(ratio("plain")), ["rate"]);
  assertEquals(unscalaredAggregates(ratio("f(oo")), ["rate"]);
  assertEquals(unscalaredAggregates(ratio("GET /api/(issues|users)")), [
    "rate",
  ]);

  // A backslash-escaped quote does not end the value. Ending it there put the `(` back into
  // the walk, and the unwrapped denominator downstream read as wrapped again.
  assertEquals(unscalaredAggregates(ratio('a\\"b(')), ["rate"]);

  // And the fix must not over-correct into a false positive: same values, nothing unwrapped.
  const sound = (route: string) =>
    `scalar(sum(rate(a{route="${route}"}[5m]))) / scalar(sum(rate(b{}[5m])))`;
  assertEquals(unscalaredAggregates(sound("f(oo")), []);
  assertEquals(unscalaredAggregates(sound("f)oo")), []);
  assertEquals(unscalaredAggregates(sound('a\\"b(')), []);

  // An unterminated quote must not mask the rest of the query -- that is the same silent
  // miss in a new costume. A quoted literal cannot span a line, so it ends at the newline.
  assertEquals(
    unscalaredAggregates(
      'scalar(sum(rate(a{}[5m])))\nroute="oops\nsum(rate(b{}[5m]))',
    ),
    ["rate"],
  );
});

test("the C9 selector split is not defeated by an escaped quote in a value", () => {
  // Same root cause as the C6 walk, different symptom: ending the literal at the escaped
  // quote made the following `}` read as the end of the selector. On a correct document
  // that is a false positive naming a population mismatch that does not exist -- C9
  // extracted `route="a\"}"` as the selector end and swallowed `[5m]))>50)` into a label.
  assertEquals(
    selectorMatchers('rate(a{job="x",route="a\\"}",code!="q"}[5m])'),
    [['job="x"', 'route="a\\"}"', 'code!="q"']],
  );

  // An escaped quote before a comma must not split a value into two matchers either.
  assertEquals(selectorMatchers('rate(a{route="a\\",b",job="x"}[5m])'), [
    ['route="a\\",b"', 'job="x"'],
  ]);

  // Unescaped values still parse exactly as before -- the fix adds no false positive.
  assertEquals(selectorMatchers('rate(a{job="x",code!="q"}[5m])'), [
    ['job="x"', 'code!="q"'],
  ]);
});

test("C7: the canary template cannot pass on no-data and cannot abort before serving", () => {
  const conditions = [
    ...canaryTemplate.matchAll(/(?:success|failure)Condition:\s*"([^"]*)"/g),
  ].map((m) => m[1]);
  assert(
    conditions.length >= 2,
    "no analysis conditions found in the template",
  );
  for (const condition of conditions) {
    // Both conditions guarded means NaN satisfies neither, which is how Argo produces
    // Inconclusive. Must-not-PASS is the requirement; must-fail would roll back every
    // release on a fork with no traffic.
    assert(
      condition.startsWith("!isNaN(result) &&"),
      `"${condition}" does not guard NaN, so no-data resolves to a verdict instead of Inconclusive`,
    );
  }
  // Per metric, not per template. `.test()` on the whole template returns true on the
  // first occurrence, so these passed while two of the three metrics carried neither the
  // sample guard nor its own initialDelay.
  for (const metric of canaryMetrics) {
    for (const field of ["initialDelay:", "inconclusiveLimit:"]) {
      assert(
        metric.body.includes(field),
        `canary metric "${metric.name}" needs ${field}; without it the first measurement runs against an empty [5m] window and two of those exhaust failureLimit`,
      );
    }
    assert(
      /\+ 0 \* scalar\(/.test(metric.body),
      `canary metric "${metric.name}" has no minimum-sample guard: 3 requests with 1 error scores 0.33, clears the 0.01 threshold and aborts a rollout that never served real traffic. 0 * NaN is NaN, which is what makes a low-traffic window Inconclusive`,
    );
  }
  // The wording that pushed the worked example into failing closed.
  assert(
    /must NOT PASS/.test(contract.guarantees.absence),
    "guarantees.absence must require must-not-pass, not a failure condition",
  );
  assert(
    contract.guarantees.absenceIsNotFailure
      .toLowerCase()
      .includes("inconclusive"),
    "the contract must name Inconclusive as the satisfying verdict for no-data",
  );
});

/**
 * Label matcher sets of every `<metric>{...}` selector in `query`, in source order.
 *
 * Quote-aware rather than a regex: `job="{{args.canary-job}}"` puts braces inside a label
 * value, so brace counting that cannot see quotes closes the selector at the wrong place.
 */
function selectorMatchers(query: string): string[][] {
  const mask = stringMask(query);
  const out: string[][] = [];
  for (let i = 0; i < query.length; i++) {
    if (mask[i] || query[i] !== "{") continue;
    if (!/[A-Za-z0-9_]$/.test(query.slice(0, i))) continue;
    let depth = 0;
    let j = i;
    for (; j < query.length; j++) {
      if (mask[j]) continue;
      if (query[j] === "{") depth++;
      else if (query[j] === "}" && --depth === 0) break;
    }
    out.push(splitMatchers(query.slice(i + 1, j)));
    i = j;
  }
  return out;
}

/** Splits a selector body on its top-level commas; a comma inside a value is not one. */
function splitMatchers(body: string): string[] {
  const mask = stringMask(body);
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "," && !mask[i]) {
      parts.push(current);
      current = "";
      continue;
    }
    current += body[i];
  }
  parts.push(current);
  return parts.map((p) => p.replace(/\s+/g, "")).filter((p) => p.length > 0);
}

/** A canary metric's minimum-sample guard selector, split from the expressions it protects. */
function guardSplit(metricBody: string): {
  measured: string[][];
  guard: string[] | undefined;
} {
  const query = metricBody.slice(metricBody.indexOf("query:"));
  const at = query.search(/\+\s*0\s*\*\s*scalar\(/);
  if (at < 0) return { measured: selectorMatchers(query), guard: undefined };
  return {
    measured: selectorMatchers(query.slice(0, at)),
    guard: selectorMatchers(query.slice(at))[0],
  };
}

test("C9: every canary minimum-sample guard counts the population its metric measures", () => {
  // The document states this normatively -- each guard "counts the same population as the
  // ratio it protects" -- and nothing enforced it. The quota gate keys on expressions
  // containing outcome="error", so p99-latency carries none and was skipped entirely: its
  // guard could be satisfied by 900 quota denials and three real requests and still ship.
  //
  // Label SETS are compared, not whole selectors: the guard legitimately counts
  // _count while p99-latency measures _bucket, so the metric name must not participate.
  const key = (m: string[]) => [...m].sort().join(",");
  for (const metric of canaryMetrics) {
    const { measured, guard } = guardSplit(metric.body);
    assert(
      guard !== undefined,
      `canary metric "${metric.name}" has no "+ 0 * scalar(" minimum-sample guard to check`,
    );
    assert(
      measured.length > 0,
      `canary metric "${metric.name}": no selector was found before its guard, so this assertion would compare the guard against nothing and pass vacuously`,
    );
    assert(
      measured.some((m) => key(m) === key(guard)),
      `canary metric "${metric.name}" guards on {${guard.join(",")}}, which matches none of the expressions it protects (${measured
        .map((m) => `{${m.join(",")}}`)
        .join(
          " ",
        )}); a guard over a different population is satisfied by traffic the metric never measures`,
    );
    const narrowest = Math.min(...measured.map((m) => m.length));
    assert(
      guard.length <= narrowest,
      `canary metric "${metric.name}" guards on ${guard.length} matchers while an expression it protects has ${narrowest}; the guard is narrower than the population, so it withholds the verdict until more samples arrive than the metric itself counts`,
    );
  }
  // Every guard is INSPECTED, not merely unrefuted -- the failure mode this whole file
  // keeps rediscovering is a matcher that silently reaches fewer things than it claims.
  assertEquals(
    canaryMetrics.filter((m) => guardSplit(m.body).guard !== undefined).length,
    [...canaryTemplate.matchAll(/\+\s*0\s*\*\s*scalar\(/g)].length,
    "some minimum-sample guards in the template are outside the per-metric blocks, so C9 did not inspect them",
  );
});

test("C8: the burn-rate tiers do not include one that fires inside the budget", () => {
  // At a 99.5% objective a 0.5x burn rate is a 0.25% error ratio, and a service at
  // 0.25% errors is INSIDE its budget -- it would last 60 days against a 30d window.
  // The defect was the factor LIST, not any mention of 0.5x -- the document explains at
  // length why that tier is wrong, so a blanket substring ban would forbid the fix.
  assert(
    !/14\.4x\s*\/\s*6x\s*\/\s*1x\s*\/\s*0\.5x/.test(doc),
    "the 14.4x/6x/1x/0.5x shape is back; its 0.5x tier fires on a service meeting its objective",
  );
  assert(
    /\*\*14\.4 \/ 6 \/ 3 \/ 1\*\*/.test(doc),
    "the document must state the burn factors as 14.4 / 6 / 3 / 1",
  );
  assert(
    /There is no `0\.5x` tier/.test(doc),
    "the document must say why the tier is absent, or someone re-derives it from the standard writeup",
  );
});

test("the v1 freeze point is stated, since four conditions were only free before it", () => {
  assertEquals(contract.compatibility.v1FreezePoint, "merge-to-main");
});

test("adoption distinguishes new services from existing ones", () => {
  assert(
    contract.adoption.new.obligation
      .toLowerCase()
      .includes("first pull request"),
    "new services must be bound from their first pull request",
  );
  assert(
    contract.adoption.existing.obligation.toLowerCase().includes("no retrofit"),
    "existing services must be told plainly that no retrofit is demanded in this window",
  );
});
