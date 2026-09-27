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
 * It does not check that the streams exist in a cluster — that is level 2 on Kind
 * (tests/e2e/event-backbone).
 *
 *   bun test scripts/nats-streams-contract_test.ts
 */

import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEquals } from "./lib/assert.ts";
import { parse as parseYaml } from "./lib/yaml.ts";

const ROOT = join(import.meta.dir, "..");
const CONTRACT_PATH = join(ROOT, "contracts", "events", "subjects.v1.yaml");
const CHART_VALUES_PATH = join(ROOT, "charts", "nats-config", "values.yaml");

interface ContractStream {
  name: string;
  subjects: string[];
  sources?: { name: string; filters: string[] }[];
  retention: string;
  max_age: string;
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
}

interface ChartStream {
  name: string;
  subjects?: string[];
  sources?: { name: string; filterSubject: string }[];
  retention: string;
  maxAge: string;
  maxMsgSize?: number;
  discard: string;
  duplicateWindow: string;
}

interface ChartValues {
  replicas: number;
  streams: ChartStream[];
  consumerDefaults: {
    ackPolicy: string;
    maxDeliver: number;
    ackWait: string;
    maxAckPending: number;
  };
}

const contract = parseYaml(readFileSync(CONTRACT_PATH, "utf8")) as Contract;
const chart = parseYaml(readFileSync(CHART_VALUES_PATH, "utf8")) as ChartValues;

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
    assertEquals(actual.retention, expected.retention, `${expected.name}.retention`);
    assertEquals(actual.maxAge, expected.max_age, `${expected.name}.maxAge`);
    assertEquals(actual.discard, expected.discard, `${expected.name}.discard`);
    assertEquals(
      actual.duplicateWindow,
      expected.duplicate_window,
      `${expected.name}.duplicateWindow`,
    );
    if (expected.max_msg_size !== undefined) {
      assertEquals(
        actual.maxMsgSize,
        expected.max_msg_size,
        `${expected.name}.maxMsgSize`,
      );
    }
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
      const contractFilters = contractSources.flatMap((s) => s.filters).sort();
      const chartFilters = (actual.sources ?? []).map((s) => s.filterSubject).sort();
      assertEquals(
        chartFilters,
        contractFilters,
        `${expected.name} source filters differ from the contract`,
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

test("consumer defaults match the contract", () => {
  assertEquals(chart.consumerDefaults.ackPolicy, contract.consumers.ack_policy);
  assertEquals(chart.consumerDefaults.maxDeliver, contract.consumers.max_deliver);
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
