#!/usr/bin/env -S bun test
/**
 * The custody half of ADR-043's credential seam: what scripts/nats-principals-keygen.ts must
 * refuse, and what it must never emit.
 *
 * Every case uses fresh ephemeral material in a temporary directory. There is no committed seed
 * fixture, because a committed seed is a committed secret whatever the file is called -- so the
 * "a seed never reaches stdout" assertions run the real generator and read the real bytes it
 * printed rather than a recorded transcript.
 *
 *   bun test scripts/nats-principals-keygen_test.ts
 */

import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount, createUser } from "nkeys.js";
import { assert, assertEquals, assertStringIncludes } from "./lib/assert.ts";
import {
  KeygenError,
  SYSTEM_PRINCIPAL,
  UsageError,
  assertCoverage,
  assertDistinct,
  assertPublicUserKey,
  expandHome,
  expectedPrincipals,
  formatPrincipalNkeys,
  generate,
  orphanedSeeds,
  parseArgs,
  publicKeyFromSeed,
  readDeclaration,
  seedFileName,
  systemPublicKey,
} from "./nats-principals-keygen.ts";

const temporaries: string[] = [];

async function seedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nats-keygen-test-"));
  temporaries.push(dir);
  return dir;
}

afterEach(async () => {
  while (temporaries.length > 0) {
    await rm(temporaries.pop() as string, { recursive: true, force: true });
  }
});

function freshSeed(): string {
  return new TextDecoder().decode(createUser().getSeed());
}

async function rejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection, got none");
}

// ============================================================================
// 1. The exact contract principal set, distinct keys, correctly typed system key
// ============================================================================

test("the expected set is every non-pending declared principal plus the $SYS user", () => {
  const declaration = readDeclaration();
  const expected = expectedPrincipals(declaration);
  const pending = declaration.principals
    .filter((p) => p.pending !== undefined)
    .map((p) => p.name);

  assert(
    pending.length > 0,
    "the declaration should still carry a pending principal",
  );
  for (const name of pending) {
    assert(
      !expected.includes(name),
      `${name} is pending, so charts/addons refuses a key for it and none is generated`,
    );
  }
  for (const principal of declaration.principals) {
    if (principal.pending !== undefined) continue;
    assert(
      expected.includes(principal.name),
      `${principal.name} needs a key pair`,
    );
  }
  assert(
    expected.includes(SYSTEM_PRINCIPAL),
    "$SYS needs its own user credential",
  );
});

test("generate covers the declared set with distinct, correctly typed user keys", async () => {
  const expected = expectedPrincipals(readDeclaration());
  const entries = await generate(expected, { dir: await seedDir() });

  assertEquals(entries.length, expected.length);
  assertEquals(new Set(entries.map((e) => e.publicKey)).size, expected.length);
  for (const entry of entries) {
    assert(
      entry.publicKey.startsWith("U"),
      `${entry.principal} must hold a user key`,
    );
    assertEquals(entry.publicKey.length, 56);
  }
  // $SYS renders into accounts.$SYS.users[].nkey, a USER position: the variable name
  // NATS_SYSTEM_ACCOUNT_NKEY does not make it an account key.
  assert(
    systemPublicKey(entries).startsWith("U"),
    "the $SYS credential is a user key",
  );
  assert(
    !formatPrincipalNkeys(entries).includes(`${SYSTEM_PRINCIPAL}=`),
    "the $SYS key belongs to NATS_SYSTEM_ACCOUNT_NKEY, not the tenant principal map",
  );
});

test("two clean environments never share key material", async () => {
  const expected = expectedPrincipals(readDeclaration());
  const first = await generate(expected, { dir: await seedDir() });
  const second = await generate(expected, { dir: await seedDir() });

  const overlap = first
    .map((e) => e.publicKey)
    .filter((k) => second.some((e) => e.publicKey === k));
  assertEquals(overlap.length, 0);
});

test("the public map is the declared principals in declaration order", async () => {
  const declaration = readDeclaration();
  const expected = expectedPrincipals(declaration);
  const entries = await generate(expected, { dir: await seedDir() });
  const names = formatPrincipalNkeys(entries)
    .split(",")
    .map((pair) => pair.split("=")[0]);

  assertEquals(
    names,
    declaration.principals
      .filter((p) => p.pending === undefined)
      .map((p) => p.name),
  );
});

// ============================================================================
// 2. Seeds never leave the directory; modes, symlinks, overwrite, rerun
// ============================================================================

