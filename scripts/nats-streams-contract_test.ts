#!/usr/bin/env -S bun test
/**
 * Drift gate between contracts/events/subjects.v1.yaml and the chart that
 * actually creates the streams, charts/nats-config.
 *
 * The contract states the stream set, its retention and its delivery guarantees;
 * charts/nats-config is what a cluster ends up running. Nothing otherwise stops
 * the two from separating, and a stream whose retention silently stopped matching
 * the documented guarantee is the failure this file exists to catch.
 *
 * Every assertion reads both sides. A gate that reads one side's optional fields
 * only is a gate against one direction of drift: a chart that caps a stream the
 * contract leaves uncapped passes, and so does a stream sourcing from the wrong
 * origin (ADR-042).
 *
 * It does not check that the streams exist in a cluster — that is level 2 on Kind
 * (tests/e2e/event-backbone), and it does not add up the maxBytes budget — the
 * chart's own `nats-config.assertMaxBytesBudget` fails the render for that.
 *
 *   bun test scripts/nats-streams-contract_test.ts
 */

import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEquals } from "./lib/assert.ts";
import { parseAll as parseAllYaml, parse as parseYaml } from "./lib/yaml.ts";

const ROOT = join(import.meta.dir, "..");
const CONTRACT_PATH = join(ROOT, "contracts", "events", "subjects.v1.yaml");
const CHART_DIR = join(ROOT, "charts", "nats-config");
const CHART_VALUES_PATH = join(CHART_DIR, "values.yaml");
const SNAPSHOT_DIR = join(ROOT, "tests", "snapshots");

/** The surfaces the parent Application appends a value file for. */
const SURFACES = ["homelab", "localdev"] as const;
type Surface = (typeof SURFACES)[number];

interface ContractStream {
  name: string;
  subjects: string[];
  sources?: { name: string; filters: string[] }[];
  retention: string;
  max_age: string;
  max_bytes?: string;
  max_msg_size?: number;
  discard: string;
  duplicate_window: string;
  delivery: string;
  replicas: string;
}

interface ContractConsumers {
  ack_policy: string;
  max_deliver: number;
  ack_wait: string;
  max_ack_pending: number;
}

interface Contract {
  streams: ContractStream[];
  consumers: ContractConsumers;
  replicas_defaults: { homelab: number };
  max_bytes_defaults: { homelab: Record<string, number> };
}

interface ChartStream {
  name: string;
  subjects?: string[];
  sources?: { name: string; subjectTransforms: { source: string }[] }[];
  retention: string;
  maxAge: string;
  maxMsgSize?: number;
  discard: string;
  duplicateWindow: string;
}

interface ChartValues {
  replicas: number;
  streams: ChartStream[];
  maxBytes?: Record<string, number>;
  fileStoreSize?: string;
  maxBytesBudgetFraction?: number;
  consumerDefaults: {
    ackPolicy: string;
    maxDeliver: number;
    ackWait: string;
    maxAckPending: number;
  };
}

/** The parent Application as rendered into tests/snapshots/<surface>/addons.yaml. */
interface ParentApplication {
  metadata?: { name?: string };
  spec?: { source?: { helm?: { valuesObject?: { fileStoreSize?: string } } } };
}

function readYaml<T>(path: string): T {
  return parseYaml(readFileSync(path, "utf8")) as T;
}

const contract = readYaml<Contract>(CONTRACT_PATH);
const chart = readYaml<ChartValues>(CHART_VALUES_PATH);

/** Each surface's own value file, unmerged: the file a fork edits to resize. */
const surfaceOverrides = new Map<Surface, ChartValues>(
  SURFACES.map((surface) => [
    surface,
    readYaml<ChartValues>(join(CHART_DIR, `values-${surface}.yaml`)) ??
      ({} as ChartValues),
  ]),
);

/**
 * The file store the parent Application injects per surface. Read from the addons
 * snapshot rather than charts/addons/values.yaml: that file is a placeholder, and
 * the real homelab numbers come from configuration/templates/helm-addons.tmpl via
 * `homelab config export`, which the snapshot is rendered from.
 */
