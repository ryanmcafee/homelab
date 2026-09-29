#!/usr/bin/env bun
/**
 * Mints the ADR-043 principal seeds for Kind and delivers them straight to Secrets.
 *
 * Kind has no 1Password, and a committed Kind seed is still a committed secret, so the key
 * material is generated at bootstrap and exists only inside the cluster. The seed is never
 * written to the working tree; the PUBLIC half is, at `.nats/localdev-principal-nkeys.env`
 * (git-ignored), because `NATS_PRINCIPAL_NKEYS` has to be readable by the operator who flips the
 * bus.
 *
 * ACTIVATION IS A SEPARATE STEP. Delivering the seeds leaves the bus exactly as it was: the
 * server only starts refusing unauthenticated clients once `NATS_PRINCIPAL_NKEYS` is set and the
 * addons values are re-rendered, and every `nats` call site has to hold a named context by then
 * (MCAA-487). Seeds first, activation second, is what stops a half-landed flip.
 *
 * Every mutation goes through an explicit Kind context guard. `kubectl get` against the wrong
 * context exits 0 with empty results, so a missing guard is how a localdev step writes into
 * homelab and reports success.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SYSTEM_PRINCIPAL,
  assertDistinct,
  assertPublicUserKey,
  expectedPrincipals,
  formatPrincipalNkeys,
  publicKeyFromSeed,
  readDeclaration,
} from "./nats-principals-keygen.ts";
import { createUser } from "nkeys.js";

/** The default localdev context. Only Kind creates a `kind-` prefixed context. */
export const LOCALDEV_CONTEXT = "kind-homelab-localdev";
const KIND_CONTEXT_PREFIX = "kind-";

/** Secret key the addons chart and NACK both read (`nats.credentialSecretPrefix` + `nats.nk`). */
export const SEED_KEY = "nats.nk";
export const SECRET_PREFIX = "nats-principal-";

/** Public keys only; a seed never reaches the working tree. Git-ignored. */
export const PUBLIC_MAP_PATH = join(".nats", "localdev-principal-nkeys.env");

export interface SeedTarget {
  principal: string;
  namespace: string;
  name: string;
}

export interface SeedResult {
  principal: string;
  publicKey: string;
  generated: boolean;
}

export class LocaldevSeedError extends Error {}

/**
 * Refuses any context Kind did not create. The homelab context has no `kind-` prefix, so this is
 * the difference between minting throwaway credentials and writing a Secret into production.
 */
export function assertLocaldevContext(context: string): void {
  if (!context.startsWith(KIND_CONTEXT_PREFIX)) {
    throw new LocaldevSeedError(
      `refusing to mint NATS seeds against context ${context}: only a Kind context (${LOCALDEV_CONTEXT}) generates its own key material, and every other surface takes its seeds from a vault`,
    );
  }
}

/**
 * One Secret per principal, in the bus namespace. `$SYS` is excluded: no platform component holds
 * the system account, so a Kind `$SYS` Secret would put a break-glass credential next to every
 * ordinary client for no consumer (ADR-043 D4).
 */
export function seedPlan(namespace: string): SeedTarget[] {
  return expectedPrincipals(readDeclaration())
    .filter((principal) => principal !== SYSTEM_PRINCIPAL)
    .map((principal) => ({
      principal,
      namespace,
      name: `${SECRET_PREFIX}${principal}`,
    }));
}

/** The kubectl arguments that read one seed back. Never logged with its output. */
export function readSeedArgs(context: string, target: SeedTarget): string[] {
  return [
    "kubectl",
    "--context",
    context,
    "-n",
    target.namespace,
    "get",
    "secret",
    target.name,
    "-o",
    `jsonpath={.data['nats\\.nk']}`,
  ];
}

/**
 * The kubectl arguments that create one seed. `create --dry-run=client -o yaml | apply` would put
 * the seed on a command line and in the process table, so the value goes through stdin instead
 * and the caller passes it as `stdin`.
 */
