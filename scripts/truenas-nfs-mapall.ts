#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * truenas-nfs-mapall.ts
 *
 * Updates existing TrueNAS NFS shares from maproot to mapall mapping.
 * Democratic-CSI PV shares use maproot by default, which only maps UID 0.
 * This script switches them to mapall so all client UIDs are mapped,
 * fixing permission errors for containers running as non-root.
 *
 * Optionally fixes dataset permissions to match the target user/group.
 */

const VERSION = "2.0.0";

// Colors for terminal output
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

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

${bold("USAGE:")}
  deno run --allow-net --allow-env --allow-read scripts/truenas-nfs-mapall.ts [OPTIONS]

${bold("OPTIONS:")}
  --help              Show this help message
  --dry-run           Preview changes without applying them
  --all               Update ALL NFS shares (not just k8s PVC ones)
  --api-url <url>     TrueNAS API URL (default: env TRUENAS_API_URL or https://truenas.ryanmcafee.com)
  --verify-ssl        Enable SSL verification (default: disabled for self-signed certs)
  --mapall-user <u>   User to map all clients to (default: apps)
  --mapall-group <g>  Group to map all clients to (default: users)
  --fix-permissions   Also fix dataset ownership for k8s datasets
  --perm-uid <uid>    UID for dataset permissions (default: 568)
  --perm-gid <gid>    GID for dataset permissions (default: 100)

${bold("ENVIRONMENT:")}
  TRUENAS_API_KEY     TrueNAS API key (required)
  TRUENAS_API_URL     TrueNAS API base URL (optional)

${bold("EXAMPLES:")}
  # Preview changes for k8s PVC shares only
  deno run --allow-net --allow-env --allow-read scripts/truenas-nfs-mapall.ts --dry-run

  # Update all NFS shares
  deno run --allow-net --allow-env --allow-read scripts/truenas-nfs-mapall.ts --all

  # Fix k8s shares and dataset permissions
  deno run --allow-net --allow-env --allow-read scripts/truenas-nfs-mapall.ts --fix-permissions

  # Use with 1Password injection
  op run --env-file=.env.op -- deno run --allow-net --allow-env --allow-read scripts/truenas-nfs-mapall.ts --fix-permissions
`);
}

function parseArgs(args: string[]): {
  help: boolean;
  dryRun: boolean;
  all: boolean;
  apiUrl: string;
  verifySsl: boolean;
  mapallUser: string;
  mapallGroup: string;
  fixPermissions: boolean;
  permUid: number;
  permGid: number;
} {
  const opts = {
    help: false,
    dryRun: false,
    all: false,
    apiUrl:
      Deno.env.get("TRUENAS_API_URL") || "https://truenas.ryanmcafee.com",
    verifySsl: false,
    mapallUser: "apps",
    mapallGroup: "users",
    fixPermissions: false,
    permUid: 568,
    permGid: 100,
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
      case "--fix-permissions":
        opts.fixPermissions = true;
        break;
      case "--perm-uid":
        opts.permUid = parseInt(args[++i], 10);
        break;
      case "--perm-gid":
        opts.permGid = parseInt(args[++i], 10);
        break;
      default:
        console.error(red(`ERROR: Unknown argument: ${args[i]}`));
        Deno.exit(1);
    }
  }

  return opts;
}

// Democratic-CSI dataset paths (parent shares + PVC shares)
const K8S_PATHS = ["/mnt/storage/k8s", "/mnt/ssd/k8s"];
// Dataset names for permission fixing (without /mnt prefix)
const K8S_DATASET_PARENTS = ["storage/k8s", "storage/k8s-snapshots", "ssd/k8s", "ssd/k8s-snapshots"];

function isK8sShare(share: NfsShare): boolean {
  return K8S_PATHS.some(
    (prefix) => share.path === prefix || share.path.startsWith(prefix + "/"),
  );
}

function needsUpdate(share: NfsShare, targetUser: string, targetGroup: string): boolean {
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

  return await resp.json();
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
    throw new Error(`Failed to update share ${shareId}: ${resp.status} ${body}`);
  }
}

async function listChildDatasets(
  apiUrl: string,
  apiKey: string,
  parentDataset: string,
): Promise<string[]> {
  const resp = await fetch(
    `${apiUrl}/api/v2.0/pool/dataset?id=${encodeURIComponent(parentDataset)}&recursive=true`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (!resp.ok) {
    if (resp.status === 404) {
      return [];
    }
    throw new Error(
      `Failed to list datasets under ${parentDataset}: ${resp.status} ${resp.statusText}`,
    );
  }

  const datasets: Dataset[] = await resp.json();
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
  for (const ds of datasets) {
    collect(ds);
  }
  return result;
}

async function setDatasetPermissions(
  apiUrl: string,
  apiKey: string,
  datasetPath: string,
  uid: number,
  gid: number,
): Promise<number> {
  const resp = await fetch(`${apiUrl}/api/v2.0/filesystem/setperm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path: `/mnt/${datasetPath}`,
      uid: uid,
      gid: gid,
      mode: "770",
      options: {
        recursive: true,
        traverse: false,
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to set permissions on ${datasetPath}: ${resp.status} ${body}`);
  }

  // Returns a job ID
  const jobId: number = await resp.json();
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

    const jobs = await resp.json();
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
  const opts = parseArgs(Deno.args);

  if (opts.help) {
    printHelp();
    Deno.exit(0);
  }

  const apiKey = Deno.env.get("TRUENAS_API_KEY");
  if (!apiKey) {
    console.error(red("ERROR: TRUENAS_API_KEY environment variable is required"));
    console.error("Set it directly or use: op run --env-file=.env.op -- ...");
    Deno.exit(1);
  }

  console.log(cyan(`INFO: Connecting to TrueNAS at ${opts.apiUrl}`));
  if (opts.dryRun) {
    console.log(yellow("DRY RUN: No changes will be made"));
  }

  // Fetch all NFS shares
  let shares: NfsShare[];
  try {
    shares = await fetchShares(opts.apiUrl, apiKey);
  } catch (err) {
    console.error(red(`ERROR: ${(err as Error).message}`));
    Deno.exit(1);
  }

  console.log(cyan(`INFO: Found ${shares.length} total NFS shares`));

  // Filter shares based on --all flag
  const targetShares = opts.all
    ? shares
    : shares.filter((s) => isK8sShare(s));

  if (!opts.all) {
    console.log(
      cyan(
        `INFO: Filtering to k8s shares (${targetShares.length} matches)`,
      ),
    );
    console.log(
      cyan("INFO: Use --all to update all NFS shares"),
    );
  }

  // Find shares that need updating
  const sharesToUpdate = targetShares.filter((s) =>
    needsUpdate(s, opts.mapallUser, opts.mapallGroup),
  );
  const alreadyCorrect = targetShares.filter(
    (s) => !needsUpdate(s, opts.mapallUser, opts.mapallGroup),
  );

  if (alreadyCorrect.length > 0) {
    console.log(
      cyan(
        `INFO: ${alreadyCorrect.length} share(s) already using mapall=${opts.mapallUser}:${opts.mapallGroup} (skipped)`,
      ),
    );
  }

  if (sharesToUpdate.length === 0) {
    console.log(green("OK: All target shares are already correctly configured"));
  } else {
    console.log(
      cyan(
        `INFO: ${sharesToUpdate.length} share(s) need updating to mapall=${opts.mapallUser}:${opts.mapallGroup}`,
      ),
    );
    console.log("");

    // Process NFS share updates
    const results: UpdateResult[] = [];

    for (const share of sharesToUpdate) {
      const label = `[${share.id}] ${share.path}`;

      const currentMapping = share.maproot_user
        ? `maproot(${share.maproot_user}:${share.maproot_group ?? "null"})`
        : `mapall(${share.mapall_user ?? "null"}:${share.mapall_group ?? "null"})`;

      if (opts.dryRun) {
        console.log(
          yellow(
            `DRY RUN: Would update ${label}: ${currentMapping} → mapall(${opts.mapallUser}:${opts.mapallGroup})`,
          ),
        );
        results.push({ id: share.id, path: share.path, status: "skipped", reason: "dry-run" });
        continue;
      }

      try {
        await updateShare(
          opts.apiUrl,
          apiKey,
          share.id,
          opts.mapallUser,
          opts.mapallGroup,
        );
        console.log(
          green(
            `OK: Updated ${label}: ${currentMapping} → mapall(${opts.mapallUser}:${opts.mapallGroup})`,
          ),
        );
        results.push({ id: share.id, path: share.path, status: "updated" });
      } catch (err) {
        console.error(red(`ERROR: Failed to update ${label}: ${(err as Error).message}`));
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
    console.log(cyan(`INFO: Target ownership: uid=${opts.permUid} gid=${opts.permGid}`));

    const permResults: PermResult[] = [];

    for (const parentDs of K8S_DATASET_PARENTS) {
      console.log(cyan(`INFO: Scanning datasets under ${parentDs}...`));

      let datasets: string[];
      try {
        datasets = await listChildDatasets(opts.apiUrl, apiKey, parentDs);
      } catch (err) {
        console.error(red(`ERROR: ${(err as Error).message}`));
        permResults.push({ dataset: parentDs, status: "error", reason: (err as Error).message });
        continue;
      }

      if (datasets.length === 0) {
        console.log(yellow(`WARN: No datasets found under ${parentDs} (may not exist yet)`));
        permResults.push({ dataset: parentDs, status: "skipped", reason: "not found" });
        continue;
      }

      console.log(cyan(`INFO: Found ${datasets.length} dataset(s) under ${parentDs}`));

      for (const ds of datasets) {
        if (opts.dryRun) {
          console.log(yellow(`DRY RUN: Would set ${ds} → uid=${opts.permUid} gid=${opts.permGid} mode=770 (recursive)`));
          permResults.push({ dataset: ds, status: "skipped", reason: "dry-run" });
          continue;
        }

        try {
          const jobId = await setDatasetPermissions(
            opts.apiUrl,
            apiKey,
            ds,
            opts.permUid,
            opts.permGid,
          );
          console.log(cyan(`INFO: Permission job ${jobId} started for ${ds}...`));
          await waitForJob(opts.apiUrl, apiKey, jobId);
          console.log(green(`OK: Permissions set on ${ds} → uid=${opts.permUid} gid=${opts.permGid}`));
          permResults.push({ dataset: ds, status: "updated" });
        } catch (err) {
          console.error(red(`ERROR: Failed to set permissions on ${ds}: ${(err as Error).message}`));
          permResults.push({ dataset: ds, status: "error", reason: (err as Error).message });
        }
      }
    }

    // Permission Summary
    console.log("");
    console.log(bold("--- Permission Summary ---"));
    const permUpdated = permResults.filter((r) => r.status === "updated").length;
    const permSkipped = permResults.filter((r) => r.status === "skipped").length;
    const permErrors = permResults.filter((r) => r.status === "error").length;

    console.log(`  Updated: ${permUpdated}`);
    console.log(`  Skipped: ${permSkipped}`);
    if (permErrors > 0) {
      console.log(red(`  Errors:  ${permErrors}`));
      Deno.exit(1);
    }
  }
}

main();
