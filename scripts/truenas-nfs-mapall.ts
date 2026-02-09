#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * truenas-nfs-mapall.ts
 *
 * Updates existing TrueNAS NFS shares from maproot to mapall mapping.
 * Democratic-CSI PV shares use maproot by default, which only maps UID 0.
 * This script switches them to mapall so all client UIDs are mapped,
 * fixing permission errors for containers running as non-root.
 */

const VERSION = "1.0.0";

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
  maproot_user: string;
  maproot_group: string;
  mapall_user: string;
  mapall_group: string;
  enabled: boolean;
}

interface UpdateResult {
  id: number;
  path: string;
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
  --mapall-user <u>   User to map all clients to (default: root)
  --mapall-group <g>  Group to map all clients to (default: root)

${bold("ENVIRONMENT:")}
  TRUENAS_API_KEY     TrueNAS API key (required)
  TRUENAS_API_URL     TrueNAS API base URL (optional)

${bold("EXAMPLES:")}
  # Preview changes for k8s PVC shares only
  deno run --allow-net --allow-env --allow-read scripts/truenas-nfs-mapall.ts --dry-run

  # Update all NFS shares
  deno run --allow-net --allow-env --allow-read scripts/truenas-nfs-mapall.ts --all

  # Use with 1Password injection
  op run --env-file=.env.op -- deno run --allow-net --allow-env --allow-read scripts/truenas-nfs-mapall.ts --all
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
} {
  const opts = {
    help: false,
    dryRun: false,
    all: false,
    apiUrl:
      Deno.env.get("TRUENAS_API_URL") || "https://truenas.ryanmcafee.com",
    verifySsl: false,
    mapallUser: "rmcafee",
    mapallGroup: "users",
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
      default:
        console.error(red(`ERROR: Unknown argument: ${args[i]}`));
        Deno.exit(1);
    }
  }

  return opts;
}

// Democratic-CSI dataset paths (parent shares + PVC shares)
const K8S_PATHS = ["/mnt/storage/k8s", "/mnt/ssd/k8s"];

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
        `INFO: ${alreadyCorrect.length} share(s) already using mapall (skipped)`,
      ),
    );
  }

  if (sharesToUpdate.length === 0) {
    console.log(green("OK: All target shares are already using mapall mapping"));
    Deno.exit(0);
  }

  console.log(
    cyan(
      `INFO: ${sharesToUpdate.length} share(s) need updating from maproot to mapall`,
    ),
  );
  console.log("");

  // Process updates
  const results: UpdateResult[] = [];

  for (const share of sharesToUpdate) {
    const label = `[${share.id}] ${share.path}`;

    const currentMapping = share.maproot_user
      ? `maproot(${share.maproot_user}:${share.maproot_group})`
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

  // Summary
  console.log("");
  console.log(bold("--- Summary ---"));
  const updated = results.filter((r) => r.status === "updated").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errors = results.filter((r) => r.status === "error").length;

  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  if (errors > 0) {
    console.log(red(`  Errors:  ${errors}`));
  }

  if (errors > 0) {
    Deno.exit(1);
  }
}

main();
