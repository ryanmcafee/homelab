#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-run

/**
 * truenas-pvc-cleanup.ts
 *
 * Cross-references Kubernetes PersistentVolumes with TrueNAS datasets
 * under storage/k8s and ssd/k8s to find orphaned datasets (exist on
 * TrueNAS but have no matching K8s PV) and deletes them.
 *
 * Safe by default: runs in dry-run mode unless --delete is passed.
 */

const VERSION = "1.0.0";

// Colors for terminal output
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// PVC UUID pattern: pvc-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
const PVC_PATTERN = /^pvc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Democratic-CSI driver names
const CSI_DRIVERS: Record<string, string> = {
  "org.democratic-csi.nfs": "storage/k8s",
  "org.democratic-csi.nfs-ssd": "ssd/k8s",
};

// Dataset parents to scan
const DATASET_PARENTS = ["storage/k8s", "ssd/k8s"];
const SNAPSHOT_PARENTS = ["storage/k8s-snapshots", "ssd/k8s-snapshots"];

interface NfsShare {
  id: number;
  path: string;
  comment: string;
  enabled: boolean;
}

interface Dataset {
  id: string;
  name: string;
  pool: string;
  type: string;
  mountpoint: string;
  used: { rawvalue: string };
  available: { rawvalue: string };
  children: Dataset[];
}

interface PvInfo {
  name: string;
  phase: string;
  volumeHandle: string;
  driver: string;
  claimRef?: {
    name: string;
    namespace: string;
  };
}

type DatasetStatus = "IN USE" | "RELEASED" | "ORPHANED" | "NON-PVC";

interface DatasetAnalysis {
  datasetId: string;
  shortName: string;
  parent: string;
  usedBytes: number;
  status: DatasetStatus;
  pvName?: string;
  pvPhase?: string;
  pvcName?: string;
  pvcNamespace?: string;
}

function printHelp(): void {
  console.log(`
${bold("truenas-pvc-cleanup")} v${VERSION}

Find and clean up orphaned TrueNAS datasets not in use by Kubernetes PVs.
Cross-references democratic-csi PVs with TrueNAS datasets under storage/k8s and ssd/k8s.

${bold("USAGE:")}
  deno run --allow-net --allow-env --allow-read --allow-run scripts/truenas-pvc-cleanup.ts [OPTIONS]

${bold("OPTIONS:")}
  --help              Show this help message
  --dry-run           Preview only, no changes (this is the default)
  --delete            Actually delete orphaned datasets and their NFS shares
  --include-released  Also target PVs in "Released" state for cleanup
  --yes               Skip interactive confirmation (for automation)
  --api-url <url>     TrueNAS API URL (default: env TRUENAS_API_URL or https://truenas.ryanmcafee.com)
  --verify-ssl        Enable SSL verification (default: disabled for self-signed certs)
  --verbose           Extra debug output

${bold("ENVIRONMENT:")}
  TRUENAS_API_KEY     TrueNAS API key (required)
  TRUENAS_API_URL     TrueNAS API base URL (optional)

${bold("EXAMPLES:")}
  # Preview orphaned datasets (safe, no changes)
  deno run --allow-net --allow-env --allow-read --allow-run scripts/truenas-pvc-cleanup.ts

  # Actually delete orphaned datasets
  deno run --allow-net --allow-env --allow-read --allow-run scripts/truenas-pvc-cleanup.ts --delete

  # Include Released PVs in cleanup
  deno run --allow-net --allow-env --allow-read --allow-run scripts/truenas-pvc-cleanup.ts --delete --include-released

  # Use with 1Password injection
  op run --env-file=.env.op -- deno run --allow-net --allow-env --allow-read --allow-run scripts/truenas-pvc-cleanup.ts
`);
}

function parseArgs(args: string[]): {
  help: boolean;
  dryRun: boolean;
  delete: boolean;
  includeReleased: boolean;
  yes: boolean;
  apiUrl: string;
  verifySsl: boolean;
  verbose: boolean;
} {
  const opts = {
    help: false,
    dryRun: false,
    delete: false,
    includeReleased: false,
    yes: false,
    apiUrl:
      Deno.env.get("TRUENAS_API_URL") || "https://truenas.ryanmcafee.com",
    verifySsl: false,
    verbose: false,
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
      case "--delete":
        opts.delete = true;
        break;
      case "--include-released":
        opts.includeReleased = true;
        break;
      case "--yes":
      case "-y":
        opts.yes = true;
        break;
      case "--api-url":
        opts.apiUrl = args[++i];
        break;
      case "--verify-ssl":
        opts.verifySsl = true;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      default:
        console.error(red(`ERROR: Unknown argument: ${args[i]}`));
        Deno.exit(1);
    }
  }

  // --dry-run is the default; --delete overrides it
  if (!opts.delete) {
    opts.dryRun = true;
  }

  return opts;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// --- kubectl ---

