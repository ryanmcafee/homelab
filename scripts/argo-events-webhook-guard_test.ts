#!/usr/bin/env -S bun test
/**
 * Proves the blast-radius guard in tests/e2e/argo-events/chainsaw-test.yaml can fail.
 *
 * That step decides whether the argo-events admission webhook sits in front of ArgoCD's
 * own Application and AppProject, which are argoproj.io too. Its first version reported
 * a bounded blast radius on every input: `{range .resources[*]}{.}{end}` yields nothing
 * for an array of plain strings, so the wildcard test compared an empty list and the FAIL
 * branch was unreachable. It passed in CI against the one registration it exists to judge.
 *
 * The webhook process registers that object itself at runtime, so it is in no chart and no
 * render gate can reach it — the guard only runs on Kind, behind a level-2 job. This file
 * closes that gap without a cluster: it extracts the step's script VERBATIM and runs it
 * against local fixtures with a kubectl stand-in, so what is under test is the shipped text
 * rather than a copy of it that can drift.
 *
 *   bun test scripts/argo-events-webhook-guard_test.ts
 */

import { test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "./lib/assert.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "./lib/yaml.ts";

const REPO = join(import.meta.dir, "..");
const SUITE = join(REPO, "tests", "e2e", "argo-events", "chainsaw-test.yaml");
const FIXTURE = join(
  REPO,
  "tests",
  "e2e",
  "argo-events",
  "fixtures",
  "registered-webhook.yaml",
);
const STEP_NAME = "webhook-scope-and-failure-policy";

/** The step's shell script, read out of the suite so this file cannot test a stale copy. */
function guardScript(): string {
  const suite = parseYaml(readFileSync(SUITE, "utf8")) as {
    spec: {
      steps: { name: string; try?: { script?: { content?: string } }[] }[];
    };
  };
  const steps = suite.spec.steps.filter((s) => s.name === STEP_NAME);
  assertEquals(
    steps.length,
    1,
    `expected exactly one step named ${STEP_NAME} in ${SUITE}`,
  );
  const scripts = (steps[0].try ?? []).flatMap((t) =>
    t.script?.content ? [t.script.content] : [],
  );
  assertEquals(
    scripts.length,
    1,
    `expected exactly one try script in step ${STEP_NAME}`,
  );
  return scripts[0];
}

type Webhook = { failurePolicy: string; rules: { resources: string[] }[] };
type Registration = { metadata: { name: string }; webhooks: Webhook[] };

function registered(): Registration {
  return parseYaml(readFileSync(FIXTURE, "utf8")) as Registration;
}

/**
 * Run the guard against one registration with no cluster. The stand-in forwards the two
 * jsonpath reads to `kubectl --local` unchanged — the expression under test is evaluated by
 * the real jsonpath engine — and answers only the name lookup itself, standing in for a
 * cluster holding exactly this object. Every call it serves is logged so a guard that stops
 * reading the registration cannot pass here by reading nothing.
 */
function runGuard(doc: Registration): {
  code: number;
  output: string;
  served: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "argo-events-webhook-guard-"));
  try {
    const manifest = join(dir, "registration.yaml");
    const log = join(dir, "served.log");
    writeFileSync(manifest, stringifyYaml(doc));
    const shim = join(dir, "bin", "kubectl");
    writeFileSync(join(dir, "step.sh"), guardScript());
    Bun.spawnSync(["mkdir", "-p", join(dir, "bin")]);
    writeFileSync(
      shim,
      [
        "#!/bin/sh",
        'real=$(PATH="$GUARD_REAL_PATH" command -v kubectl)',
        '[ "$1 $2" = "get validatingwebhookconfiguration" ] || { echo "unserved: $*" >>"$GUARD_LOG"; exit 0; }',
        "shift 2",
        'if [ "$1" = "-o" ]; then',
        '  echo "list $*" >>"$GUARD_LOG"',
        '  "$real" annotate --local -f "$GUARD_MANIFEST" --dry-run=client -o jsonpath="{.metadata.name}" x=y',
        "  exit 0",
        "fi",
        "shift",
        'echo "read $*" >>"$GUARD_LOG"',
        'exec "$real" annotate --local -f "$GUARD_MANIFEST" --dry-run=client "$@" x=y',
      ].join("\n"),
    );
    chmodSync(shim, 0o755);

    const run = Bun.spawnSync(["sh", join(dir, "step.sh")], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        GUARD_REAL_PATH: process.env.PATH ?? "",
        GUARD_MANIFEST: manifest,
        GUARD_LOG: log,
      },
    });
    let served: string[] = [];
    try {
      served = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      served = [];
    }
    return {
      code: run.exitCode ?? -1,
      output: `${run.stdout.toString()}${run.stderr.toString()}`,
      served,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("kubectl is on PATH, because the guard's jsonpath is evaluated by kubectl itself", () => {
  const which = Bun.spawnSync(["sh", "-c", "command -v kubectl"]);
  assertEquals(
    which.exitCode,
    0,
    "kubectl is missing: mise.toml pins it and verify.yml's policy job must list it in " +
      "install_args. Skipping here instead would leave the guard unproven while reporting pass.",
  );
});

test("the guard passes the registration argo-events actually creates", () => {
  const { code, output, served } = runGuard(registered());
  assertEquals(
    code,
    0,
    `expected the measured registration to pass:\n${output}`,
  );
  assertStringIncludes(output, "OK: blast radius bounded");
  // A guard that stopped reading the registration would still print OK, so the passing case
  // asserts both extractions happened rather than trusting the exit code alone.
  const calls = served.join(" | ");
  assert(
    calls.includes("resources[*]"),
    `the guard never read the intercepted resources: ${calls}`,
  );
  assert(
    calls.includes("failurePolicy"),
    `the guard never read the failure policy: ${calls}`,
  );
  assert(
    !calls.includes("unserved:"),
    `the guard made a call this harness cannot answer: ${calls}`,
  );
});

test("a wildcard rule under failurePolicy Fail is rejected", () => {
  const doc = registered();
  doc.webhooks[0].failurePolicy = "Fail";
  doc.webhooks[0].rules[0].resources = ["*"];
  const { code, output } = runGuard(doc);
  assertEquals(code, 1, `expected wildcard-under-Fail to fail:\n${output}`);
  assertStringIncludes(output, "ArgoCD's own Application and AppProject");
});

test("either property alone stays containable", () => {
  const failOnly = registered();
  failOnly.webhooks[0].failurePolicy = "Fail";
  assertEquals(
    runGuard(failOnly).code,
    0,
    "failurePolicy: Fail over three named kinds is contained",
  );

  const wildcardOnly = registered();
  wildcardOnly.webhooks[0].rules[0].resources = ["*"];
  assertEquals(
    runGuard(wildcardOnly).code,
    0,
    "a wildcard under Ignore fails open, not shut",
  );
});

test("a registration it read nothing from is rejected rather than passed", () => {
  const doc = registered();
  doc.webhooks[0].rules = [];
  const { code, output } = runGuard(doc);
  assertEquals(code, 1, `expected the anti-vacuity branch to fire:\n${output}`);
  assertStringIncludes(output, "would pass without asserting anything");
});