const surfaceFileStore = new Map<Surface, string | undefined>(
  SURFACES.map((surface) => {
    const docs = parseAllYaml(
      readFileSync(join(SNAPSHOT_DIR, surface, "addons.yaml"), "utf8"),
    ) as ParentApplication[];
    const app = docs.find((doc) => doc?.metadata?.name === "nats-config");
    return [surface, app?.spec?.source?.helm?.valuesObject?.fileStoreSize];
  }),
);

const chartStreamsByName = new Map(chart.streams.map((s) => [s.name, s]));

test("the chart declares exactly the streams the contract defines", () => {
  assertEquals(
    chart.streams.map((s) => s.name).sort(),
    contract.streams.map((s) => s.name).sort(),
    "chart stream set differs from contracts/events/subjects.v1.yaml",
  );
});

test("every stream's retention, age, discard and dedup window match the contract", () => {
  for (const expected of contract.streams) {
    const actual = chartStreamsByName.get(expected.name);
    assert(actual !== undefined, `chart is missing stream ${expected.name}`);
    assertEquals(
      actual.retention,
      expected.retention,
      `${expected.name}.retention`,
    );
    assertEquals(actual.maxAge, expected.max_age, `${expected.name}.maxAge`);
    assertEquals(actual.discard, expected.discard, `${expected.name}.discard`);
    assertEquals(
      actual.duplicateWindow,
      expected.duplicate_window,
      `${expected.name}.duplicateWindow`,
    );
  }
});

test("maxMsgSize matches the contract in both directions", () => {
  // Asserted symmetrically on purpose. Reading the chart only where the contract
  // declares a cap lets the chart cap a stream the contract leaves uncapped, and
  // a publisher then gets `message size exceeds maximum allowed (10054)` for a
  // message the contract says is legal.
  for (const expected of contract.streams) {
    const actual = chartStreamsByName.get(expected.name);
    assert(actual !== undefined, `chart is missing stream ${expected.name}`);
    assertEquals(
      actual.maxMsgSize,
      expected.max_msg_size,
      `${expected.name}.maxMsgSize`,
    );
  }
});

test("a stream ingests directly or by sourcing, never both", () => {
  for (const expected of contract.streams) {
    const actual = chartStreamsByName.get(expected.name);
    assert(actual !== undefined, `chart is missing stream ${expected.name}`);
    const contractSources = expected.sources ?? [];
    if (contractSources.length > 0) {
      // PF_AUDIT: two streams in one account may not have overlapping subject
      // filters, so a sourced stream must declare no subjects of its own.
      assertEquals(
        actual.subjects ?? [],
        [],
        `${expected.name} sources from another stream and must declare no subjects`,
      );
      // Origin and filter are compared together. A filter checked alone lets a
      // stream source the right subjects from the wrong stream, and a sourced
      // stream whose origin is wrong is silently empty rather than broken.
      const contractPairs = contractSources
        .flatMap((s) => s.filters.map((filter) => `${s.name} ${filter}`))
        .sort();
      const chartPairs = (actual.sources ?? [])
        .flatMap((s) =>
          s.subjectTransforms.map((tr) => `${s.name} ${tr.source}`),
        )
        .sort();
      assertEquals(
        chartPairs,
        contractPairs,
        `${expected.name} sources differ from the contract (origin stream and filter)`,
      );
    } else {
      assertEquals(
        actual.subjects ?? [],
        expected.subjects,
        `${expected.name}.subjects`,
      );
      assertEquals(
        actual.sources ?? [],
        [],
        `${expected.name} ingests directly and must declare no sources`,
      );
    }
  }
});

