#!/usr/bin/env bun
/**
 * Generates one ed25519 user key pair per principal declared in
 * contracts/events/bus-principals.v1.yaml, plus the separate `$SYS` break-glass user, and writes
 * the PRIVATE seeds to an operator-chosen directory outside this repository.
 *
 * PUBLIC keys go to stdout as the two ConfigSet values that flip the bus
 * (`NATS_PRINCIPAL_NKEYS`, `NATS_SYSTEM_ACCOUNT_NKEY`). SEEDS GO NOWHERE BUT THE FILES: not
 * stdout, not stderr, not an error message, not argv. `nk`/`nsc` are not in `mise.toml`, so the
 * key material comes from the pinned nkeys.js the NATS authors publish rather than from
 * hand-written Ed25519 and base32 encoding.
 *
 * `$SYS` takes a USER key (`U...`), not an account key (`A...`): charts/addons renders
 * `nats.systemAccountNkey` into `accounts.$SYS.users[].nkey`, which is a user position. The
 * variable name does not settle that; the renderer does, and `--check` re-asserts it.
 *
 *   bun scripts/nats-principals-keygen.ts --dir ~/.homelab/nats-seeds
 *   bun scripts/nats-principals-keygen.ts --dir ~/.homelab/nats-seeds --check
 *   bun scripts/nats-principals-keygen.ts --dir ~/.homelab/nats-seeds --rotate nack
 *
 * A rerun without `--rotate` NEVER replaces a seed: it validates what is there and prints the
 * same public map, because regenerating a key silently breaks every client still holding the old
 * one. `--rotate <principal>` is the deliberate replacement, and it refuses to run until the
 * previous seed has been moved aside by hand.
 */

import { readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createUser, fromPublic, fromSeed } from "nkeys.js";
import { parse as parseYaml } from "./lib/yaml.ts";

const ROOT = join(import.meta.dir, "..");
const DECLARATION_PATH = join(
  ROOT,
  "contracts",
  "events",
  "bus-principals.v1.yaml",
);

/** The `$SYS` user's file and public-map name. Not a principal: it holds no tenant grant. */
export const SYSTEM_PRINCIPAL = "system";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface DeclaredPrincipal {
  name: string;
  pending?: string;
}

interface Declaration {
  principals: DeclaredPrincipal[];
}

/** A generated or reused key pair. The seed is deliberately absent from this shape. */
export interface PublicEntry {
  principal: string;
  publicKey: string;
  /** false when the seed file already existed and was validated rather than written. */
  generated: boolean;
}

export class KeygenError extends Error {}

// ============================================================================
// The declaration
// ============================================================================

/**
 * The names needing a key pair: every principal the renderer will accept a key for, plus
 * `system`. A `pending` principal is excluded -- charts/addons fails when `principalNkeys` names
 * one, because a credential for a component nothing runs is a key with no owner.
 */
export function expectedPrincipals(declaration: Declaration): string[] {
  const names: string[] = [];
  for (const principal of declaration.principals) {
    if (principal.pending !== undefined) continue;
    if (principal.name === SYSTEM_PRINCIPAL) {
      throw new KeygenError(
        `the declaration names a principal "${SYSTEM_PRINCIPAL}", which collides with the reserved $SYS user file`,
      );
    }
    names.push(principal.name);
  }
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicates.length > 0) {
    throw new KeygenError(
      `the declaration names ${duplicates[0]} more than once; one principal is one credential`,
    );
  }
  return [...names, SYSTEM_PRINCIPAL];
}

export function readDeclaration(path: string = DECLARATION_PATH): Declaration {
  return parseYaml(readFileSync(path, "utf8")) as Declaration;
}

// ============================================================================
// Key material
// ============================================================================

/** `<principal>=<public key>` pairs, in declaration order. Public keys only. */
export function formatPrincipalNkeys(entries: PublicEntry[]): string {
  return entries
    .filter((e) => e.principal !== SYSTEM_PRINCIPAL)
    .map((e) => `${e.principal}=${e.publicKey}`)
    .join(",");
}

export function systemPublicKey(entries: PublicEntry[]): string {
  const entry = entries.find((e) => e.principal === SYSTEM_PRINCIPAL);
  if (entry === undefined) {
    throw new KeygenError(
      `no ${SYSTEM_PRINCIPAL} key pair; charts/addons declares $SYS with no user and the server exits with "error resolving system account"`,
    );
  }
  return entry.publicKey;
}

/**
 * Derives the public key from a seed, naming the principal and NEVER the seed on failure. An
 * error carrying the seed would put it in a log the moment anything catches it.
 */
