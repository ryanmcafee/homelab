#!/usr/bin/env -S bun test
/**
 * Render regression for charts/nats-config's storage-budget guard
 * (`nats-config.assertMaxBytesBudget`).
 *
 * The guard's whole audience is a forker sizing their own JetStream file store:
 * homelab and localdev sit far under the ceiling, so nothing else would notice
 * if the check stopped checking. Two ways it can stop: the sum rule itself stops
 * rejecting an overcommitted stream set, or `maxBytesBudgetFraction` accepts a
 * value above the ADR-042 ceiling and the sum is then compared against a budget
 * larger than the store.
 *
 * These are render assertions rather than value assertions on purpose. The
 * static drift gate (nats-streams-contract_test.ts) reads values.yaml, which no
 * `--set` or parent-Application override passes through; only a real
 * `helm template` exercises the override path an operator actually uses.
 *
 *   bun test scripts/nats-budget-guard_test.ts
 */

import { test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertStringIncludes } from "./lib/assert.ts";
import {
  parseAll as parseYamlAll,
  parse as parseYaml,
  stringify as stringifyYaml,
} from "./lib/yaml.ts";

const ROOT = join(import.meta.dir, "..");
const CHART_DIR = join(ROOT, "charts", "nats-config");

/** The ceiling the chart template names; every rejection below is relative to it. */
const CEILING = "0.75";

/** A store smaller than the 6 GiB the four default limits sum to. */
const OVERCOMMITTED_STORE = "4Gi";

interface Render {
  code: number;
  output: string;
}

