#!/usr/bin/env bun

/**
 * truenas-nfs-mapall.ts
 *
 * Updates existing TrueNAS NFS shares from maproot to mapall mapping.
 * Democratic-CSI PV shares use maproot by default, which only maps UID 0.
 * This script switches them to mapall so all client UIDs are mapped,
 * fixing permission errors for containers running as non-root.
 *
 * Supports split permission models:
 * - K8s datasets: apps:users (568:100)
 * - Media/personal datasets: <NFS_MAPALL_USER>:users
 *
 * Optionally fixes dataset ownership to match the target user/group.
 *
 * No real hostname or account name is hardcoded here: --api-url defaults to
 * https://<TRUENAS_HOSTNAME> and the media user to NFS_MAPALL_USER, both read
 * at runtime from the gitignored configuration/environments/homelab.yaml (see
 * scripts/tailscale-dns.ts and scripts/prod-readonly.ts for the pattern).
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "./lib/yaml.ts";

const VERSION = "3.0.0";

// Colors for terminal output
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

// ============================================================================
// Defaults from the environment values (no hardcoded PII)
// ============================================================================

/** Gitignored environment values; absent on a fresh clone. */
export const HOMELAB_ENV_FILE = "configuration/environments/homelab.yaml";

const DNS_NAME =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const USER_NAME = /^[a-z_][a-z0-9_-]*\$?$/;

/** Raised for invalid invocations; main prints it and exits 1. */
export class UsageError extends Error {}

/**
 * A trimmed, lower-cased string value from the environment YAML, or null when
 * the file does not parse, the key is missing, empty or a REPLACEME
 * placeholder. Callers check the shape they need.
 */
export function envFileValue(text: string, key: string): string | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = (parsed as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v || v.includes("replaceme")) return null;
  return v;
}

/** One key of the environment file, or null when the file is unreadable. */
async function envValue(key: string): Promise<string | null> {
  try {
    return envFileValue(await readFile(HOMELAB_ENV_FILE, "utf8"), key);
  } catch {
    return null;
  }
}

/**
 * --api-url, else $TRUENAS_API_URL, else https://<TRUENAS_HOSTNAME>.
 *
 * TRUENAS_HOSTNAME is a derived key (const "truenas.{{.DOMAIN}}" in
 * configuration/schema/network.schema.yaml), so the environment file usually
 * carries only DOMAIN: the key is used when present and derived otherwise,
 * the same way prod-readonly.ts derives argocd.<DOMAIN>.
 */
async function resolveApiUrl(flag: string | undefined): Promise<string> {
  if (flag) return flag;
  const env = process.env.TRUENAS_API_URL?.trim();
  if (env) return env;
  const host = await envValue("TRUENAS_HOSTNAME");
  if (host && DNS_NAME.test(host)) return `https://${host}`;
  const domain = await envValue("DOMAIN");
  if (domain && DNS_NAME.test(domain)) return `https://truenas.${domain}`;
  throw new UsageError(
    "cannot determine the TrueNAS API URL: pass --api-url https://truenas.example.com, " +
      `set TRUENAS_API_URL, or fill TRUENAS_HOSTNAME (or DOMAIN) in ${HOMELAB_ENV_FILE}`,
  );
}

/** <flag>, else NFS_MAPALL_USER. Only resolved when --all touches media. */
async function resolveMediaUser(
  flag: string | undefined,
  flagName: string,
): Promise<string> {
  if (flag) return flag;
  const user = await envValue("NFS_MAPALL_USER");
  if (user && USER_NAME.test(user)) return user;
  throw new UsageError(
    `cannot determine the media NFS user: pass ${flagName} <user> ` +
      `or fill NFS_MAPALL_USER in ${HOMELAB_ENV_FILE}`,
  );
}

interface NfsShare {
  id: number;
  path: string;
  comment: string;
  networks: string[];
  maproot_user: string | null;
  maproot_group: string | null;
  mapall_user: string | null;
  mapall_group: string | null;
  enabled: boolean;
}

interface Dataset {
  id: string;
  name: string;
  pool: string;
  type: string;
  mountpoint: string;
  children: Dataset[];
}