export function publicKeyFromSeed(principal: string, seed: string): string {
  const trimmed = seed.trim();
  if (!trimmed.startsWith("SU")) {
    throw new KeygenError(
      `the seed for ${principal} is not a user seed (a user seed starts "SU"); charts/addons renders every principal, $SYS included, into a users[] entry, so an account or operator seed is the wrong type`,
    );
  }
  let pair: { getPublicKey(): string };
  try {
    pair = fromSeed(new TextEncoder().encode(trimmed));
  } catch {
    throw new KeygenError(
      `the seed for ${principal} is not a valid nkey seed; its value is not reported`,
    );
  }
  const publicKey = pair.getPublicKey();
  if (!publicKey.startsWith("U")) {
    throw new KeygenError(
      `the seed for ${principal} yields the public key type ${publicKey[0]}, not a user key (U)`,
    );
  }
  return publicKey;
}

/** Rejects anything that is not a public user key -- a seed pasted into public config included. */
export function assertPublicUserKey(principal: string, key: string): void {
  if (key.startsWith("S")) {
    throw new KeygenError(
      `the public key for ${principal} starts "S", which is a SEED; public configuration must never carry a seed`,
    );
  }
  if (!key.startsWith("U")) {
    throw new KeygenError(
      `the public key for ${principal} is type ${key[0]}, not a user key (U); charts/addons renders it into a users[] entry`,
    );
  }
  try {
    fromPublic(key);
  } catch {
    throw new KeygenError(
      `the public key for ${principal} is not a valid nkey`,
    );
  }
}

/** Fails when two principals share a public key, which would make them one identity. */
export function assertDistinct(entries: PublicEntry[]): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const owner = seen.get(entry.publicKey);
    if (owner !== undefined) {
      throw new KeygenError(
        `${entry.principal} and ${owner} share a public key, so they are one identity with the union of two permission sets`,
      );
    }
    seen.set(entry.publicKey, entry.principal);
  }
}

/**
 * Exactly the declared set, no more and no less. A missing member is the case that matters:
 * charts/addons renders an account from whichever keys it is given and the server then refuses
 * the principals that were left out, so a partial map is an outage rather than a fallback.
 */
export function assertCoverage(
  expected: string[],
  entries: PublicEntry[],
): void {
  const have = new Set(entries.map((e) => e.principal));
  const missing = expected.filter((n) => !have.has(n));
  if (missing.length > 0) {
    throw new KeygenError(
      `no key pair for ${missing.join(", ")}; the server refuses every principal absent from the accounts block, so an incomplete map is an outage and never anonymous access`,
    );
  }
  const extra = [...have].filter((n) => !expected.includes(n));
  if (extra.length > 0) {
    throw new KeygenError(
      `${extra.join(", ")} has a key pair but is not a declared, non-pending principal; charts/addons refuses a key with no owner`,
    );
  }
}

// ============================================================================
// Custody
// ============================================================================

export function seedFileName(principal: string): string {
  return `${principal}.nk`;
}

/** The repository is not a credential store: a seed under it is one `git add -A` from committed. */
export function assertOutsideRepository(
  dir: string,
  root: string = ROOT,
): void {
  const resolved = resolve(dir);
  const repo = resolve(root);
  if (resolved === repo || resolved.startsWith(`${repo}/`)) {
    throw new KeygenError(
      `--dir ${dir} is inside the repository; a seed there is one \`git add\` from committed, so the seed directory must live outside the checkout`,
    );
  }
}

/**
 * The seed directory: 0700, and never reached through a symlink. A symlinked directory is how a
 * 0700 mode check passes while the bytes land somewhere world-readable.
 */
async function ensureSeedDir(dir: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(dir);
  } catch {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    return;
  }
  if (info.isSymbolicLink()) {
    throw new KeygenError(
      `--dir ${dir} is a symlink; the seed directory is refused through a link, because the mode of the link says nothing about the mode of its target`,
    );
  }
  if (!info.isDirectory()) {
    throw new KeygenError(`--dir ${dir} exists and is not a directory`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new KeygenError(
      `--dir ${dir} is mode ${(info.mode & 0o777).toString(8)}; seeds need 0700, so group and other must have no access`,
    );
  }
}

/** Reads an existing seed, refusing a symlink or a mode any other user can read. */
async function readExistingSeed(
  path: string,
  principal: string,
): Promise<string | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    return null;
  }
  if (info.isSymbolicLink()) {
    throw new KeygenError(
      `the seed path for ${principal} is a symlink; a linked seed file is refused rather than followed`,
    );
  }
  if (!info.isFile()) {
    throw new KeygenError(
      `the seed path for ${principal} exists and is not a regular file`,
    );
  }
  if ((info.mode & 0o077) !== 0) {
    throw new KeygenError(
      `the seed for ${principal} is mode ${(info.mode & 0o777).toString(8)}; it needs 0600, so fix the mode before reusing it`,
    );
  }
  return await readFile(path, "utf8");
}

/**
 * Writes a seed with exclusive creation at 0600. `wx` is what makes overwrite refusal a property
 * of the syscall rather than of a preceding existence check that a concurrent run can win.
 */
async function writeSeedExclusive(path: string, seed: string): Promise<void> {
  const handle = await open(path, "wx", FILE_MODE);
  try {
    await handle.write(`${seed}\n`);
  } finally {
    await handle.close();
  }
}

// ============================================================================
// Generation
// ============================================================================