test("no seed reaches stdout, stderr or the printed public map", async () => {
  const dir = await seedDir();
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      join(import.meta.dir, "nats-principals-keygen.ts"),
      "--dir",
      dir,
    ],
  });
  assertEquals(proc.exitCode, 0);
  const captured = `${proc.stdout.toString()}${proc.stderr.toString()}`;

  for (const principal of expectedPrincipals(readDeclaration())) {
    const seed = (
      await readFile(join(dir, seedFileName(principal)), "utf8")
    ).trim();
    assert(seed.startsWith("SU"), `${principal}'s file holds a user seed`);
    assert(
      !captured.includes(seed),
      `${principal}'s seed appeared in the generator's own output`,
    );
  }
  assert(
    !/\bSU[A-Z2-7]{20}/.test(captured),
    "no seed-shaped token in the output",
  );
  assertStringIncludes(captured, "NATS_PRINCIPAL_NKEYS=");
});

test("seed files are 0600 in a 0700 directory", async () => {
  const dir = await seedDir();
  await chmod(dir, 0o700);
  await generate(["nack", SYSTEM_PRINCIPAL], { dir });

  assertEquals(Bun.file(join(dir, "nack.nk")).size > 0, true);
  const { mode } = await Bun.file(join(dir, "nack.nk")).stat();
  assertEquals(mode & 0o777, 0o600);
});

test("a group- or world-readable seed directory is refused", async () => {
  const dir = await seedDir();
  await chmod(dir, 0o755);
  assertStringIncludes(
    (await rejects(() => generate(["nack"], { dir }))).message,
    "seeds need 0700",
  );
});

test("a symlinked seed directory is refused rather than followed", async () => {
  const real = await seedDir();
  const link = `${real}-link`;
  temporaries.push(link);
  await symlink(real, link);
  assertStringIncludes(
    (await rejects(() => generate(["nack"], { dir: link }))).message,
    "is a symlink",
  );
});

test("a symlinked seed file is refused rather than followed", async () => {
  const dir = await seedDir();
  const target = join(dir, "elsewhere");
  await writeFile(target, `${freshSeed()}\n`, { mode: 0o600 });
  await symlink(target, join(dir, seedFileName("nack")));
  assertStringIncludes(
    (await rejects(() => generate(["nack"], { dir }))).message,
    "is a symlink",
  );
});

test("a rerun reuses every seed and never rewrites one", async () => {
  const dir = await seedDir();
  const expected = ["nack", "verify", SYSTEM_PRINCIPAL];
  const first = await generate(expected, { dir });
  const before = await readFile(join(dir, "nack.nk"), "utf8");

  const second = await generate(expected, { dir });
  assertEquals(
    second.map((e) => e.publicKey),
    first.map((e) => e.publicKey),
  );
  assertEquals(
    second.every((e) => !e.generated),
    true,
  );
  assertEquals(await readFile(join(dir, "nack.nk"), "utf8"), before);
});

test("a partial directory generates only the missing pairs and keeps the rest", async () => {
  const dir = await seedDir();
  await generate(["nack"], { dir });
  const kept = await readFile(join(dir, "nack.nk"), "utf8");

  const entries = await generate(["nack", "verify", SYSTEM_PRINCIPAL], { dir });
  assertEquals(await readFile(join(dir, "nack.nk"), "utf8"), kept);
  assertEquals(
    entries.filter((e) => e.generated).map((e) => e.principal),
    ["verify", SYSTEM_PRINCIPAL],
  );
});

test("--rotate refuses to run while the old seed is still in place", async () => {
  const dir = await seedDir();
  await generate(["nack"], { dir });
  const error = await rejects(() =>
    generate(["nack"], { dir, rotate: ["nack"] }),
  );
  assertStringIncludes(error.message, "move the old seed aside first");
  assert(error instanceof KeygenError);
});

test("--rotate mints a new pair once the old seed is moved aside", async () => {
  const dir = await seedDir();
  const [before] = await generate(["nack"], { dir });
  await rm(join(dir, "nack.nk"));

  const [after] = await generate(["nack"], { dir, rotate: ["nack"] });
  assert(after.publicKey !== before.publicKey, "rotation must change the key");
  assertEquals(after.generated, true);
});

test("--check reports without creating anything", async () => {
  const dir = await seedDir();
  const error = await rejects(() => generate(["nack"], { dir, check: true }));
  assertStringIncludes(error.message, "no seed for nack");
  assertEquals(await orphanedSeeds(dir, []), []);
});