test("a stream sources each origin stream exactly once", () => {
  // prometheus-nats-exporter labels nats_stream_source_* by source_name alone, so
  // two sources from one origin collide on an identical label set and the whole
  // /metrics scrape returns HTTP 500 - every nats_* series, not just the source
  // ones. Multiple filters belong in subjectTransforms on a single source.
  for (const actual of chart.streams) {
    const origins = (actual.sources ?? []).map((s) => s.name);
    assertEquals(
      [...new Set(origins)].sort(),
      [...origins].sort(),
      `${actual.name} sources the same origin stream more than once; move the extra filters into subjectTransforms`,
    );
    for (const source of actual.sources ?? []) {
      assert(
        source.subjectTransforms.length > 0,
        `${actual.name} sources ${source.name} with no subjectTransforms, which sources the whole stream`,
      );
    }
  }
});

test("stream replicas stay a placeholder in the contract and default to the homelab value", () => {
  for (const expected of contract.streams) {
    assertEquals(
      expected.replicas,
      "<replicas>",
      `${expected.name}.replicas must stay the placeholder: a hard-coded value makes a single-node fork unable to create the stream`,
    );
  }
  assertEquals(
    chart.replicas,
    contract.replicas_defaults.homelab,
    "chart default replicas must match replicas_defaults.homelab",
  );
});

test("stream maxBytes stays a placeholder in the contract and defaults to the homelab values", () => {
  for (const expected of contract.streams) {
    assertEquals(
      expected.max_bytes,
      "<max_bytes>",
      `${expected.name}.max_bytes must stay the placeholder: a committed byte count is one operator's disk, and deleting the field makes the stream's discard policy inert (ADR-042)`,
    );
  }
  assertEquals(
    chart.maxBytes,
    contract.max_bytes_defaults.homelab,
    "chart default maxBytes must match max_bytes_defaults.homelab",
  );
  assertEquals(
    surfaceOverrides.get("homelab")?.maxBytes,
    contract.max_bytes_defaults.homelab,
    "values-homelab.yaml maxBytes must match max_bytes_defaults.homelab",
  );
});

test("every surface sets a positive maxBytes for every stream", () => {
  // JetStream applies `discard` only at `max_bytes`, `max_msgs` or
  // `max_msgs_per_subject`; age expiry ignores it. A stream with no limit never
  // fills, so its discard policy never runs and the only thing it can exhaust is
  // the shared file store — which refuses writes for every stream on the peer
  // with `insufficient resources (10047)` (ADR-042).
  for (const surface of SURFACES) {
    const limits = surfaceOverrides.get(surface)?.maxBytes;
    assert(
      limits !== undefined,
      `charts/nats-config/values-${surface}.yaml sets no maxBytes; the surface a fork renders must name its own budget`,
    );
    for (const stream of contract.streams) {
      const limit = limits[stream.name];
      assert(
        typeof limit === "number" && Number.isInteger(limit) && limit > 0,
        `values-${surface}.yaml maxBytes.${stream.name} must be a positive integer byte count, got ${JSON.stringify(limit)}`,
      );
    }
  }
});

test("each surface budgets against the file store its parent Application injects", () => {
  // The sum rule is checked at render time against this value, so a stale copy
  // leaves the chart budgeting against a store the cluster does not have — and
  // budgeting against a larger one is how the four limits pass the static check
  // and still sum above the real store.
  for (const surface of SURFACES) {
    const declared =
      surfaceOverrides.get(surface)?.fileStoreSize ?? chart.fileStoreSize;
    assertEquals(
      declared,
      surfaceFileStore.get(surface),
      `nats-config fileStoreSize for ${surface} must equal the fileStoreSize the parent Application injects`,
    );
  }
});

test("consumer defaults match the contract", () => {
  assertEquals(chart.consumerDefaults.ackPolicy, contract.consumers.ack_policy);
  assertEquals(
    chart.consumerDefaults.maxDeliver,
    contract.consumers.max_deliver,
  );
  assertEquals(chart.consumerDefaults.ackWait, contract.consumers.ack_wait);
  assertEquals(
    chart.consumerDefaults.maxAckPending,
    contract.consumers.max_ack_pending,
  );
});

test("no stream claims exactly-once delivery", () => {
  for (const stream of contract.streams) {
    assert(
      stream.delivery !== "exactly_once",
      `${stream.name} claims exactly-once delivery; no path on this platform is exactly-once end to end`,
    );
  }
});