export interface GenerateOptions {
  dir: string;
  /** Names to replace. Each must already have had its old seed moved aside. */
  rotate?: readonly string[];
  /** Validate and report only; never create a file. */
  check?: boolean;
}

/**
 * Reuses every seed already present, generates the rest, and returns the public map. Never
 * replaces an existing seed unless its principal is named in `rotate`.
 */
export async function generate(
  expected: readonly string[],
  options: GenerateOptions,
): Promise<PublicEntry[]> {
  assertOutsideRepository(options.dir);
  const rotate = new Set(options.rotate ?? []);
  for (const name of rotate) {
    if (!expected.includes(name)) {
      throw new KeygenError(
        `--rotate ${name} is not a declared, non-pending principal`,
      );
    }
  }
  if (!options.check) await ensureSeedDir(options.dir);

  const entries: PublicEntry[] = [];
  for (const principal of expected) {
    const path = join(options.dir, seedFileName(principal));
    const existing = await readExistingSeed(path, principal);
    if (existing !== null) {
      if (rotate.has(principal)) {
        throw new KeygenError(
          `--rotate ${principal} but ${path} still exists; move the old seed aside first, so a rotation cannot destroy the credential it is replacing before the new one is proven`,
        );
      }
      entries.push({
        principal,
        publicKey: publicKeyFromSeed(principal, existing),
        generated: false,
      });
      continue;
    }
    if (options.check) {
      throw new KeygenError(
        `no seed for ${principal} in ${options.dir}; run \`bun scripts/nats-principals-keygen.ts --dir ${options.dir}\` to create the missing pairs`,
      );
    }
    const pair = createUser();
    const seed = new TextDecoder().decode(pair.getSeed());
    try {
      await writeSeedExclusive(path, seed);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new KeygenError(
          `${path} appeared while generating; nothing was overwritten -- rerun to reuse it`,
        );
      }
      throw new KeygenError(
        `could not write the seed for ${principal}: ${
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "unknown error"
        }`,
      );
    }
    entries.push({
      principal,
      publicKey: publicKeyFromSeed(principal, seed),
      generated: true,
    });
  }

  for (const entry of entries)
    assertPublicUserKey(entry.principal, entry.publicKey);
  assertDistinct(entries);
  assertCoverage([...expected], entries);
  return entries;
}

/** Seed files in the directory that no longer match a declared principal. */
export async function orphanedSeeds(
  dir: string,
  expected: readonly string[],
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const wanted = new Set(expected.map(seedFileName));
  return names.filter((n) => n.endsWith(".nk") && !wanted.has(n)).sort();
}

// ============================================================================
// Entry point
// ============================================================================

export interface Args {
  dir: string;
  rotate: string[];
  check: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dir: "", rotate: [], check: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--check") {
      args.check = true;
    } else if (flag === "--dir" || flag === "--rotate") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${flag} needs a value`);
      }
      if (flag === "--dir") args.dir = value;
      else args.rotate.push(value);
    } else {
      throw new UsageError(`unknown argument ${flag}`);
    }
  }
  if (!args.dir) {
    throw new UsageError(
      "--dir <seed directory outside the repository> is required; there is no default, because a default seed directory is a seed directory nobody chose",
    );
  }
  if (!isAbsolute(args.dir) && !args.dir.startsWith("~")) {
    throw new UsageError(
      `--dir ${args.dir} is relative; pass an absolute path so the seeds do not follow the working directory`,
    );
  }
  return args;
}

export function expandHome(dir: string, home: string | undefined): string {
  if (dir === "~") return home ?? dir;
  if (!dir.startsWith("~/")) return dir;
  if (!home) {
    throw new UsageError(`cannot expand ${dir}: HOME is unset`);
  }
  return join(home, dir.slice(2));
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const dir = expandHome(args.dir, process.env.HOME);
    const expected = expectedPrincipals(readDeclaration());
    const entries = await generate(expected, {
      dir,
      rotate: args.rotate,
      check: args.check,
    });
    const orphans = await orphanedSeeds(dir, expected);
    const info = await stat(dir);

    // Public keys only. Every seed stays in the directory reported here by path.
    console.log(`# seeds: ${dir} (mode ${(info.mode & 0o777).toString(8)})`);
    console.log(
      `# ${entries.filter((e) => e.generated).length} generated, ${
        entries.filter((e) => !e.generated).length
      } reused`,
    );
    if (orphans.length > 0) {
      console.log(`# no longer declared, left in place: ${orphans.join(", ")}`);
    }
    console.log(`NATS_PRINCIPAL_NKEYS="${formatPrincipalNkeys(entries)}"`);
    console.log(`NATS_SYSTEM_ACCOUNT_NKEY="${systemPublicKey(entries)}"`);
  } catch (error) {
    // Only this script's own messages reach stderr, and none of them carries a seed.
    console.error(
      error instanceof KeygenError || error instanceof UsageError
        ? error.message
        : "nats-principals-keygen failed; the error is withheld because an unexpected failure can carry key material",
    );
    process.exit(1);
  }
}