async function runKubectl(args: string[]): Promise<string> {
  const cmd = new Deno.Command("kubectl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const output = await cmd.output();

  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`kubectl ${args.join(" ")} failed: ${stderr}`);
  }

  return new TextDecoder().decode(output.stdout);
}

async function fetchK8sPersistentVolumes(): Promise<Map<string, PvInfo>> {
  const raw = await runKubectl(["get", "pv", "-o", "json"]);
  const data = JSON.parse(raw);
  const pvMap = new Map<string, PvInfo>();

  for (const item of data.items) {
    const driver = item.spec?.csi?.driver;
    if (!driver || !CSI_DRIVERS[driver]) continue;

    const volumeHandle = item.spec.csi.volumeHandle;
    if (!volumeHandle) continue;

    const info: PvInfo = {
      name: item.metadata.name,
      phase: item.status?.phase || "Unknown",
      volumeHandle,
      driver,
    };

    if (item.spec.claimRef) {
      info.claimRef = {
        name: item.spec.claimRef.name,
        namespace: item.spec.claimRef.namespace,
      };
    }

    pvMap.set(volumeHandle, info);
  }

  return pvMap;
}

// --- TrueNAS API ---

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

async function fetchDatasetWithChildren(
  apiUrl: string,
  apiKey: string,
  parentDataset: string,
): Promise<Dataset | null> {
  const encodedId = encodeURIComponent(parentDataset);
  const resp = await fetch(
    `${apiUrl}/api/v2.0/pool/dataset/id/${encodedId}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (!resp.ok) {
    if (resp.status === 404) {
      return null;
    }
    throw new Error(
      `Failed to fetch dataset ${parentDataset}: ${resp.status} ${resp.statusText}`,
    );
  }

  return await resp.json();
}

async function deleteDataset(
  apiUrl: string,
  apiKey: string,
  datasetId: string,
): Promise<void> {
  const encodedId = encodeURIComponent(datasetId);
  const resp = await fetch(
    `${apiUrl}/api/v2.0/pool/dataset/id/${encodedId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recursive: true, force: true }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Failed to delete dataset ${datasetId}: ${resp.status} ${body}`,
    );
  }
}

async function deleteNfsShare(
  apiUrl: string,
  apiKey: string,
  shareId: number,
): Promise<void> {
  const resp = await fetch(
    `${apiUrl}/api/v2.0/sharing/nfs/id/${shareId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Failed to delete NFS share ${shareId}: ${resp.status} ${body}`,
    );
  }
}

// --- Analysis ---

function analyzeDatasets(
  pvMap: Map<string, PvInfo>,
  datasets: Dataset[],
  parentId: string,
): DatasetAnalysis[] {
  const results: DatasetAnalysis[] = [];

  for (const ds of datasets) {
    // ds.name is the full path (e.g. "storage/k8s/pvc-abc123..."); extract leaf name
    const shortName = ds.name.split("/").pop() || ds.name;
    const usedBytes = parseInt(ds.used?.rawvalue || "0", 10);

    // Skip non-PVC datasets
    if (!PVC_PATTERN.test(shortName)) {
      results.push({
        datasetId: ds.id,
        shortName,
        parent: parentId,
        usedBytes,
        status: "NON-PVC",
      });
      continue;
    }

    // Look up in PV map by volume handle (short name)
    const pv = pvMap.get(shortName);

    if (pv) {
      const status: DatasetStatus = pv.phase === "Bound" ? "IN USE" : "RELEASED";
      results.push({
        datasetId: ds.id,
        shortName,
        parent: parentId,
        usedBytes,
        status,
        pvName: pv.name,
        pvPhase: pv.phase,
        pvcName: pv.claimRef?.name,
        pvcNamespace: pv.claimRef?.namespace,
      });
    } else {
      results.push({
        datasetId: ds.id,
        shortName,
        parent: parentId,
        usedBytes,
        status: "ORPHANED",
      });
    }
  }

  return results;
}

function printSummaryTable(analyses: DatasetAnalysis[]): void {
  if (analyses.length === 0) {
    console.log(dim("  (no datasets found)"));
    return;
  }

  // Column headers
  const header = `  ${"DATASET".padEnd(52)} ${"SIZE".padStart(10)} ${"STATUS".padEnd(10)} ${"PV PHASE".padEnd(10)} ${"PVC".padEnd(40)}`;
  console.log(bold(header));
  console.log("  " + "-".repeat(header.trimStart().length));

  for (const a of analyses) {
    const datasetLabel = a.datasetId.length > 50
      ? "..." + a.datasetId.slice(-47)
      : a.datasetId.padEnd(50);
    const size = formatBytes(a.usedBytes).padStart(10);
    const phase = (a.pvPhase || "-").padEnd(10);
    const pvc = a.pvcName
      ? `${a.pvcNamespace}/${a.pvcName}`
      : "-";
    const pvcLabel = pvc.length > 38
      ? pvc.slice(0, 35) + "..."
      : pvc.padEnd(40);

    let statusLabel: string;
    switch (a.status) {
      case "IN USE":
        statusLabel = green("IN USE".padEnd(10));
        break;
      case "RELEASED":
        statusLabel = yellow("RELEASED".padEnd(10));
        break;
      case "ORPHANED":
        statusLabel = red("ORPHANED".padEnd(10));
        break;
      case "NON-PVC":
        statusLabel = dim("NON-PVC".padEnd(10));
        break;
    }

    console.log(`  ${datasetLabel}  ${size} ${statusLabel} ${phase} ${pvcLabel}`);
  }
}

async function confirmDeletion(count: number): Promise<boolean> {
  console.log("");
  const msg = `⚠ About to delete ${count} orphaned dataset(s) and their NFS shares. This is irreversible.`;
  console.log(yellow(msg));
  const answer = prompt("Type 'yes' to confirm deletion:");
  return answer?.toLowerCase() === "yes";
}

// --- Main ---

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

  // Fetch data in parallel
  console.log(cyan("INFO: Fetching Kubernetes PVs and TrueNAS datasets..."));

  const [pvResult, sharesResult, ...datasetResults] = await Promise.allSettled([
    fetchK8sPersistentVolumes(),
    fetchShares(opts.apiUrl, apiKey),
    ...DATASET_PARENTS.map((p) => fetchDatasetWithChildren(opts.apiUrl, apiKey, p)),
    ...SNAPSHOT_PARENTS.map((p) => fetchDatasetWithChildren(opts.apiUrl, apiKey, p)),
  ]);

  // Extract PVs
  if (pvResult.status === "rejected") {
    console.error(red(`ERROR: Failed to fetch Kubernetes PVs: ${pvResult.reason}`));
    Deno.exit(1);
  }
  const pvMap = pvResult.value;
  console.log(cyan(`INFO: Found ${pvMap.size} democratic-csi PersistentVolumes`));

  // Extract NFS shares
  if (sharesResult.status === "rejected") {
    console.error(red(`ERROR: Failed to fetch NFS shares: ${sharesResult.reason}`));
    Deno.exit(1);
  }
  const allShares = sharesResult.value;

  // Build share lookup by path for k8s paths
  const sharesByPath = new Map<string, NfsShare>();
  for (const share of allShares) {
    if (share.path.startsWith("/mnt/storage/k8s/") || share.path.startsWith("/mnt/ssd/k8s/")) {
      sharesByPath.set(share.path, share);
    }
  }
  if (opts.verbose) {
    console.log(cyan(`INFO: Found ${sharesByPath.size} k8s NFS shares`));
  }

  // Extract datasets
  const allAnalyses: DatasetAnalysis[] = [];
  const datasetParentCount = DATASET_PARENTS.length;

  for (let i = 0; i < DATASET_PARENTS.length; i++) {
    const result = datasetResults[i];
    const parentId = DATASET_PARENTS[i];

    if (result.status === "rejected") {
      console.error(yellow(`WARN: Failed to fetch ${parentId}: ${result.reason}`));
      continue;
    }

    const parentDs = result.value;
    if (!parentDs) {
      if (opts.verbose) {
        console.log(yellow(`WARN: Dataset ${parentId} not found, skipping`));
      }
      continue;
    }

    const children = parentDs.children || [];
    console.log(cyan(`INFO: Found ${children.length} datasets under ${parentId}`));
    const analyses = analyzeDatasets(pvMap, children, parentId);
    allAnalyses.push(...analyses);
  }

  // Track snapshot datasets for deletion
  const snapshotDatasets = new Map<string, Dataset>();
  for (let i = 0; i < SNAPSHOT_PARENTS.length; i++) {
    const result = datasetResults[datasetParentCount + i];
    const parentId = SNAPSHOT_PARENTS[i];

    if (result.status === "rejected" || !result.value) {
      continue;
    }

    const parentDs = result.value as Dataset;
    for (const child of parentDs.children || []) {
      snapshotDatasets.set(child.name, child);
    }
    if (opts.verbose && (parentDs.children?.length || 0) > 0) {
      console.log(cyan(`INFO: Found ${parentDs.children?.length || 0} snapshot datasets under ${parentId}`));
    }
  }

  // Print summary
  console.log("");
  console.log(bold("--- Dataset Summary ---"));
  printSummaryTable(allAnalyses);

  // Stats
  const inUse = allAnalyses.filter((a) => a.status === "IN USE");
  const released = allAnalyses.filter((a) => a.status === "RELEASED");
  const orphaned = allAnalyses.filter((a) => a.status === "ORPHANED");
  const nonPvc = allAnalyses.filter((a) => a.status === "NON-PVC");

  console.log("");
  console.log(bold("--- Counts ---"));
  console.log(green(`  In Use:    ${inUse.length}`));
  console.log(yellow(`  Released:  ${released.length}`));
  console.log(red(`  Orphaned:  ${orphaned.length}`));
  console.log(dim(`  Non-PVC:   ${nonPvc.length} (skipped)`));

  // Determine targets for deletion
  const targets = opts.includeReleased
    ? [...orphaned, ...released]
    : [...orphaned];

  const totalReclaimable = targets.reduce((sum, a) => sum + a.usedBytes, 0);

  if (targets.length === 0) {
    console.log("");
    console.log(green("OK: No orphaned datasets found. Nothing to clean up."));
    Deno.exit(0);
  }

  console.log("");
  console.log(bold(`Reclaimable space: ${formatBytes(totalReclaimable)} across ${targets.length} dataset(s)`));
  if (opts.includeReleased && released.length > 0) {
    console.log(yellow(`  (includes ${released.length} Released PVs due to --include-released)`));
  }

  // Dry-run: suggest next steps
  if (opts.dryRun) {
    console.log("");
    console.log(yellow("DRY RUN: No changes made. To delete orphaned datasets, run with --delete"));
    if (released.length > 0 && !opts.includeReleased) {
      console.log(yellow("  Add --include-released to also target Released PVs"));
    }
    Deno.exit(0);
  }

  // Confirm before deleting
  if (!opts.yes) {
    const confirmed = await confirmDeletion(targets.length);
    if (!confirmed) {
      console.log(yellow("Aborted. No changes made."));
      Deno.exit(0);
    }
  } else {
    console.log(yellow(`\n--yes: Skipping confirmation, deleting ${targets.length} dataset(s)...`));
  }

  // Delete orphaned datasets
  console.log("");
  console.log(bold("--- Deleting Orphaned Datasets ---"));

  let deleted = 0;
  let errors = 0;

  for (const target of targets) {
    const label = target.datasetId;

    // Delete NFS share first (if exists)
    const mountPath = `/mnt/${target.datasetId}`;
    const share = sharesByPath.get(mountPath);
    if (share) {
      try {
        await deleteNfsShare(opts.apiUrl, apiKey, share.id);
        console.log(green(`OK: Deleted NFS share [${share.id}] ${share.path}`));
      } catch (err) {
        console.error(red(`ERROR: Failed to delete NFS share for ${label}: ${(err as Error).message}`));
        // Continue with dataset deletion anyway
      }
    }

    // Delete snapshot dataset if exists
    const snapshotDs = snapshotDatasets.get(target.shortName);
    if (snapshotDs) {
      try {
        await deleteDataset(opts.apiUrl, apiKey, snapshotDs.id);
        console.log(green(`OK: Deleted snapshot dataset ${snapshotDs.id}`));
      } catch (err) {
        console.error(red(`ERROR: Failed to delete snapshot ${snapshotDs.id}: ${(err as Error).message}`));
      }
    }

    // Delete the dataset
    try {
      await deleteDataset(opts.apiUrl, apiKey, target.datasetId);
      console.log(green(`OK: Deleted dataset ${label} (${formatBytes(target.usedBytes)})`));
      deleted++;
    } catch (err) {
      console.error(red(`ERROR: Failed to delete ${label}: ${(err as Error).message}`));
      errors++;
    }
  }

  // Final summary
  console.log("");
  console.log(bold("--- Deletion Summary ---"));
  console.log(green(`  Deleted: ${deleted}`));
  if (errors > 0) {
    console.log(red(`  Errors:  ${errors}`));
  }
  console.log(`  Space reclaimed: ~${formatBytes(targets.filter((_, i) => i < deleted).reduce((sum, a) => sum + a.usedBytes, 0))}`);

  if (errors > 0) {
    Deno.exit(1);
  }
}

main();