export function applySecretArgs(context: string, namespace: string): string[] {
  return [
    "kubectl",
    "--context",
    context,
    "-n",
    namespace,
    "apply",
    "--server-side",
    "--field-manager",
    "localdev-nats-seeds",
    "-f",
    "-",
  ];
}

/** The Secret manifest for one freshly minted seed. Fed to kubectl over stdin, never argv. */
export function secretManifest(target: SeedTarget, seed: string): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: target.name,
      namespace: target.namespace,
      labels: {
        "app.kubernetes.io/part-of": "nats",
        "app.kubernetes.io/component": "nats-principal-credential",
      },
    },
    type: "Opaque",
    stringData: { [SEED_KEY]: seed },
  });
}

/** The file the operator reads the public map out of. Public keys only, 0600, git-ignored. */
export function publicMapContents(results: SeedResult[]): string {
  const entries = results.map((r) => ({
    principal: r.principal,
    publicKey: r.publicKey,
    generated: r.generated,
  }));
  return [
    "# Kind bus principals: PUBLIC keys only. Generated by scripts/localdev-kind.ts.",
    "# The private seeds exist only as Secrets in the Kind cluster and in no file.",
    "#",
    "# Setting these activates authentication: the server then refuses every client without a",
    "# key. Convert the runbook and e2e `nats` call sites to named contexts first (MCAA-487).",
    "#",
    "# NATS_SYSTEM_ACCOUNT_NKEY stays empty on Kind. Nothing here holds the system account, and",
    "# a localdev $SYS key must never be reused in homelab, so break-glass on Kind is recreating",
    "# the cluster rather than keeping a seed around (ADR-043 D4).",
    `NATS_PRINCIPAL_NKEYS="${formatPrincipalNkeys(entries)}"`,
    'NATS_SYSTEM_ACCOUNT_NKEY=""',
    "",
  ].join("\n");
}

export interface SeedIo {
  /** Reads a Secret key; returns the base64 value or "" when absent. */
  read(args: string[]): Promise<{ code: number; stdout: string }>;
  /** Applies a manifest supplied on stdin. */
  apply(args: string[], manifest: string): Promise<void>;
}

/**
 * Reuses every seed already in the cluster and mints only the missing ones. A routine `task
 * localdev:kind` therefore changes no credential: regenerating one silently breaks the client
 * still holding it, which on Kind means a green bootstrap and a bus nothing can reach.
 */
export async function deliverSeeds(
  io: SeedIo,
  context: string,
  namespace: string,
): Promise<SeedResult[]> {
  assertLocaldevContext(context);
  const results: SeedResult[] = [];

  for (const target of seedPlan(namespace)) {
    const existing = await io.read(readSeedArgs(context, target));
    const encoded = existing.code === 0 ? existing.stdout.trim() : "";
    if (encoded) {
      results.push({
        principal: target.principal,
        publicKey: publicKeyFromSeed(
          target.principal,
          Buffer.from(encoded, "base64").toString("utf8"),
        ),
        generated: false,
      });
      continue;
    }
    const seed = new TextDecoder().decode(createUser().getSeed());
    await io.apply(
      applySecretArgs(context, target.namespace),
      secretManifest(target, seed),
    );
    results.push({
      principal: target.principal,
      publicKey: publicKeyFromSeed(target.principal, seed),
      generated: true,
    });
  }

  for (const result of results) {
    assertPublicUserKey(result.principal, result.publicKey);
  }
  assertDistinct(results);
  return results;
}

/** Writes the public map at 0600 and returns its path. Contains no seed. */
export async function writePublicMap(
  repoRoot: string,
  results: SeedResult[],
): Promise<string> {
  const path = join(repoRoot, PUBLIC_MAP_PATH);
  await mkdir(join(repoRoot, ".nats"), { recursive: true, mode: 0o700 });
  await writeFile(path, publicMapContents(results), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