test("a seed no longer declared is reported and left in place, never deleted", async () => {
  const dir = await seedDir();
  await generate(["nack", "retired-principal"], { dir });
  assertEquals(await orphanedSeeds(dir, ["nack"]), ["retired-principal.nk"]);
  assertEquals(
    (await readFile(join(dir, "retired-principal.nk"), "utf8")).length > 0,
    true,
  );
});

// ============================================================================
// 3. Invalid material fails before activation, without exposing its value
// ============================================================================

test("a corrupt seed fails and its value is not in the message", async () => {
  const dir = await seedDir();
  const corrupt = "SUNOTAVALIDSEEDATALL";
  await writeFile(join(dir, seedFileName("nack")), `${corrupt}\n`, {
    mode: 0o600,
  });

  const error = await rejects(() => generate(["nack"], { dir }));
  assertStringIncludes(error.message, "not a valid nkey seed");
  assert(
    !error.message.includes(corrupt),
    "the message must not carry the seed",
  );
});

test("an account seed is rejected as the wrong type for a users[] entry", () => {
  // Minted here rather than written down: a seed-shaped literal in a test file is the thing a
  // secret scanner is right to flag, and an invalid one would not exercise the real type check.
  const accountSeed = new TextDecoder().decode(createAccount().getSeed());
  const error = (() => {
    try {
      publicKeyFromSeed("system", accountSeed);
    } catch (e) {
      return e as Error;
    }
    throw new Error("expected a rejection");
  })();
  assertStringIncludes(error.message, "not a user seed");
});

test("a seed pasted into the public map is rejected", () => {
  const error = (() => {
    try {
      assertPublicUserKey("nack", freshSeed());
    } catch (e) {
      return e as Error;
    }
    throw new Error("expected a rejection");
  })();
  assertStringIncludes(error.message, "which is a SEED");
});

test("a duplicate public key is rejected, so two principals cannot be one identity", () => {
  const shared = createUser().getPublicKey();
  const error = (() => {
    try {
      assertDistinct([
        { principal: "nack", publicKey: shared, generated: true },
        { principal: "verify", publicKey: shared, generated: true },
      ]);
    } catch (e) {
      return e as Error;
    }
    throw new Error("expected a rejection");
  })();
  assertStringIncludes(error.message, "share a public key");
});

test("a missing map member fails and never reads as anonymous fallback", () => {
  const key = createUser().getPublicKey();
  const error = (() => {
    try {
      assertCoverage(
        ["nack", "verify"],
        [{ principal: "nack", publicKey: key, generated: true }],
      );
    } catch (e) {
      return e as Error;
    }
    throw new Error("expected a rejection");
  })();
  assertStringIncludes(error.message, "no key pair for verify");
  assertStringIncludes(error.message, "never anonymous access");
});

test("a key for an undeclared principal is rejected", () => {
  const key = createUser().getPublicKey();
  const error = (() => {
    try {
      assertCoverage(
        ["nack"],
        [
          { principal: "nack", publicKey: key, generated: true },
          {
            principal: "ghost",
            publicKey: createUser().getPublicKey(),
            generated: true,
          },
        ],
      );
    } catch (e) {
      return e as Error;
    }
    throw new Error("expected a rejection");
  })();
  assertStringIncludes(error.message, "ghost");
});

// ============================================================================
// Argument handling: the seed directory is chosen, never defaulted or inferred
// ============================================================================

test("--dir is required, absolute, and never inside the repository", async () => {
  expect(() => parseArgs([])).toThrow(UsageError);
  expect(() => parseArgs(["--dir", "relative/path"])).toThrow(/relative/);
  expect(() => parseArgs(["--dir"])).toThrow(/needs a value/);
  expect(() => parseArgs(["--seed", "SU..."])).toThrow(/unknown argument/);

  const inside = join(import.meta.dir, "..", "seeds");
  assertStringIncludes(
    (await rejects(() => generate(["nack"], { dir: inside }))).message,
    "inside the repository",
  );
});

test("--rotate names a declared principal", async () => {
  const dir = await seedDir();
  assertStringIncludes(
    (
      await rejects(() =>
        generate(["nack"], { dir, rotate: ["not-a-principal"] }),
      )
    ).message,
    "not a declared, non-pending principal",
  );
});

test("a home-relative directory expands, and fails loudly when HOME is unset", () => {
  assertEquals(expandHome("~/nats", "/home/op"), "/home/op/nats");
  assertEquals(expandHome("/abs/nats", undefined), "/abs/nats");
  expect(() => expandHome("~/nats", undefined)).toThrow(UsageError);
});