interface UpdateResult {
  id: number;
  path: string;
  status: "updated" | "skipped" | "error";
  reason?: string;
}

interface PermResult {
  dataset: string;
  status: "updated" | "skipped" | "error";
  reason?: string;
}

function printHelp(): void {
  console.log(`
${bold("truenas-nfs-mapall")} v${VERSION}

Update TrueNAS NFS shares from maproot to mapall mapping.
Fixes permission errors for containers running as non-root UIDs.

Supports split permission models: k8s shares use apps:users (568:100),
media/personal shares use <NFS_MAPALL_USER>:users. See --media-* flags.

${bold("USAGE:")}
  bun scripts/truenas-nfs-mapall.ts [OPTIONS]

${bold("OPTIONS:")}
  --help                    Show this help message
  --dry-run                 Preview changes without applying them
  --all                     Update ALL NFS shares (not just k8s PVC ones); also includes media datasets for --fix-permissions
  --api-url <url>           TrueNAS API URL (default: env TRUENAS_API_URL, else
                            https://<TRUENAS_HOSTNAME> (truenas.<DOMAIN>)
                            from ${HOMELAB_ENV_FILE})
  --verify-ssl              Enable SSL verification (default: disabled for self-signed certs)

  ${bold("K8s share options:")}
  --mapall-user <u>         User to map k8s NFS clients to (default: apps)
  --mapall-group <g>        Group to map k8s NFS clients to (default: users)

  ${bold("Media share options (used with --all):")}
  --media-mapall-user <u>   User to map media NFS clients to
                            (default: NFS_MAPALL_USER from ${HOMELAB_ENV_FILE})
  --media-mapall-group <g>  Group to map media NFS clients to (default: users)

  ${bold("Permission options:")}
  --fix-permissions         Also fix dataset ownership (k8s only; combine with --all for media datasets too)
  --perm-uid <uid>          UID for k8s dataset permissions (default: 568)
  --perm-gid <gid>          GID for all dataset permissions (default: 100)
  --media-perm-user <u>     Username for media dataset permissions
                            (default: NFS_MAPALL_USER from ${HOMELAB_ENV_FILE})

${bold("ENVIRONMENT:")}
  TRUENAS_API_KEY     TrueNAS API key (required)
  TRUENAS_API_URL     TrueNAS API base URL (optional; else https://<TRUENAS_HOSTNAME>
                      from ${HOMELAB_ENV_FILE})

${bold("EXAMPLES:")}
  # Preview changes for k8s PVC shares only
  bun scripts/truenas-nfs-mapall.ts --dry-run

  # Update all NFS shares (k8s → apps:users, media → <NFS_MAPALL_USER>:users)
  bun scripts/truenas-nfs-mapall.ts --all

  # Fix k8s shares and dataset permissions
  bun scripts/truenas-nfs-mapall.ts --fix-permissions

  # Fix ALL shares + ALL dataset permissions (split k8s/media model)
  bun scripts/truenas-nfs-mapall.ts --all --fix-permissions

  # Use with 1Password injection
  op run --env-file=.env.op -- bun scripts/truenas-nfs-mapall.ts --all --fix-permissions
`);
}

/** Flags only; the PII-shaped defaults are resolved later (resolveOptions). */
function parseArgs(args: string[]): {
  help: boolean;
  dryRun: boolean;
  all: boolean;
  apiUrl: string | undefined;
  verifySsl: boolean;
  mapallUser: string;
  mapallGroup: string;
  mediaMapallUser: string | undefined;
  mediaMapallGroup: string;
  fixPermissions: boolean;
  permUid: number;
  permGid: number;
  mediaPermUser: string | undefined;
} {
  const opts = {
    help: false,
    dryRun: false,
    all: false,
    apiUrl: undefined as string | undefined,
    verifySsl: false,
    mapallUser: "apps",
    mapallGroup: "users",
    mediaMapallUser: undefined as string | undefined,
    mediaMapallGroup: "users",
    fixPermissions: false,
    permUid: 568,
    permGid: 100,
    mediaPermUser: undefined as string | undefined,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--all":
        opts.all = true;
        break;
      case "--api-url":
        opts.apiUrl = args[++i];
        break;
      case "--verify-ssl":
        opts.verifySsl = true;
        break;
      case "--mapall-user":
        opts.mapallUser = args[++i];
        break;
      case "--mapall-group":
        opts.mapallGroup = args[++i];
        break;
      case "--media-mapall-user":
        opts.mediaMapallUser = args[++i];
        break;
      case "--media-mapall-group":
        opts.mediaMapallGroup = args[++i];
        break;
      case "--fix-permissions":
        opts.fixPermissions = true;
        break;
      case "--perm-uid":
        opts.permUid = parseInt(args[++i], 10);
        break;
      case "--perm-gid":
        opts.permGid = parseInt(args[++i], 10);
        break;
      case "--media-perm-user":
        opts.mediaPermUser = args[++i];
        break;
      default:
        console.error(red(`ERROR: Unknown argument: ${args[i]}`));
        process.exit(1);
    }
  }

  return opts;
}

