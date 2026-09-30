/**
 * Guards the Kind registry pull-through cache in .github/workflows/tilt-ci.yml
 * (MCAA-660). actions/cache declares `post-if: success()`, so a combined step
 * never saves on the failing runs a cold cache causes, and a save on a PR ref
 * is invisible to main and every other PR. The cache must be an explicit
 * restore plus an always() save that only runs on main pushes.
 *
 *   bun test scripts/tilt-ci-cache_test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "./lib/assert.ts";
import { parse } from "./lib/yaml.ts";

const WORKFLOW = join(import.meta.dir, "..", ".github/workflows/tilt-ci.yml");
const CACHE_PATH = "~/.cache/homelab-kind-registry";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindArgocdSteps(): Step[] {
  const doc = parse(readFileSync(WORKFLOW, "utf8"));
  assert(isRecord(doc) && isRecord(doc.jobs), "tilt-ci.yml has no jobs");
  const job = doc.jobs["kind-argocd"];
  assert(isRecord(job) && Array.isArray(job.steps), "no kind-argocd steps");
  return job.steps.filter(isRecord);
}

function registryCacheSteps(steps: Step[]): Step[] {
  return steps.filter((s) => s.with?.path === CACHE_PATH);
}

test("no combined actions/cache step owns the registry cache", () => {
  const combined = registryCacheSteps(kindArgocdSteps()).filter((s) =>
    s.uses?.startsWith("actions/cache@"),
  );
  assertEquals(
    combined.map((s) => s.name),
    [],
    "actions/cache inherits post-if: success() and skips the save on failure",
  );
});

test("the registry cache is restored before the Kind loop runs", () => {
  const steps = kindArgocdSteps();
  const restore = steps.findIndex(
    (s) =>
      s.with?.path === CACHE_PATH &&
      s.uses?.startsWith("actions/cache/restore@"),
  );
  const loop = steps.findIndex((s) => s.name === "task localdev:ci");
  assert(restore >= 0, "no actions/cache/restore step for the registry cache");
  assert(restore < loop, "restore must run before task localdev:ci");
});

test("the registry cache is saved on failure, from main pushes only", () => {
  const steps = kindArgocdSteps();
  const saveIndex = steps.findIndex(
    (s) =>
      s.with?.path === CACHE_PATH && s.uses?.startsWith("actions/cache/save@"),
  );
  assert(saveIndex >= 0, "no actions/cache/save step for the registry cache");
  const verify = steps.findIndex((s) => s.id === "verify");
  assert(saveIndex > verify, "save must run after task verify LEVEL=2");
  const condition = steps[saveIndex].if ?? "";
  assertStringIncludes(condition, "always()");
  assertStringIncludes(condition, "github.event_name == 'push'");
  assertStringIncludes(condition, "github.ref == 'refs/heads/main'");
});

test("every save key is unique per blob set, so a warmer cache is not dropped", () => {
  const save = registryCacheSteps(kindArgocdSteps()).find((s) =>
    s.uses?.startsWith("actions/cache/save@"),
  );
  const key = String(save?.with?.key ?? "");
  assertStringIncludes(key, "steps.registry-blobs.outputs.fingerprint");
});