function render(...args: string[]): Render {
  const proc = Bun.spawnSync([
    "helm",
    "template",
    "nats-config",
    CHART_DIR,
    ...args,
  ]);
  if (proc.exitCode === null) {
    throw new Error(`helm template was killed by a signal: ${proc.signalCode}`);
  }
  return {
    code: proc.exitCode,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

function assertRejected(result: Render, expected: string, what: string): void {
  assert(
    result.code !== 0,
    `${what}: helm template exited 0, so the guard accepted it\n${result.output}`,
  );
  assertStringIncludes(result.output, expected, `${what}: wrong rejection`);
}

function assertRendered(result: Render, what: string): void {
  assert(
    result.code === 0,
    `${what}: helm template exited ${result.code}\n${result.output}`,
  );
  assertStringIncludes(
    result.output,
    "maxBytes:",
    `${what}: rendered no stream`,
  );
}

test("the shipped defaults and both surface value files still render", () => {
  assertRendered(render(), "chart defaults");
  for (const surface of ["homelab", "localdev"]) {
    assertRendered(
      render("-f", join(CHART_DIR, `values-${surface}.yaml`)),
      `values-${surface}.yaml`,
    );
  }
});

test("a stream set summing above the budget is refused", () => {
  assertRejected(
    render("--set", `fileStoreSize=${OVERCOMMITTED_STORE}`),
    "exceeds the 3221225472-byte budget",
    "6 GiB of limits on a 4 GiB store",
  );
});

test("a fraction above the ADR-042 ceiling cannot buy the budget past the store", () => {
  // The defect this file was added for: `maxBytesBudgetFraction` was unbounded,
  // so the same overcommitted stream set that is refused above rendered clean
  // once the fraction was raised, against a 8589934592-byte "budget" on a
  // 4294967296-byte store.
  for (const fraction of ["2", "1", "0.76"]) {
    assertRejected(
      render(
        "--set",
        `fileStoreSize=${OVERCOMMITTED_STORE}`,
        "--set",
        `maxBytesBudgetFraction=${fraction}`,
      ),
      `maxBytesBudgetFraction ${fraction} exceeds the ADR-042 ceiling of ${CEILING}`,
      `fraction ${fraction}`,
    );
  }
});

test("a fraction at or below the ceiling is still honoured, not clamped up", () => {
  // The ceiling must not become the value: a conservative operator's 0.5 has to
  // keep rejecting a stream set that 0.75 would have passed.
  assertRendered(
    render("--set", `maxBytesBudgetFraction=${CEILING}`),
    "at the ceiling",
  );
  assertRejected(
    // 20 GiB * 0.25 = 5 GiB, under the 6 GiB the default limits sum to.
    render("--set", "maxBytesBudgetFraction=0.25"),
    "exceeds the 5368709120-byte budget",
    "a fraction below the ceiling still binds",
  );
});

test("a fraction that is not a finite positive decimal is refused, not coerced", () => {
  // NaN fails every ordered comparison, so a guard written only as `> ceiling`
  // lets it through and then renders a NaN budget that nothing is above.
  for (const fraction of ["NaN", "Inf", "-0.5", "abc", "1e10"]) {
    assertRejected(
      render("--set-string", `maxBytesBudgetFraction=${fraction}`),
      `maxBytesBudgetFraction "${fraction}" is not a finite positive decimal`,
      `fraction ${fraction}`,
    );
  }
  assertRejected(
    render("--set", "maxBytesBudgetFraction=0"),
    "budgets no bytes at all",
    "fraction 0",
  );
  assertRejected(
    render("--set", "maxBytesBudgetFraction=null"),
    "maxBytesBudgetFraction is unset",
    "unset fraction",
  );
});

// ---------------------------------------------------------------------------------------------
// The account level (ADR-043 D8 `jetstream_budget_rule`). nats-server v2.15.0 reserves every
// stream's `max_bytes x replicas` against its account's un-tiered `max_store` and refuses the
// stream that crosses it with `insufficient storage resources (10047)`; the whole-store sum rule
// above cannot see that, because it compares every account's streams against the whole store.
// ---------------------------------------------------------------------------------------------

const GIB = 1024 ** 3;

/** The nats-config arguments that put the stream set inside a tenant account. */
function accountArgs(maxStoreBytes: number | null): string[] {
  const args = [
    "--set",
    "account.name=tenant-probe",
    "--set",
    "account.natsName=TENANT_PROBE",
    "--set",
    "account.credentialSecret=nats-principal-nack",
  ];
  return maxStoreBytes === null
    ? args
    : [...args, "--set", `accountMaxStoreBytes=${maxStoreBytes}`];
}

test("an account's streams reserving more than its max_store are refused", () => {
  // Kind's shipped numbers before MCAA-489: 1152 MiB of limits in a 1 GiB account, which the
  // whole-store rule passed at 56% of the 2 GiB store while the server refuses PF_DLQ.
  assertRejected(
    render("-f", join(CHART_DIR, "values-localdev.yaml"), ...accountArgs(GIB)),
    "reserve 1207959552 bytes against account TENANT_PROBE's 1073741824-byte max_store",
    "localdev limits in a 1 GiB account",
  );
});

test("an account reservation equal to max_store renders, as the server admits it", () => {
  assertRendered(render(...accountArgs(6 * GIB)), "6 GiB of limits in 6 GiB");
});

test("stream replicas multiply the account reservation", () => {
  // Un-tiered account limits count an R3 stream three times; the per-peer store does not.
  assertRejected(
    render("--set", "replicas=3", ...accountArgs(15 * GIB)),
    "reserve 19327352832 bytes",
    "6 GiB of R3 limits in a 15 GiB account",
  );
  assertRendered(
    render("--set", "replicas=3", ...accountArgs(18 * GIB)),
    "6 GiB of R3 limits in an 18 GiB account",
  );
});

test("an account with no max_store is refused rather than left unchecked", () => {
  for (const missing of [null, 0]) {
    assertRejected(
      render(...accountArgs(missing)),
      "accountMaxStoreBytes is unset",
      `maxStoreBytes ${missing}`,
    );
  }
});

const ADDONS_CHART = join(ROOT, "charts", "addons");

/**
 * Values that render the addons accounts block: every non-pending principal from the committed
 * artifact gets a distinct placeholder key, since the chart refuses a partial map.
 */
function accountsBlockValues(nats: Record<string, unknown>): string[] {
  const artifact = parseYaml(
    readFileSync(join(ADDONS_CHART, "files", "nats-accounts.gen.yaml"), "utf8"),
  ) as { principals: { name: string; pending?: string }[] };
  const pairs = artifact.principals
    .filter((p) => p.pending === undefined)
    .map((p, i) => `${p.name}=U${i}SYNTHETICRENDERFIXTURE`);
  const path = join(
    tmpdir(),
    `nats-budget-guard-${process.pid}-${JSON.stringify(nats).length}-${Math.random().toString(36).slice(2)}.yaml`,
  );
  writeFileSync(
    path,
    stringifyYaml({
      nats: {
        enabled: true,
        principalNkeys: pairs.join(","),
        credentials: { bootstrapSeeded: true },
        ...nats,
      },
    }),
  );
  return ["-f", path];
}

function renderAddons(...args: string[]): Render {
  const proc = Bun.spawnSync([
    "helm",
    "template",
    "addons",
    ADDONS_CHART,
    ...args,
  ]);
  if (proc.exitCode === null) {
    throw new Error(`helm template was killed by a signal: ${proc.signalCode}`);
  }
  return {
    code: proc.exitCode,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

function limits(maxStore: string): Record<string, unknown> {
  return {
    accountLimits: {
      max_memory: 0,
      max_store: maxStore,
      max_streams: 16,
      max_consumers: 64,
    },
  };
}

test("accounts whose max_store sums above the store headroom are refused", () => {
  assertRejected(
    renderAddons(
      ...accountsBlockValues({
        ...limits("<< 2GB >>"),
        jetstream: { streamReplicas: 1, storage: { size: "2Gi" } },
      }),
    ),
    "account max_store values sum to 2147483648 bytes, above the 1610612736-byte budget",
    "a 2 GiB account on a 2 GiB store",
  );
});

test("the account budget scales with stream replicas, as each peer holds one replica", () => {
  const rendered = renderAddons(
    ...accountsBlockValues({
      ...limits("<< 4GB >>"),
      jetstream: { streamReplicas: 3, storage: { size: "2Gi" } },
    }),
  );
  assert(
    rendered.code === 0,
    `a 4 GiB R3 account on 2 GiB peers was refused\n${rendered.output}`,
  );
  // The parent hands the parsed limit to nats-config, which checks its streams against it.
  assertStringIncludes(rendered.output, "accountMaxStoreBytes: 4294967296");
});

test("a max_store the server would not parse is refused, not read as zero", () => {
  // nats-server's parser drops an unknown suffix without an error, so the limit silently vanishes.
  for (const bad of ["<< 2XB >>", "<< 1.5GB >>", "lots"]) {
    assertRejected(
      renderAddons(...accountsBlockValues(limits(bad))),
      "is not a NATS size",
      `max_store ${bad}`,
    );
  }
});

/** The values the parent Application hands nats-config, as rendered into tests/snapshots. */
function surfaceInjection(surface: string): {
  fileStoreSize: string;
  replicas: number;
  accountMaxStoreBytes: number;
} {
  const docs = parseYamlAll(
    readFileSync(
      join(ROOT, "tests", "snapshots", surface, "addons.yaml"),
      "utf8",
    ),
  ) as {
    metadata?: { name?: string };
    spec?: { source?: { helm?: { valuesObject?: Record<string, unknown> } } };
  }[];
  const injected = docs.find((doc) => doc?.metadata?.name === "nats-config")
    ?.spec?.source?.helm?.valuesObject;
  assert(
    injected !== undefined,
    `${surface}: the snapshot has no nats-config Application`,
  );
  const { fileStoreSize, replicas, accountMaxStoreBytes } = injected;
  assert(
    typeof fileStoreSize === "string" &&
      typeof replicas === "number" &&
      typeof accountMaxStoreBytes === "number",
    `${surface}: nats-config is not handed fileStoreSize, replicas and accountMaxStoreBytes: ${JSON.stringify(injected)}`,
  );
  return { fileStoreSize, replicas, accountMaxStoreBytes };
}

test("each surface's shipped limits satisfy both levels together", () => {
  for (const surface of ["homelab", "localdev"]) {
    const { fileStoreSize, replicas, accountMaxStoreBytes } =
      surfaceInjection(surface);
    assertRendered(
      render(
        "-f",
        join(CHART_DIR, `values-${surface}.yaml`),
        "--set",
        `fileStoreSize=${fileStoreSize}`,
        "--set",
        `replicas=${replicas}`,
        ...accountArgs(accountMaxStoreBytes),
      ),
      `${surface}: streams within the account`,
    );
    const parent = renderAddons(
      ...accountsBlockValues({
        ...limits(String(accountMaxStoreBytes)),
        jetstream: {
          streamReplicas: replicas,
          storage: { size: fileStoreSize },
        },
      }),
    );
    assert(
      parent.code === 0,
      `${surface}: the account max_store does not fit the file store\n${parent.output}`,
    );
  }
});
