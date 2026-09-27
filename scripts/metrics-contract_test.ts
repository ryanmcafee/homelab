#!/usr/bin/env -S bun test
/**
 * Consistency tests for contracts/observability/metrics.v1.yaml -- the RED metric
 * contract for first-party control-plane services (ADR-041).
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
}

interface MetricsContract {
  version: number;
  scope: { appliesTo: string; outOfScope: { id: string; path?: string }[] };
  metrics: { name: string; type: string; unit: string; required: boolean }[];
  buckets: {
    boundariesSeconds: number[];
    leLabelValues: string[];
    seriesPerLabelSet: number;
  };
  labels: {
    required: LabelSpec[];
    optional: LabelSpec[];
    scrapeAttached: { names: string[] };
  };
  cardinality: {
    forbiddenLabels: string[];
    ceilings: {
      redFamilySeriesPerReplicaPerTenant: number;
      workedExample: string;
      maxTenantsPerReplica: number;
    };
  };
  exposition: {
    path: string;
    portName: string;
    scrapeIntervalSecondsMax: number;
  };
  guarantees: { delivery: string; ordering: string };
  compatibility: { breaking: string[]; additive: string[] };
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
  const codes = labelByName.get("code")?.enum?.length;
  assert(
    routes !== undefined && codes !== undefined,
    "route and code need ceilings",
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
