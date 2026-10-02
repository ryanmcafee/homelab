#!/usr/bin/env -S bun test
/**
 * The Kind half of ADR-043's credential seam: the context guard, the reuse rule, and the
 * guarantee that no seed reaches the working tree, a command line or the public map.
 *
 *   bun test scripts/localdev-nats-seeds_test.ts
 */

import { afterEach, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "nkeys.js";
import { assert, assertEquals, assertStringIncludes } from "./lib/assert.ts";
import {
  LOCALDEV_CONTEXT,
  LocaldevSeedError,
  PUBLIC_MAP_PATH,
  SEED_KEY,
  applySecretArgs,
  assertLocaldevContext,
  deliverSeeds,
  publicMapContents,
  readSeedArgs,
  secretManifest,
  seedPlan,
  parsePublicMap,
  writePublicMap,
} from "./localdev-nats-seeds.ts";
import {
  expectedPrincipals,
  readDeclaration,
} from "./nats-principals-keygen.ts";

const temporaries: string[] = [];

afterEach(async () => {
  while (temporaries.length > 0) {
    await rm(temporaries.pop() as string, { recursive: true, force: true });
  }
});

async function repoRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "localdev-seeds-test-"));
  temporaries.push(dir);
  return dir;
}

/** An in-memory cluster: Secret data keyed "<namespace>/<name>", base64 like the API returns. */
function fakeCluster(seeded: Record<string, string> = {}) {
  const applied: string[] = [];
  const data: Record<string, string> = { ...seeded };
  return {
    applied,
    data,
    io: {
      read: async (args: string[]) => {
        const namespace = args[args.indexOf("-n") + 1];
        const name = args[args.indexOf("secret") + 1];
        const value = data[`${namespace}/${name}`];
        return value === undefined
          ? { code: 1, stdout: "" }
          : { code: 0, stdout: Buffer.from(value).toString("base64") };
      },
      apply: async (_args: string[], manifest: string) => {
        applied.push(manifest);
        const parsed = JSON.parse(manifest) as {
          metadata: { name: string; namespace: string };
          stringData: Record<string, string>;
        };
        data[`${parsed.metadata.namespace}/${parsed.metadata.name}`] =
          parsed.stringData[SEED_KEY];
      },
    },
  };
}

// ============================================================================
// The context guard
// ============================================================================

test("only a Kind context may mint seeds", () => {
  assertLocaldevContext(LOCALDEV_CONTEXT);
  assertLocaldevContext("kind-some-other-fork-cluster");

  for (const context of ["homelab", "admin@homelab", "", "localdev"]) {
    let error: unknown;
    try {
      assertLocaldevContext(context);
    } catch (e) {
      error = e;
    }
    assert(
      error instanceof LocaldevSeedError,
      `${context || "<empty>"} must be refused`,
    );
    assertStringIncludes((error as Error).message, LOCALDEV_CONTEXT);
  }
});

test("delivery against a non-Kind context writes nothing", async () => {
  const cluster = fakeCluster();
  let error: unknown;
  try {
    await deliverSeeds(cluster.io, "homelab", "nats");
  } catch (e) {
    error = e;
  }
  assert(error instanceof LocaldevSeedError);
  assertEquals(cluster.applied.length, 0);
});

// ============================================================================
// The plan
// ============================================================================

test("the plan is every non-pending principal, and never $SYS", () => {
  const declaration = readDeclaration();
  const plan = seedPlan("nats");
  const expected = declaration.principals
    .filter((p) => p.pending === undefined)
    .map((p) => p.name);

  assertEquals(
    plan.map((t) => t.principal),
    expected,
  );
  assertEquals(
    plan.every((t) => t.namespace === "nats"),
    true,
  );
  assertEquals(
    plan.map((t) => t.name),
    expected.map((n) => `nats-principal-${n}`),
  );
  // No in-cluster component holds the system account, so Kind mints no $SYS Secret.
  assertEquals(
    plan.some((t) => t.principal === "system"),
    false,
  );
});

// ============================================================================
// The seed never reaches argv
// ============================================================================

test("the kubectl arguments carry no key material", () => {
  const [target] = seedPlan("nats");
  const seed = new TextDecoder().decode(createUser().getSeed());
  const manifest = secretManifest(target, seed);

  for (const args of [
    readSeedArgs(LOCALDEV_CONTEXT, target),
    applySecretArgs(LOCALDEV_CONTEXT, target.namespace),
  ]) {
    assert(
      !args.some((a) => a.includes(seed)),
      "a seed on a command line is in the process table",
    );
  }
  // The manifest is the stdin body, so it is the one place the seed appears.
  assertStringIncludes(manifest, seed);
  assertEquals(applySecretArgs(LOCALDEV_CONTEXT, "nats").at(-1), "-");
});

// ============================================================================
// Delivery and reuse
// ============================================================================

test("delivery mints every missing seed and derives its public key", async () => {
  const cluster = fakeCluster();
  const results = await deliverSeeds(cluster.io, LOCALDEV_CONTEXT, "nats");

  assertEquals(results.length, seedPlan("nats").length);
  assertEquals(cluster.applied.length, results.length);
  assertEquals(
    results.every((r) => r.generated && r.publicKey.startsWith("U")),
    true,
  );
  assertEquals(new Set(results.map((r) => r.publicKey)).size, results.length);
});