// Democratic-CSI dataset paths (parent shares + PVC shares)
const K8S_PATHS = ["/mnt/storage/k8s", "/mnt/ssd/k8s"];
// Dataset names for permission fixing (without /mnt prefix)
const K8S_DATASET_PARENTS = [
  "storage/k8s",
  "storage/k8s-snapshots",
  "ssd/k8s",
  "ssd/k8s-snapshots",
];
// Media and additional dataset parents for permission fixing
const MEDIA_DATASET_PARENTS = [
  "storage/backups",
  "storage/movies",
  "storage/tv",
  "storage/music",
  "storage/pictures",
  "storage/documents",
  "storage/books",
  "storage/downloads",
];
// Media NFS share paths (for classifying shares)
const MEDIA_PATHS = [
  "/mnt/storage/backups",
  "/mnt/storage/movies",
  "/mnt/storage/tv",
  "/mnt/storage/music",
  "/mnt/storage/pictures",
  "/mnt/storage/documents",
  "/mnt/storage/books",
  "/mnt/storage/downloads",
];

function isK8sShare(share: NfsShare): boolean {
  return K8S_PATHS.some(
    (prefix) => share.path === prefix || share.path.startsWith(prefix + "/"),
  );
}

function isMediaShare(share: NfsShare): boolean {
  return MEDIA_PATHS.some(
    (prefix) => share.path === prefix || share.path.startsWith(prefix + "/"),
  );
}

function needsUpdate(
  share: NfsShare,
  targetUser: string,
  targetGroup: string,
): boolean {
  const hasMaproot = !!(share.maproot_user || share.maproot_group);
  const hasCorrectMapall =
    share.mapall_user === targetUser && share.mapall_group === targetGroup;
  // Needs update if maproot is set, or mapall doesn't match the target
  return hasMaproot || !hasCorrectMapall;
}

