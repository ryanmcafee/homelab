#!/usr/bin/env -S bun test
/**
 * The Sensor dead-letter reachability contract (ADR-049).
 *
 * Argo Events defaults `atLeastOnce` to false, which makes `triggerActions` launch the
 * trigger in a goroutine and return nil immediately (v1.9.11 pkg/sensors/listener.go:372).
 * The dlqTrigger is invoked only from the error branch of the DoWithRetry loop wrapped
 * around that call (listener.go:225), so under the default the dead-letter branch is dead
 * code: a DLQ is configured, a reader trusts it, and it can never be taken. The same
 * defect recurs one level down, because dlqTrigger is itself a Trigger with its own
 * `atLeastOnce` — a DLQ that fires fire-and-forget is acked before the dead-letter write
 * is known to have landed.
 *
 * Both CRDs preserve unknown fields, so none of this is visible to the schema gate.
 * Upstream does reject both arms of the coupling -- validateDlqTrigger at v1.9.11
 * pkg/reconciler/sensor/validate.go:94, reached from ValidateSensor, which the admission
 * webhook, the reconciler and `argo-events lint` all call -- but only at apply time, and
 * admission is failurePolicy: Ignore (ADR-045) so it fails open during rollout. This file
 * is the pre-merge, network-free gate, and the only one that can fail a pull request
 * (ADR-049, amendment 2026-09-29).
 *
 * The rule is one-directional: it forbids only the shape that claims a dead-letter path
 * it cannot take. A Sensor with neither field is honest at-most-once and stays legal, and
 * `retryStrategy` is not required.
 *
 *   bun test scripts/sensor-dlq-contract_test.ts
 */

import { test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEquals } from "./lib/assert.ts";
import { parseAll } from "./lib/yaml.ts";

const SNAPSHOT_ROOT = join(import.meta.dir, "..", "tests", "snapshots");

interface Trigger {
  template?: { name?: string };
  atLeastOnce?: boolean;
  dlqTrigger?: Trigger;
}

interface Sensor {
  kind?: string;
  metadata?: { name?: string };
  spec?: { triggers?: Trigger[] };
}

interface Inspection {
  sensors: number;
  triggers: number;
  dlqTriggers: number;
  violations: string[];
}

function triggerName(trigger: Trigger, fallback: string): string {
  return trigger.template?.name ?? fallback;
}

function inspect(docs: unknown[], origin: string): Inspection {
  const result: Inspection = {
    sensors: 0,
    triggers: 0,
    dlqTriggers: 0,
    violations: [],
  };

  for (const doc of docs) {
    const sensor = doc as Sensor | null;
    if (!sensor || sensor.kind !== "Sensor") continue;
    result.sensors += 1;
    const sensorName = sensor.metadata?.name ?? "<unnamed>";
    const triggers = sensor.spec?.triggers ?? [];

    for (const [index, trigger] of triggers.entries()) {
      result.triggers += 1;
      const where = `${origin} Sensor/${sensorName} trigger ${triggerName(trigger, `#${index}`)}`;
      const dlq = trigger.dlqTrigger;
      if (!dlq) continue;
      result.dlqTriggers += 1;

      if (trigger.atLeastOnce !== true) {
        result.violations.push(
          `${where} declares dlqTrigger without atLeastOnce: true, so triggerActions always returns nil and the dlq branch is unreachable -- set atLeastOnce: true or drop dlqTrigger (ADR-049)`,
        );
      }
      if (dlq.atLeastOnce !== true) {
        result.violations.push(
          `${where} has a dlqTrigger without atLeastOnce: true, so the message is acked while the dead-letter write is still in flight and may fail unobserved -- set atLeastOnce: true on the dlqTrigger (ADR-049)`,
        );
      }
      if (dlq.dlqTrigger) {
        result.violations.push(
          `${where} nests a dlqTrigger inside its dlqTrigger; the dlq is invoked by a direct triggerActions call, never through the retry loop, so a nested dlqTrigger can never be invoked (ADR-049)`,
        );
      }
    }
  }

  return result;
}

function snapshotFiles(): { path: string; origin: string }[] {
  const found: { path: string; origin: string }[] = [];
  for (const surface of readdirSync(SNAPSHOT_ROOT)) {
    const dir = join(SNAPSHOT_ROOT, surface);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      found.push({ path: join(dir, file), origin: `${surface}/${file}` });
    }
  }
  return found;
}