test("a rerun reuses every seed already in the cluster and applies nothing", async () => {
  const cluster = fakeCluster();
  const first = await deliverSeeds(cluster.io, LOCALDEV_CONTEXT, "nats");
  cluster.applied.length = 0;

  const second = await deliverSeeds(cluster.io, LOCALDEV_CONTEXT, "nats");
  assertEquals(cluster.applied.length, 0);
  assertEquals(
    second.map((r) => r.publicKey),
    first.map((r) => r.publicKey),
  );
  assertEquals(
    second.every((r) => !r.generated),
    true,
  );
});

test("a partially seeded cluster keeps what is there and mints only the rest", async () => {
  const plan = seedPlan("nats");
  const kept = new TextDecoder().decode(createUser().getSeed());
  const cluster = fakeCluster({
    [`nats/${plan[0].name}`]: kept,
  });

  const results = await deliverSeeds(cluster.io, LOCALDEV_CONTEXT, "nats");
  assertEquals(cluster.applied.length, plan.length - 1);
  assertEquals(results[0].generated, false);
  assertEquals(cluster.data[`nats/${plan[0].name}`], kept);
});

test("a corrupt seed in the cluster fails delivery without reporting its value", async () => {
  const plan = seedPlan("nats");
  const corrupt = "SUNOTAVALIDSEEDATALL";
  const cluster = fakeCluster({ [`nats/${plan[0].name}`]: corrupt });

  let error: unknown;
  try {
    await deliverSeeds(cluster.io, LOCALDEV_CONTEXT, "nats");
  } catch (e) {
    error = e;
  }
  assert(error instanceof Error);
  assertStringIncludes((error as Error).message, "not a valid nkey seed");
  assert(!(error as Error).message.includes(corrupt));
});

// ============================================================================
// The public map
// ============================================================================

test("the public map carries no seed and leaves $SYS empty", async () => {
  const cluster = fakeCluster();
  const results = await deliverSeeds(cluster.io, LOCALDEV_CONTEXT, "nats");
  const root = await repoRoot();
  const { path } = await writePublicMap(root, results);

  assertEquals(path, join(root, PUBLIC_MAP_PATH));
  const contents = await readFile(path, "utf8");
  for (const seed of Object.values(cluster.data)) {
    assert(!contents.includes(seed), "a seed reached the public map");
  }
  assert(!/\bSU[A-Z2-7]{20}/.test(contents), "no seed-shaped token in the map");
  assertStringIncludes(contents, 'NATS_SYSTEM_ACCOUNT_NKEY=""');
  for (const result of results) {
    assertStringIncludes(contents, `${result.principal}=${result.publicKey}`);
  }
});

test("the public map file is private", async () => {
  const cluster = fakeCluster();
  const results = await deliverSeeds(cluster.io, LOCALDEV_CONTEXT, "nats");
  const { path } = await writePublicMap(await repoRoot(), results);
  assertEquals((await stat(path)).mode & 0o777, 0o600);
});

test("the public map is git-ignored so a fork cannot commit it by accident", async () => {
  const ignored = await readFile(
    join(import.meta.dir, "..", ".gitignore"),
    "utf8",
  );
  assertStringIncludes(ignored, ".nats/");
  assertStringIncludes(PUBLIC_MAP_PATH, ".nats/");
});

test("a key that moved since the last write is named, not silently overwritten", async () => {
  // A Secret removed by hand is reminted here, so a configuration already carrying the old public
  // key would have the server refuse that client with nothing to show why. Reuse has to check
  // correspondence with what was published, not only with what is in the cluster.
  const root = await repoRoot();
  const first = fakeCluster();
  const before = await deliverSeeds(first.io, LOCALDEV_CONTEXT, "nats");
  assertEquals((await writePublicMap(root, before)).diverged, []);

  // A fresh cluster mints different material for the same principals.
  const second = fakeCluster();
  const after = await deliverSeeds(second.io, LOCALDEV_CONTEXT, "nats");
  assertEquals(
    (await writePublicMap(root, after)).diverged.sort(),
    before.map((r) => r.principal).sort(),
  );

  // Rewriting the same material reports nothing.
  assertEquals((await writePublicMap(root, after)).diverged, []);
});

test("a map with no earlier write reports no divergence", async () => {
  const cluster = fakeCluster();
  const results = await deliverSeeds(cluster.io, LOCALDEV_CONTEXT, "nats");
  assertEquals((await writePublicMap(await repoRoot(), results)).diverged, []);
  assertEquals(parsePublicMap("").size, 0);
  assertEquals(parsePublicMap('NATS_PRINCIPAL_NKEYS=""').size, 0);
  assertEquals(
    parsePublicMap('NATS_PRINCIPAL_NKEYS="a=U1,b=U2"').get("b"),
    "U2",
  );
});

test("the map names every principal charts/addons will accept a key for", async () => {
  const cluster = fakeCluster();
  const results = await deliverSeeds(cluster.io, LOCALDEV_CONTEXT, "nats");
  const contents = publicMapContents(results);
  const names = (
    contents.match(/NATS_PRINCIPAL_NKEYS="([^"]*)"/) as string[]
  )[1]
    .split(",")
    .map((pair) => pair.split("=")[0]);

  assertEquals(
    names,
    expectedPrincipals(readDeclaration()).filter((n) => n !== "system"),
  );
});