async function fetchShares(
  apiUrl: string,
  apiKey: string,
): Promise<NfsShare[]> {
  const resp = await fetch(`${apiUrl}/api/v2.0/sharing/nfs`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to fetch NFS shares: ${resp.status} ${resp.statusText}`,
    );
  }

  return (await resp.json()) as NfsShare[];
}

async function updateShare(
  apiUrl: string,
  apiKey: string,
  shareId: number,
  mapallUser: string,
  mapallGroup: string,
): Promise<void> {
  const resp = await fetch(`${apiUrl}/api/v2.0/sharing/nfs/id/${shareId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mapall_user: mapallUser,
      mapall_group: mapallGroup,
      maproot_user: "",
      maproot_group: "",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Failed to update share ${shareId}: ${resp.status} ${body}`,
    );
  }
}

async function listChildDatasets(
  apiUrl: string,
  apiKey: string,
  parentDataset: string,
): Promise<string[]> {
  // Use /id/ endpoint which returns the dataset with nested children
  const encodedId = encodeURIComponent(parentDataset);
  const resp = await fetch(`${apiUrl}/api/v2.0/pool/dataset/id/${encodedId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    if (resp.status === 404) {
      return [];
    }
    throw new Error(
      `Failed to list datasets under ${parentDataset}: ${resp.status} ${resp.statusText}`,
    );
  }

  const parent: Dataset = (await resp.json()) as Dataset;
  // Flatten all dataset IDs including the parent
  const result: string[] = [];
  function collect(ds: Dataset) {
    result.push(ds.id);
    if (ds.children) {
      for (const child of ds.children) {
        collect(child);
      }
    }
  }
  collect(parent);
  return result;
}

async function setDatasetPermissions(
  apiUrl: string,
  apiKey: string,
  datasetPath: string,
  options: { uid?: number; user?: string; gid: number },
): Promise<number> {
  // Build the permission body — use uid if provided, otherwise use user (string name)
  const body: Record<string, unknown> = {
    path: `/mnt/${datasetPath}`,
    gid: options.gid,
    mode: "770",
    options: {
      recursive: true,
      traverse: true,
    },
  };

  if (options.uid !== undefined) {
    body.uid = options.uid;
  } else if (options.user !== undefined) {
    body.user = options.user;
  }

  const resp = await fetch(`${apiUrl}/api/v2.0/filesystem/setperm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const respBody = await resp.text();
    throw new Error(
      `Failed to set permissions on ${datasetPath}: ${resp.status} ${respBody}`,
    );
  }

  // Returns a job ID
  const jobId: number = (await resp.json()) as number;
  return jobId;
}

async function waitForJob(
  apiUrl: string,
  apiKey: string,
  jobId: number,
  timeoutMs: number = 120000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await fetch(`${apiUrl}/api/v2.0/core/get_jobs?id=${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      throw new Error(`Failed to check job ${jobId}: ${resp.status}`);
    }

    const jobs = (await resp.json()) as { state: string; error?: string }[];
    if (jobs.length > 0) {
      const job = jobs[0];
      if (job.state === "SUCCESS") {
        return;
      }
      if (job.state === "FAILED") {
        throw new Error(`Job ${jobId} failed: ${job.error || "unknown error"}`);
      }
      // Still running, wait
    }

    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Job ${jobId} timed out after ${timeoutMs / 1000}s`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const apiKey = process.env.TRUENAS_API_KEY;
  if (!apiKey) {
    console.error(
      red("ERROR: TRUENAS_API_KEY environment variable is required"),
    );
    console.error("Set it directly or use: op run --env-file=.env.op -- ...");
    process.exit(1);
  }

  // The media user identifies a real account, so it is only resolved when
  // --all actually touches media shares or media datasets.
  const opts = {
    ...parsed,
    apiUrl: await resolveApiUrl(parsed.apiUrl),
    mediaMapallUser: parsed.all
      ? await resolveMediaUser(parsed.mediaMapallUser, "--media-mapall-user")
      : parsed.mediaMapallUser,
    mediaPermUser:
      parsed.all && parsed.fixPermissions
        ? await resolveMediaUser(parsed.mediaPermUser, "--media-perm-user")
        : parsed.mediaPermUser,
  };

  console.log(cyan(`INFO: Connecting to TrueNAS at ${opts.apiUrl}`));
  if (opts.dryRun) {
    console.log(yellow("DRY RUN: No changes will be made"));
  }

  if (opts.all) {
    console.log(
      cyan(`INFO: K8s NFS mapall: ${opts.mapallUser}:${opts.mapallGroup}`),
    );
    console.log(
      cyan(
        `INFO: Media NFS mapall: ${opts.mediaMapallUser}:${opts.mediaMapallGroup}`,
      ),
    );
  }

  // Fetch all NFS shares
  let shares: NfsShare[];
  try {
    shares = await fetchShares(opts.apiUrl, apiKey);
  } catch (err) {
    console.error(red(`ERROR: ${(err as Error).message}`));
    process.exit(1);
  }

  console.log(cyan(`INFO: Found ${shares.length} total NFS shares`));

  // Filter shares based on --all flag
  const targetShares = opts.all ? shares : shares.filter((s) => isK8sShare(s));

  if (!opts.all) {
    console.log(
      cyan(`INFO: Filtering to k8s shares (${targetShares.length} matches)`),
    );
    console.log(cyan("INFO: Use --all to update all NFS shares"));
  }

  // Find shares that need updating — when --all, apply different targets per share type
  const sharesToUpdate: {
    share: NfsShare;
    targetUser: string;
    targetGroup: string;
  }[] = [];
  const alreadyCorrect: NfsShare[] = [];

  for (const share of targetShares) {
    let targetUser: string;
    let targetGroup: string;

    if (opts.all && isMediaShare(share)) {
      // Resolved above whenever --all is set.
      targetUser = opts.mediaMapallUser!;
      targetGroup = opts.mediaMapallGroup;
    } else {
      targetUser = opts.mapallUser;
      targetGroup = opts.mapallGroup;
    }

    if (needsUpdate(share, targetUser, targetGroup)) {
      sharesToUpdate.push({ share, targetUser, targetGroup });
    } else {
      alreadyCorrect.push(share);
    }
  }

  if (alreadyCorrect.length > 0) {
    console.log(
      cyan(
        `INFO: ${alreadyCorrect.length} share(s) already correctly configured (skipped)`,
      ),
    );
  }

  if (sharesToUpdate.length === 0) {
    console.log(
      green("OK: All target shares are already correctly configured"),
    );
  } else {
    console.log(cyan(`INFO: ${sharesToUpdate.length} share(s) need updating`));
    console.log("");

    // Process NFS share updates
    const results: UpdateResult[] = [];

    for (const { share, targetUser, targetGroup } of sharesToUpdate) {
      const label = `[${share.id}] ${share.path}`;

      const currentMapping = share.maproot_user
        ? `maproot(${share.maproot_user}:${share.maproot_group ?? "null"})`
        : `mapall(${share.mapall_user ?? "null"}:${
            share.mapall_group ?? "null"
          })`;

      if (opts.dryRun) {
        console.log(
          yellow(
            `DRY RUN: Would update ${label}: ${currentMapping} → mapall(${targetUser}:${targetGroup})`,
          ),
        );
        results.push({
          id: share.id,
          path: share.path,
          status: "skipped",
          reason: "dry-run",
        });
        continue;
      }

      try {
        await updateShare(
          opts.apiUrl,
          apiKey,
          share.id,
          targetUser,
          targetGroup,
        );
        console.log(
          green(
            `OK: Updated ${label}: ${currentMapping} → mapall(${targetUser}:${targetGroup})`,
          ),
        );
        results.push({ id: share.id, path: share.path, status: "updated" });
      } catch (err) {
        console.error(
          red(`ERROR: Failed to update ${label}: ${(err as Error).message}`),
        );
        results.push({
          id: share.id,
          path: share.path,
          status: "error",
          reason: (err as Error).message,
        });
      }
    }

    // NFS Summary
    console.log("");
    console.log(bold("--- NFS Share Summary ---"));
    const updated = results.filter((r) => r.status === "updated").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const errors = results.filter((r) => r.status === "error").length;

    console.log(`  Updated: ${updated}`);
    console.log(`  Skipped: ${skipped}`);
    if (errors > 0) {
      console.log(red(`  Errors:  ${errors}`));
    }
  }

  // Fix dataset permissions if requested
  if (opts.fixPermissions) {
    console.log("");
    console.log(bold("--- Dataset Permission Fixes ---"));

    // Fix both k8s and media datasets when --all is used, otherwise only k8s
    const k8sDatasets = K8S_DATASET_PARENTS;
    const mediaDatasets = opts.all ? MEDIA_DATASET_PARENTS : [];

    if (opts.all) {
      console.log(
        cyan(
          `INFO: K8s datasets (${k8sDatasets.length}): uid=${opts.permUid} gid=${opts.permGid}`,
        ),
      );
      console.log(
        cyan(
          `INFO: Media datasets (${mediaDatasets.length}): user=${opts.mediaPermUser} gid=${opts.permGid}`,
        ),
      );
    } else {
      console.log(
        cyan(
          `INFO: K8s datasets only (${k8sDatasets.length}): uid=${opts.permUid} gid=${opts.permGid}`,
        ),
      );
      console.log(cyan(`INFO: Use --all to include media datasets`));
    }

    const permResults: PermResult[] = [];

    // Fix k8s datasets with UID
    for (const parentDs of k8sDatasets) {
      let childCount = 0;
      try {
        const datasets = await listChildDatasets(opts.apiUrl, apiKey, parentDs);
        childCount = datasets.length - 1;
      } catch {
        console.log(yellow(`WARN: Dataset ${parentDs} not found, skipping`));
        permResults.push({
          dataset: parentDs,
          status: "skipped",
          reason: "not found",
        });
        continue;
      }

      if (opts.dryRun) {
        console.log(
          yellow(
            `DRY RUN: Would set ${parentDs} (${childCount} children) → uid=${opts.permUid} gid=${opts.permGid} mode=770 (recursive)`,
          ),
        );
        permResults.push({
          dataset: parentDs,
          status: "skipped",
          reason: "dry-run",
        });
        continue;
      }

      try {
        const jobId = await setDatasetPermissions(
          opts.apiUrl,
          apiKey,
          parentDs,
          { uid: opts.permUid, gid: opts.permGid },
        );
        console.log(
          cyan(
            `INFO: Permission job ${jobId} started for ${parentDs} (${childCount} children, recursive)...`,
          ),
        );
        await waitForJob(opts.apiUrl, apiKey, jobId, 300000);
        console.log(
          green(
            `OK: Permissions set on ${parentDs} → uid=${opts.permUid} gid=${opts.permGid}`,
          ),
        );
        permResults.push({ dataset: parentDs, status: "updated" });
      } catch (err) {
        console.error(
          red(
            `ERROR: Failed to set permissions on ${parentDs}: ${
              (err as Error).message
            }`,
          ),
        );
        permResults.push({
          dataset: parentDs,
          status: "error",
          reason: (err as Error).message,
        });
      }
    }

    // Fix media datasets with username (not UID)
    for (const parentDs of mediaDatasets) {
      let childCount = 0;
      try {
        const datasets = await listChildDatasets(opts.apiUrl, apiKey, parentDs);
        childCount = datasets.length - 1;
      } catch {
        console.log(yellow(`WARN: Dataset ${parentDs} not found, skipping`));
        permResults.push({
          dataset: parentDs,
          status: "skipped",
          reason: "not found",
        });
        continue;
      }

      if (opts.dryRun) {
        console.log(
          yellow(
            `DRY RUN: Would set ${parentDs} (${childCount} children) → user=${opts.mediaPermUser} gid=${opts.permGid} mode=770 (recursive)`,
          ),
        );
        permResults.push({
          dataset: parentDs,
          status: "skipped",
          reason: "dry-run",
        });
        continue;
      }

      try {
        const jobId = await setDatasetPermissions(
          opts.apiUrl,
          apiKey,
          parentDs,
          // Resolved above whenever --all and --fix-permissions are set.
          { user: opts.mediaPermUser!, gid: opts.permGid },
        );
        console.log(
          cyan(
            `INFO: Permission job ${jobId} started for ${parentDs} (${childCount} children, recursive)...`,
          ),
        );
        await waitForJob(opts.apiUrl, apiKey, jobId, 300000);
        console.log(
          green(
            `OK: Permissions set on ${parentDs} → user=${opts.mediaPermUser} gid=${opts.permGid}`,
          ),
        );
        permResults.push({ dataset: parentDs, status: "updated" });
      } catch (err) {
        console.error(
          red(
            `ERROR: Failed to set permissions on ${parentDs}: ${
              (err as Error).message
            }`,
          ),
        );
        permResults.push({
          dataset: parentDs,
          status: "error",
          reason: (err as Error).message,
        });
      }
    }

    // Permission Summary
    console.log("");
    console.log(bold("--- Permission Summary ---"));
    const permUpdated = permResults.filter(
      (r) => r.status === "updated",
    ).length;
    const permSkipped = permResults.filter(
      (r) => r.status === "skipped",
    ).length;
    const permErrors = permResults.filter((r) => r.status === "error").length;

    console.log(`  Updated: ${permUpdated}`);
    console.log(`  Skipped: ${permSkipped}`);
    if (permErrors > 0) {
      console.log(red(`  Errors:  ${permErrors}`));
      process.exit(1);
    }
  }
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(red(`ERROR: ${err.message}`));
    process.exit(1);
  }
  throw err;
});