test("every rendered Sensor's dead-letter path is reachable", () => {
  const totals = { sensors: 0, triggers: 0, dlqTriggers: 0 };
  const violations: string[] = [];

  for (const { path, origin } of snapshotFiles()) {
    const result = inspect(parseAll(readFileSync(path, "utf8")), origin);
    totals.sensors += result.sensors;
    totals.triggers += result.triggers;
    totals.dlqTriggers += result.dlqTriggers;
    violations.push(...result.violations);
  }

  // Reported, not asserted non-zero: selfTest.enabled: false legitimately renders no
  // Sensor, so a minimum here would fail an honest fork. The fixtures below are what
  // prove the rule can fail.
  console.log(
    `sensor-dlq contract inspected ${totals.sensors} Sensor(s), ${totals.triggers} trigger(s), ${totals.dlqTriggers} dlqTrigger(s) across ${snapshotFiles().length} snapshot file(s)`,
  );

  assertEquals(
    violations,
    [],
    `unreachable dead-letter path in a rendered Sensor:\n${violations.join("\n")}`,
  );
});

test("the checker rejects a dlqTrigger the retry loop can never reach", () => {
  const result = inspect(
    parseAll(`
kind: Sensor
metadata:
  name: no-at-least-once
spec:
  triggers:
    - template:
        name: work
      dlqTrigger:
        template:
          name: work-dlq
        atLeastOnce: true
`),
    "fixture",
  );

  assertEquals(result.sensors, 1, "fixture must be inspected, not skipped");
  assertEquals(result.dlqTriggers, 1);
  assertEquals(result.violations.length, 1, result.violations.join("\n"));
  assert(
    result.violations[0]!.includes("the dlq branch is unreachable"),
    `expected the unreachable-branch violation, got: ${result.violations[0]}`,
  );
});

test("the checker rejects a dlqTrigger that is itself fire-and-forget", () => {
  const result = inspect(
    parseAll(`
kind: Sensor
metadata:
  name: fire-and-forget-dlq
spec:
  triggers:
    - template:
        name: work
      atLeastOnce: true
      dlqTrigger:
        template:
          name: work-dlq
`),
    "fixture",
  );

  assertEquals(result.dlqTriggers, 1, "fixture must be inspected, not skipped");
  assertEquals(result.violations.length, 1, result.violations.join("\n"));
  assert(
    result.violations[0]!.includes("still in flight"),
    `expected the unobserved-dlq violation, got: ${result.violations[0]}`,
  );
});

test("the checker rejects a dlqTrigger nested inside a dlqTrigger", () => {
  const result = inspect(
    parseAll(`
kind: Sensor
metadata:
  name: nested-dlq
spec:
  triggers:
    - template:
        name: work
      atLeastOnce: true
      dlqTrigger:
        template:
          name: work-dlq
        atLeastOnce: true
        dlqTrigger:
          template:
            name: work-dlq-dlq
          atLeastOnce: true
`),
    "fixture",
  );

  assertEquals(result.violations.length, 1, result.violations.join("\n"));
  assert(
    result.violations[0]!.includes("can never be invoked"),
    `expected the nested-dlq violation, got: ${result.violations[0]}`,
  );
});

test("a compliant Sensor and an honest at-most-once Sensor both pass", () => {
  const result = inspect(
    parseAll(`
kind: Sensor
metadata:
  name: compliant
spec:
  triggers:
    - template:
        name: work
      atLeastOnce: true
      dlqTrigger:
        template:
          name: work-dlq
        atLeastOnce: true
---
kind: Sensor
metadata:
  name: honest-fire-and-forget
spec:
  triggers:
    - template:
        name: notify
---
kind: Sensor
metadata:
  name: retries-without-dlq
spec:
  triggers:
    - template:
        name: work
      atLeastOnce: true
`),
    "fixture",
  );

  assertEquals(result.sensors, 3, "all three fixtures must be inspected");
  assertEquals(result.triggers, 3);
  assertEquals(result.dlqTriggers, 1);
  assertEquals(
    result.violations,
    [],
    `the rule must not reject an honest document:\n${result.violations.join("\n")}`,
  );
});

test("a non-Sensor document is not inspected as one", () => {
  const result = inspect(
    parseAll(`
kind: EventSource
metadata:
  name: not-a-sensor
spec:
  triggers:
    - template:
        name: decoy
      dlqTrigger:
        template:
          name: decoy-dlq
`),
    "fixture",
  );

  assertEquals(result.sensors, 0);
  assertEquals(result.violations, []);
});
