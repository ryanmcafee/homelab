#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-run

/**
 * truenas-iscsi-migrate.ts
 *
 * Migrates workloads from NFS-backed PVCs to iSCSI block storage with
 * deterministic PV naming. Creates new iSCSI zvols (+ extent/target/
 * target-extent) on TrueNAS, cleans up old NFS PVs/PVCs, and waits
 * for ArgoCD config charts to provision the new static PVs.
 *
 * The old volumes are NFS filesystem datasets under storage/k8s
 * (provisioned by org.democratic-csi.nfs). This script does NOT rename
 * them — it creates brand-new iSCSI zvols with deterministic names.
 *
 * Safe by default: runs in dry-run mode unless --execute is passed.
 * Supports phase-by-phase execution for controlled migration.
 */

const VERSION = "2.0.0";

// Colors for terminal output
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// --- Types ---

type WorkloadType = "deployment" | "statefulset";

/** NFS→iSCSI migration: old NFS dataset will be cleaned up, new iSCSI zvol created */
interface MigrateVolume {
  volumeHandle: string;
  oldNfsDatasetName: string; // e.g. "csi-pvc-38c35b19-...-homelab" under storage/k8s
  newZvolName: string;       // e.g. "csi-sonarr-config-homelab"
  pool: string;              // "storage/k8s"
  sizeBytes: number;
  namespace: string;
  workloadName: string;
  workloadType: WorkloadType;
  rpm: string;
}

/** Brand-new iSCSI volume (no old NFS dataset) */
interface CreateVolume {
  volumeHandle: string;
  zvolName: string;
  pool: string;
  sizeBytes: number;
  namespace: string;
  workloadName: string;
  workloadType: WorkloadType;
  rpm: string;
}

interface NfsCleanup {
  pvcName: string;
  namespace: string;
  datasetPattern: string;
}

interface IscsiExtent {
  id: number;
  name: string;
  disk: string;
  enabled: boolean;
}

interface IscsiTarget {
  id: number;
  name: string;
  groups: Array<{ portal: number; initiator: number; authmethod: string }>;
}

interface IscsiTargetExtent {
  id: number;
  target: number;
  extent: number;
  lunid: number;
}

interface WorkloadState {
  name: string;
  namespace: string;
  type: WorkloadType;
  replicas: number;
}

interface PhaseResult {
  phase: string;
  status: "success" | "partial" | "failed" | "skipped";
  details: string[];
  errors: string[];
  warnings: string[];
}

function makeResult(phase: string): PhaseResult {
  return { phase, status: "success", details: [], errors: [], warnings: [] };
}

// --- Volume Inventory ---

function giToBytes(gi: number): number {
  return gi * 1024 * 1024 * 1024;
}

/** Volumes migrating from NFS datasets to new iSCSI zvols */
const MIGRATIONS: MigrateVolume[] = [
  { volumeHandle: "sonarr-config", oldNfsDatasetName: "csi-pvc-38c35b19-a1ad-480b-9f94-8572acd8bc9c-homelab", newZvolName: "csi-sonarr-config-homelab", pool: "storage/k8s", sizeBytes: giToBytes(10), namespace: "media", workloadName: "sonarr", workloadType: "deployment", rpm: "7200" },
  { volumeHandle: "radarr-config", oldNfsDatasetName: "csi-pvc-a899a2b4-d1fc-4827-9e09-0414e9f05597-homelab", newZvolName: "csi-radarr-config-homelab", pool: "storage/k8s", sizeBytes: giToBytes(10), namespace: "media", workloadName: "radarr", workloadType: "deployment", rpm: "7200" },
  { volumeHandle: "prowlarr-config", oldNfsDatasetName: "csi-pvc-675a592d-efcd-41ee-94cd-2683928116d4-homelab", newZvolName: "csi-prowlarr-config-homelab", pool: "storage/k8s", sizeBytes: giToBytes(1), namespace: "media", workloadName: "prowlarr", workloadType: "deployment", rpm: "7200" },
  { volumeHandle: "nzbget-config", oldNfsDatasetName: "csi-pvc-0cdae8bc-901e-473f-812f-17a4bd97a907-homelab", newZvolName: "csi-nzbget-config-homelab", pool: "storage/k8s", sizeBytes: giToBytes(5), namespace: "media", workloadName: "nzbget", workloadType: "deployment", rpm: "7200" },
  { volumeHandle: "tautulli-config", oldNfsDatasetName: "csi-pvc-e72a2543-eefb-4e01-8924-8e19ed5bd227-homelab", newZvolName: "csi-tautulli-config-homelab", pool: "storage/k8s", sizeBytes: giToBytes(5), namespace: "media", workloadName: "tautulli", workloadType: "deployment", rpm: "7200" },
  { volumeHandle: "lazylibrarian-config", oldNfsDatasetName: "csi-pvc-fe0cd214-d234-44a7-a60d-2460e94b63ac-homelab", newZvolName: "csi-lazylibrarian-config-homelab", pool: "storage/k8s", sizeBytes: giToBytes(5), namespace: "media", workloadName: "lazylibrarian", workloadType: "deployment", rpm: "7200" },
  { volumeHandle: "flaresolverr-config", oldNfsDatasetName: "csi-pvc-4e3e698e-5a65-4c66-9515-72e01baf8776-homelab", newZvolName: "csi-flaresolverr-config-homelab", pool: "storage/k8s", sizeBytes: giToBytes(1), namespace: "media", workloadName: "flaresolverr", workloadType: "deployment", rpm: "7200" },
  { volumeHandle: "mosquitto-config", oldNfsDatasetName: "csi-pvc-01298619-954c-44a5-844e-208efdaa616f-homelab", newZvolName: "csi-mosquitto-config-homelab", pool: "storage/k8s", sizeBytes: giToBytes(1), namespace: "home-automation", workloadName: "mosquitto", workloadType: "deployment", rpm: "7200" },
  { volumeHandle: "mosquitto-data", oldNfsDatasetName: "csi-pvc-79e9e8ff-41d9-4838-a8f8-e48ee6f0b1ef-homelab", newZvolName: "csi-mosquitto-data-homelab", pool: "storage/k8s", sizeBytes: giToBytes(1), namespace: "home-automation", workloadName: "mosquitto", workloadType: "deployment", rpm: "7200" },
  { volumeHandle: "mosquitto-configinc", oldNfsDatasetName: "csi-pvc-4e7c3c1f-7f5f-4609-82b6-d3a6b49fac1c-homelab", newZvolName: "csi-mosquitto-configinc-homelab", pool: "storage/k8s", sizeBytes: giToBytes(1), namespace: "home-automation", workloadName: "mosquitto", workloadType: "deployment", rpm: "7200" },
  { volumeHandle: "homeassistant-config", oldNfsDatasetName: "csi-pvc-148d88bc-110f-4a6d-bf2f-1265d64f6aed-homelab", newZvolName: "csi-homeassistant-config-homelab", pool: "storage/k8s", sizeBytes: giToBytes(10), namespace: "home-automation", workloadName: "home-assistant", workloadType: "deployment", rpm: "7200" },
  { volumeHandle: "grafana-config", oldNfsDatasetName: "csi-pvc-51ce155b-9944-4761-bc64-d64404a0a398-homelab", newZvolName: "csi-grafana-config-homelab", pool: "storage/k8s", sizeBytes: giToBytes(10), namespace: "monitoring", workloadName: "kube-prometheus-stack-grafana", workloadType: "deployment", rpm: "7200" },
];

/** Brand-new iSCSI volumes (no pre-existing NFS dataset) */
const CREATES: CreateVolume[] = [
  { volumeHandle: "plex-config-iscsi", zvolName: "csi-plex-config-iscsi-homelab", pool: "ssd/iscsi", sizeBytes: giToBytes(100), namespace: "media", workloadName: "plex-plex-media-server", workloadType: "statefulset", rpm: "SSD" },
  { volumeHandle: "prometheus-db", zvolName: "csi-prometheus-db-homelab", pool: "storage/k8s", sizeBytes: giToBytes(100), namespace: "monitoring", workloadName: "prometheus-kube-prometheus-stack-prometheus", workloadType: "statefulset", rpm: "7200" },
  { volumeHandle: "alertmanager-db", zvolName: "csi-alertmanager-db-homelab", pool: "storage/k8s", sizeBytes: giToBytes(10), namespace: "monitoring", workloadName: "alertmanager-kube-prometheus-stack-alertmanager", workloadType: "statefulset", rpm: "7200" },
];

const NFS_CLEANUPS: NfsCleanup[] = [
  { pvcName: "kube-prometheus-stack-grafana", namespace: "monitoring", datasetPattern: "csi-pvc-268a6235" },
  { pvcName: "alertmanager-kube-prometheus-stack-alertmanager-db-alertmanager-kube-prometheus-stack-alertmanager-0", namespace: "monitoring", datasetPattern: "csi-pvc-47cfcbdd" },
  { pvcName: "prometheus-kube-prometheus-stack-prometheus-db-prometheus-kube-prometheus-stack-prometheus-0", namespace: "monitoring", datasetPattern: "csi-pvc-d04e6ba4" },
  { pvcName: "mosquitto-configinc", namespace: "home-automation", datasetPattern: "csi-pvc-4e7c3c1f" },
];

// All valid phase names
const PHASES = [
  "discovery",
  "preflight",
  "scale-down",
  "truenas-provision",
  "truenas-create",
  "k8s-cleanup",
  "wait-gitops",
  "scale-up",
  "verify",
] as const;
type PhaseName = typeof PHASES[number];

// --- CLI ---

interface Options {
  help: boolean;
  dryRun: boolean;
  execute: boolean;
  phase: PhaseName | null;
  skipK8s: boolean;
  skipTruenas: boolean;
  skipScale: boolean;
  skipNfsCleanup: boolean;
  timeout: number;
  verbose: boolean;
  apiUrl: string;
  verifySsl: boolean;
}

function printHelp(): void {
  console.log(`
${bold("truenas-iscsi-migrate")} v${VERSION}

Migrate workloads from NFS-backed PVCs to iSCSI block storage with
deterministic PV naming. Creates new iSCSI zvols on TrueNAS and cleans
up old NFS PVs/PVCs.

${bold("USAGE:")}
  deno run --allow-net --allow-env --allow-read --allow-run scripts/truenas-iscsi-migrate.ts [OPTIONS]

${bold("OPTIONS:")}
  --help, -h              Show this help
  --dry-run               Preview only (DEFAULT)
  --execute               Actually execute changes
  --phase=<name>          Run single phase: ${PHASES.join("|")}
  --skip-k8s              Skip Kubernetes operations
  --skip-truenas          Skip TrueNAS operations
  --skip-scale            Skip scale down/up
  --skip-nfs-cleanup      Skip NFS orphan cleanup
  --timeout <ms>          Wait timeout (default: 300000)
  --verbose               Debug output
  --api-url <url>         TrueNAS API URL (default: env TRUENAS_API_URL or https://truenas.ryanmcafee.com)
  --verify-ssl            Enable SSL verification (default: disabled)

${bold("PHASES:")}
  discovery          Discover TrueNAS extents, datasets, K8s PVs
  preflight          Validate preconditions (warnings for missing workloads)
  scale-down         Scale existing workloads to 0 replicas
  truenas-provision  Create iSCSI zvols for NFS-migrated volumes
  truenas-create     Create brand-new iSCSI zvols
  k8s-cleanup        Delete old NFS PVs/PVCs and orphaned NFS PVCs
  wait-gitops        Wait for ArgoCD config apps to sync
  scale-up           Restore workload replicas
  verify             Verify all PVCs bound and pods running

${bold("ENVIRONMENT:")}
  TRUENAS_API_KEY     TrueNAS API key (required)
  TRUENAS_API_URL     TrueNAS API base URL (optional)

${bold("EXAMPLES:")}
  # Preview all changes (safe)
  deno run --allow-net --allow-env --allow-read --allow-run scripts/truenas-iscsi-migrate.ts

  # Execute full migration
  op run --env-file=.env.op -- deno run --allow-net --allow-env --allow-read --allow-run scripts/truenas-iscsi-migrate.ts --execute

  # Run single phase
  op run --env-file=.env.op -- deno run --allow-net --allow-env --allow-read --allow-run scripts/truenas-iscsi-migrate.ts --execute --phase=discovery
`);
}

function parseArgs(args: string[]): Options {
  const opts: Options = {
    help: false,
    dryRun: true,
    execute: false,
    phase: null,
    skipK8s: false,
    skipTruenas: false,
    skipScale: false,
    skipNfsCleanup: false,
    timeout: 300000,
    verbose: false,
    apiUrl: Deno.env.get("TRUENAS_API_URL") || "https://truenas.ryanmcafee.com",
    verifySsl: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--execute") {
      opts.execute = true;
      opts.dryRun = false;
    } else if (arg.startsWith("--phase=")) {
      const phase = arg.split("=")[1] as PhaseName;
      if (!PHASES.includes(phase)) {
        console.error(red(`ERROR: Unknown phase: ${phase}`));
        console.error(`Valid phases: ${PHASES.join(", ")}`);
        Deno.exit(1);
      }
      opts.phase = phase;
    } else if (arg === "--skip-k8s") {
      opts.skipK8s = true;
    } else if (arg === "--skip-truenas") {
      opts.skipTruenas = true;
    } else if (arg === "--skip-scale") {
      opts.skipScale = true;
    } else if (arg === "--skip-nfs-cleanup") {
      opts.skipNfsCleanup = true;
    } else if (arg === "--timeout") {
      opts.timeout = parseInt(args[++i], 10);
    } else if (arg === "--verbose") {
      opts.verbose = true;
    } else if (arg === "--api-url") {
      opts.apiUrl = args[++i];
    } else if (arg === "--verify-ssl") {
      opts.verifySsl = true;
    } else {
      console.error(red(`ERROR: Unknown argument: ${arg}`));
      Deno.exit(1);
    }
  }

  return opts;
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

// --- TrueNAS API ---

async function truenasGet<T>(apiUrl: string, apiKey: string, path: string): Promise<T> {
  const resp = await fetch(`${apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GET ${path} failed: ${resp.status} ${body}`);
  }

  return await resp.json();
}

async function truenasPost<T>(apiUrl: string, apiKey: string, path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const respBody = await resp.text();
    throw new Error(`POST ${path} failed: ${resp.status} ${respBody}`);
  }

  return await resp.json();
}

async function truenasCheck(apiUrl: string, apiKey: string, path: string): Promise<{ ok: boolean; status: number }> {
  const resp = await fetch(`${apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  await resp.text();
  return { ok: resp.ok, status: resp.status };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// --- Shared iSCSI volume creation ---

async function createIscsiVolume(
  apiUrl: string,
  apiKey: string,
  name: string,
  pool: string,
  sizeBytes: number,
  rpm: string,
  opts: Options,
): Promise<boolean> {
  // Step 1: Create zvol
  console.log(cyan(`  Creating zvol: ${pool}/${name} (${formatBytes(sizeBytes)})...`));
  await truenasPost(apiUrl, apiKey, "/api/v2.0/pool/dataset", {
    name: `${pool}/${name}`,
    type: "VOLUME",
    volsize: sizeBytes,
    volblocksize: "16K",
  });
  console.log(green(`  OK: Zvol created`));

  // Step 2: Create extent
  console.log(cyan(`  Creating extent: ${name}...`));
  const extent = await truenasPost<IscsiExtent>(apiUrl, apiKey, "/api/v2.0/iscsi/extent", {
    name: name,
    type: "DISK",
    disk: `zvol/${pool}/${name}`,
    blocksize: 512,
    rpm: rpm,
    enabled: true,
  });
  console.log(green(`  OK: Extent created (id=${extent.id})`));

  // Step 3: Create target
  console.log(cyan(`  Creating target: ${name}...`));
  const target = await truenasPost<IscsiTarget>(apiUrl, apiKey, "/api/v2.0/iscsi/target", {
    name: name,
    groups: [{ portal: 1, initiator: 1, authmethod: "NONE" }],
  });
  console.log(green(`  OK: Target created (id=${target.id})`));

  // Step 4: Create target-extent mapping
  console.log(cyan(`  Creating target-extent mapping...`));
  await truenasPost(apiUrl, apiKey, "/api/v2.0/iscsi/targetextent", {
    target: target.id,
    extent: extent.id,
    lunid: 0,
  });
  console.log(green(`  OK: Target-extent mapping created`));

  if (opts.verbose) {
    console.log(dim(`  zvol=${pool}/${name} extent=${extent.id} target=${target.id}`));
  }

  return true;
}

// --- Phase Implementations ---

interface DiscoveryState {
  /** Extent names that already exist as iSCSI volumes */
  existingIscsiNames: Set<string>;
  /** Dataset short names under storage/k8s (old NFS datasets) */
  oldNfsDatasets: Set<string>;
  /** All iSCSI extents (for verbose dump) */
  extents: IscsiExtent[];
}

async function phaseDiscovery(
  apiUrl: string,
  apiKey: string,
  opts: Options,
): Promise<{ result: PhaseResult; state: DiscoveryState }> {
  const result = makeResult("discovery");

  console.log(bold("\n=== Phase 1: Discovery ===\n"));

  // Parallel fetch: iSCSI resources + NFS datasets
  console.log(cyan("INFO: Fetching TrueNAS iSCSI extents and NFS datasets..."));

  const [extents, storageK8sCheck, ssdIscsiCheck] = await Promise.allSettled([
    truenasGet<IscsiExtent[]>(apiUrl, apiKey, "/api/v2.0/iscsi/extent"),
    truenasGet<{ children: Array<{ name: string; type: string }> }>(
      apiUrl, apiKey, `/api/v2.0/pool/dataset/id/${encodeURIComponent("storage/k8s")}`,
    ),
    truenasGet<{ children: Array<{ name: string; type: string }> }>(
      apiUrl, apiKey, `/api/v2.0/pool/dataset/id/${encodeURIComponent("ssd/iscsi")}`,
    ),
  ]);

  // Process iSCSI extents
  const iscsiExtents = extents.status === "fulfilled" ? extents.value : [];
  const existingIscsiNames = new Set<string>();
  for (const ext of iscsiExtents) {
    existingIscsiNames.add(ext.name);
  }

  console.log(cyan(`INFO: Found ${iscsiExtents.length} existing iSCSI extents`));

  if (opts.verbose && iscsiExtents.length > 0) {
    console.log(dim("  Existing iSCSI extents:"));
    for (const ext of iscsiExtents) {
      console.log(dim(`    [${ext.id}] name="${ext.name}" disk="${ext.disk}"`));
    }
  }

  // Process NFS datasets under storage/k8s
  const oldNfsDatasets = new Set<string>();
  if (storageK8sCheck.status === "fulfilled") {
    for (const child of storageK8sCheck.value.children || []) {
      const shortName = child.name.split("/").pop() || child.name;
      oldNfsDatasets.add(shortName);
    }
    console.log(cyan(`INFO: Found ${oldNfsDatasets.size} datasets under storage/k8s`));
  } else {
    console.log(yellow("WARN: Could not fetch storage/k8s datasets"));
  }

  // Process datasets under ssd/iscsi
  if (ssdIscsiCheck.status === "fulfilled") {
    for (const child of ssdIscsiCheck.value.children || []) {
      const shortName = child.name.split("/").pop() || child.name;
      // Track ssd/iscsi zvols too for CREATES idempotency check
      existingIscsiNames.add(shortName);
    }
    const ssdCount = ssdIscsiCheck.value.children?.length || 0;
    if (opts.verbose) console.log(dim(`  Found ${ssdCount} datasets under ssd/iscsi`));
  }

  result.details.push(`${iscsiExtents.length} iSCSI extents, ${oldNfsDatasets.size} NFS datasets`);

  // Analyze MIGRATIONS
  console.log("");
  console.log(bold("--- Migration Plan (NFS → iSCSI) ---"));
  console.log(bold(`  ${"Handle".padEnd(25)} ${"Old NFS Dataset".padEnd(20)} ${"New iSCSI Zvol".padEnd(40)} ${"Size".padStart(10)} ${"Status"}`));
  console.log("  " + "-".repeat(110));

  for (const m of MIGRATIONS) {
    const oldExists = oldNfsDatasets.has(m.oldNfsDatasetName);
    const newExists = existingIscsiNames.has(m.newZvolName);
    let status: string;
    if (newExists) {
      status = green("DONE (zvol exists)");
      result.details.push(`${m.volumeHandle}: already provisioned`);
    } else if (oldExists) {
      status = yellow("READY (old NFS found)");
      result.details.push(`${m.volumeHandle}: old NFS dataset found, will create iSCSI zvol`);
    } else {
      status = cyan("CREATE (no old data)");
      result.details.push(`${m.volumeHandle}: no old dataset, will create fresh iSCSI zvol`);
    }
    // Truncate old dataset name for display
    const oldShort = m.oldNfsDatasetName.length > 18
      ? m.oldNfsDatasetName.slice(0, 15) + "..."
      : m.oldNfsDatasetName;
    console.log(`  ${m.volumeHandle.padEnd(25)} ${dim(oldShort.padEnd(20))} ${m.newZvolName.padEnd(40)} ${formatBytes(m.sizeBytes).padStart(10)} ${status}`);
  }

  // Analyze CREATES
  console.log("");
  console.log(bold("--- New Volume Plan ---"));
  console.log(bold(`  ${"Handle".padEnd(25)} ${"Pool".padEnd(15)} ${"Zvol Name".padEnd(40)} ${"Size".padStart(10)} ${"Status"}`));
  console.log("  " + "-".repeat(105));
  for (const create of CREATES) {
    const exists = existingIscsiNames.has(create.zvolName);
    const status = exists ? green("EXISTS") : yellow(create.rpm);
    result.details.push(`${create.volumeHandle}: ${exists ? "already exists" : "will create"}`);
    console.log(`  ${create.volumeHandle.padEnd(25)} ${create.pool.padEnd(15)} ${create.zvolName.padEnd(40)} ${formatBytes(create.sizeBytes).padStart(10)} ${status}`);
  }

  if (NFS_CLEANUPS.length > 0 && !opts.skipNfsCleanup) {
    console.log("");
    console.log(bold("--- NFS Cleanup Plan ---"));
    console.log(bold(`  ${"PVC Name".padEnd(80)} ${"Namespace".padEnd(15)} ${"Dataset Pattern"}`));
    console.log("  " + "-".repeat(120));
    for (const nfs of NFS_CLEANUPS) {
      console.log(`  ${nfs.pvcName.padEnd(80)} ${nfs.namespace.padEnd(15)} ${nfs.datasetPattern}`);
    }
  }

  return { result, state: { existingIscsiNames, oldNfsDatasets, extents: iscsiExtents } };
}

async function phasePreflight(
  apiUrl: string,
  apiKey: string,
  opts: Options,
  discovery: DiscoveryState,
): Promise<PhaseResult> {
  const result = makeResult("preflight");

  console.log(bold("\n=== Phase 2: Preflight Checks ===\n"));

  // Check TrueNAS API
  if (!opts.skipTruenas) {
    try {
      await truenasGet(apiUrl, apiKey, "/api/v2.0/system/info");
      console.log(green("  OK: TrueNAS API reachable"));
      result.details.push("TrueNAS API reachable");
    } catch (err) {
      console.error(red(`  FAIL: TrueNAS API unreachable: ${(err as Error).message}`));
      result.errors.push("TrueNAS API unreachable");
    }
  }

  // Check kubectl context
  if (!opts.skipK8s) {
    try {
      const ctx = (await runKubectl(["config", "current-context"])).trim();
      console.log(green(`  OK: kubectl context: ${ctx}`));
      result.details.push(`kubectl context: ${ctx}`);
    } catch (err) {
      console.error(red(`  FAIL: kubectl not configured: ${(err as Error).message}`));
      result.errors.push("kubectl not configured");
    }
  }

  // Check migration volumes
  if (!opts.skipTruenas) {
    let toProvision = 0;
    let alreadyDone = 0;
    for (const m of MIGRATIONS) {
      if (discovery.existingIscsiNames.has(m.newZvolName)) {
        alreadyDone++;
      } else {
        toProvision++;
      }
    }
    console.log(green(`  OK: ${toProvision} iSCSI zvols to provision, ${alreadyDone} already done`));
    result.details.push(`Migrations: ${toProvision} to provision, ${alreadyDone} done`);
  }

  // Check CREATES
  if (!opts.skipTruenas) {
    let toCreate = 0;
    let createExists = 0;
    for (const c of CREATES) {
      if (discovery.existingIscsiNames.has(c.zvolName)) {
        createExists++;
      } else {
        toCreate++;
      }
    }
    console.log(green(`  OK: ${toCreate} new zvols to create, ${createExists} already exist`));
    result.details.push(`Creates: ${toCreate} needed, ${createExists} exist`);
  }

  // Check workloads — WARN only, don't fail (workloads may not be deployed yet)
  if (!opts.skipK8s) {
    const workloads = deduplicateWorkloads();
    let found = 0;
    let missing = 0;
    for (const w of workloads) {
      try {
        const resource = w.type === "deployment" ? "deployment" : "statefulset";
        await runKubectl(["get", resource, w.name, "-n", w.namespace, "-o", "name"]);
        found++;
        if (opts.verbose) console.log(green(`  OK: ${w.type}/${w.name} in ${w.namespace}`));
      } catch {
        missing++;
        console.log(yellow(`  WARN: ${w.type}/${w.name} not found in ${w.namespace} (may not be deployed yet)`));
        result.warnings.push(`Workload not found: ${w.type}/${w.name} in ${w.namespace}`);
      }
    }
    console.log(missing === 0
      ? green(`  OK: All ${found} workloads found`)
      : yellow(`  INFO: ${found} workloads found, ${missing} not yet deployed (will be created by GitOps)`));
    result.details.push(`Workloads: ${found} found, ${missing} not yet deployed`);
  }

  // Only fail on hard errors (API, kubectl) — not missing workloads
  if (result.errors.length > 0) {
    result.status = "failed";
  }

  return result;
}

function deduplicateWorkloads(): Array<{ name: string; namespace: string; type: WorkloadType }> {
  const seen = new Set<string>();
  const workloads: Array<{ name: string; namespace: string; type: WorkloadType }> = [];

  for (const m of MIGRATIONS) {
    const key = `${m.namespace}/${m.workloadType}/${m.workloadName}`;
    if (!seen.has(key)) {
      seen.add(key);
      workloads.push({ name: m.workloadName, namespace: m.namespace, type: m.workloadType });
    }
  }
  for (const c of CREATES) {
    const key = `${c.namespace}/${c.workloadType}/${c.workloadName}`;
    if (!seen.has(key)) {
      seen.add(key);
      workloads.push({ name: c.workloadName, namespace: c.namespace, type: c.workloadType });
    }
  }

  return workloads;
}

async function phaseScaleDown(
  opts: Options,
): Promise<{ result: PhaseResult; savedState: Map<string, WorkloadState> }> {
  const result = makeResult("scale-down");
  const savedState = new Map<string, WorkloadState>();

  console.log(bold("\n=== Phase 3: Scale Down ===\n"));

  if (opts.skipScale || opts.skipK8s) {
    console.log(yellow("SKIP: Scale down skipped (--skip-scale or --skip-k8s)"));
    result.status = "skipped";
    return { result, savedState };
  }

  const workloads = deduplicateWorkloads();

  // Get current replica counts — skip workloads that don't exist yet
  for (const w of workloads) {
    try {
      const resource = w.type === "deployment" ? "deployment" : "statefulset";
      const raw = await runKubectl(["get", resource, w.name, "-n", w.namespace, "-o", "json"]);
      const obj = JSON.parse(raw);
      const replicas = obj.spec?.replicas ?? 1;
      const key = `${w.namespace}/${w.name}`;
      savedState.set(key, { name: w.name, namespace: w.namespace, type: w.type, replicas });
    } catch {
      console.log(yellow(`  SKIP: ${w.type}/${w.name} not found in ${w.namespace} (not deployed)`));
      result.warnings.push(`${w.namespace}/${w.name}: not deployed, skipping`);
    }
  }

  if (savedState.size === 0) {
    console.log(yellow("INFO: No deployed workloads to scale down"));
    result.details.push("No deployed workloads to scale");
    return { result, savedState };
  }

  // Print saved state for manual recovery
  console.log(cyan("INFO: Current replica counts (save for manual recovery):"));
  for (const [key, state] of savedState) {
    console.log(`  ${key}: ${state.replicas} replicas (${state.type})`);
    result.details.push(`${key}: ${state.replicas} replicas`);
  }

  if (opts.dryRun) {
    console.log(yellow("\nDRY RUN: Would scale deployed workloads to 0"));
    result.status = "skipped";
    return { result, savedState };
  }

  // Scale each found workload to 0
  for (const [key, state] of savedState) {
    const resource = state.type === "deployment" ? "deployment" : "statefulset";
    try {
      await runKubectl(["scale", resource, state.name, "-n", state.namespace, "--replicas=0"]);
      console.log(green(`  OK: Scaled ${resource}/${state.name} to 0 in ${state.namespace}`));
    } catch (err) {
      console.error(red(`  ERROR: Failed to scale ${key}: ${(err as Error).message}`));
      result.errors.push(`Scale failed: ${key}`);
    }
  }

  // Brief wait for pods to terminate
  console.log(cyan("\nINFO: Waiting for pods to terminate..."));
  await new Promise((r) => setTimeout(r, 5000));

  for (const [_key, state] of savedState) {
    try {
      await runKubectl([
        "wait", "--for=delete", "pod",
        "-l", `app.kubernetes.io/name=${state.name}`,
        "-n", state.namespace,
        "--timeout=60s",
      ]);
    } catch {
      // Pods may already be gone or label may not match
    }
  }

  console.log(green(`OK: Scaled ${savedState.size} workloads to 0`));

  if (result.errors.length > 0) {
    result.status = "partial";
  }

  return { result, savedState };
}

async function phaseTruenasProvision(
  apiUrl: string,
  apiKey: string,
  opts: Options,
  discovery: DiscoveryState,
): Promise<PhaseResult> {
  const result = makeResult("truenas-provision");

  console.log(bold("\n=== Phase 4: TrueNAS Provision (NFS → iSCSI) ===\n"));

  if (opts.skipTruenas) {
    console.log(yellow("SKIP: TrueNAS operations skipped (--skip-truenas)"));
    result.status = "skipped";
    return result;
  }

  for (const m of MIGRATIONS) {
    // Idempotent: already exists
    if (discovery.existingIscsiNames.has(m.newZvolName)) {
      console.log(green(`  SKIP: ${m.volumeHandle} iSCSI zvol already exists`));
      result.details.push(`${m.volumeHandle}: already exists`);
      continue;
    }

    if (opts.dryRun) {
      console.log(yellow(`  DRY RUN: Would create iSCSI zvol ${m.pool}/${m.newZvolName} (${formatBytes(m.sizeBytes)}, ${m.rpm})`));
      result.details.push(`${m.volumeHandle}: dry-run`);
      continue;
    }

    try {
      console.log(cyan(`\n  Provisioning ${m.volumeHandle}: ${m.pool}/${m.newZvolName}`));
      await createIscsiVolume(apiUrl, apiKey, m.newZvolName, m.pool, m.sizeBytes, m.rpm, opts);
      result.details.push(`${m.volumeHandle}: provisioned`);
    } catch (err) {
      console.error(red(`  ERROR: ${m.volumeHandle}: ${(err as Error).message}`));
      result.errors.push(`${m.volumeHandle}: ${(err as Error).message}`);
    }
  }

  if (result.errors.length > 0) {
    result.status = result.errors.length === MIGRATIONS.length ? "failed" : "partial";
  }

  return result;
}

async function phaseTruenasCreate(
  apiUrl: string,
  apiKey: string,
  opts: Options,
  discovery: DiscoveryState,
): Promise<PhaseResult> {
  const result = makeResult("truenas-create");

  console.log(bold("\n=== Phase 5: TrueNAS Create (New Volumes) ===\n"));

  if (opts.skipTruenas) {
    console.log(yellow("SKIP: TrueNAS operations skipped (--skip-truenas)"));
    result.status = "skipped";
    return result;
  }

  for (const create of CREATES) {
    // Idempotent: already exists
    if (discovery.existingIscsiNames.has(create.zvolName)) {
      console.log(green(`  SKIP: ${create.volumeHandle} zvol already exists`));
      result.details.push(`${create.volumeHandle}: already exists`);
      continue;
    }

    if (opts.dryRun) {
      console.log(yellow(`  DRY RUN: Would create ${create.pool}/${create.zvolName} (${formatBytes(create.sizeBytes)}, ${create.rpm})`));
      result.details.push(`${create.volumeHandle}: dry-run`);
      continue;
    }

    try {
      console.log(cyan(`\n  Creating ${create.volumeHandle}: ${create.pool}/${create.zvolName}`));
      await createIscsiVolume(apiUrl, apiKey, create.zvolName, create.pool, create.sizeBytes, create.rpm, opts);
      result.details.push(`${create.volumeHandle}: created`);
    } catch (err) {
      console.error(red(`  ERROR: ${create.volumeHandle}: ${(err as Error).message}`));
      result.errors.push(`${create.volumeHandle}: ${(err as Error).message}`);
    }
  }

  if (result.errors.length > 0) {
    result.status = result.errors.length === CREATES.length ? "failed" : "partial";
  }

  return result;
}

async function phaseK8sCleanup(
  opts: Options,
): Promise<PhaseResult> {
  const result = makeResult("k8s-cleanup");

  console.log(bold("\n=== Phase 6: K8s Cleanup ===\n"));

  if (opts.skipK8s) {
    console.log(yellow("SKIP: Kubernetes operations skipped (--skip-k8s)"));
    result.status = "skipped";
    return result;
  }

  // Get all PVs for cross-reference
  const pvRaw = await runKubectl(["get", "pv", "-o", "json"]);
  const pvData = JSON.parse(pvRaw);

  // Delete old NFS PVs/PVCs for MIGRATIONS
  console.log(cyan("INFO: Cleaning up old NFS PVs/PVCs for migrated volumes..."));

  for (const m of MIGRATIONS) {
    // Match by volumeHandle (the UUID portion from the old NFS dataset name)
    const matchingPv = pvData.items.find((pv: Record<string, unknown>) => {
      const handle = (pv as { spec?: { csi?: { volumeHandle?: string } } }).spec?.csi?.volumeHandle;
      return handle && m.oldNfsDatasetName.includes(handle);
    });

    if (!matchingPv) {
      // Also try matching by claim name patterns
      const claimPv = pvData.items.find((pv: Record<string, unknown>) => {
        const ref = (pv as { spec?: { claimRef?: { name: string; namespace: string } } }).spec?.claimRef;
        return ref && ref.namespace === m.namespace && (
          ref.name === m.volumeHandle ||
          ref.name.includes(m.workloadName)
        );
      });

      if (!claimPv) {
        console.log(dim(`  SKIP: No old PV found for ${m.volumeHandle} (already cleaned)`));
        result.details.push(`${m.volumeHandle}: no old PV found`);
        continue;
      }
    }

    const pv = matchingPv || null;
    if (!pv) continue;

    const pvName = (pv as { metadata: { name: string } }).metadata.name;
    const claimRef = (pv as { spec?: { claimRef?: { name: string; namespace: string } } }).spec?.claimRef;

    if (opts.dryRun) {
      console.log(yellow(`  DRY RUN: Would delete PV ${pvName}`));
      if (claimRef) {
        console.log(yellow(`  DRY RUN: Would delete PVC ${claimRef.namespace}/${claimRef.name}`));
      }
      continue;
    }

    // Delete PVC first
    if (claimRef) {
      try {
        await runKubectl(["delete", "pvc", claimRef.name, "-n", claimRef.namespace, "--ignore-not-found"]);
        console.log(green(`  OK: Deleted PVC ${claimRef.namespace}/${claimRef.name}`));
      } catch (err) {
        console.error(red(`  ERROR: Failed to delete PVC: ${(err as Error).message}`));
        result.errors.push(`PVC delete failed: ${claimRef.namespace}/${claimRef.name}`);
      }
    }

    // Delete PV
    try {
      await runKubectl(["delete", "pv", pvName, "--ignore-not-found"]);
      console.log(green(`  OK: Deleted PV ${pvName}`));
      result.details.push(`${m.volumeHandle}: old PV/PVC deleted`);
    } catch (err) {
      console.error(red(`  ERROR: Failed to delete PV: ${(err as Error).message}`));
      result.errors.push(`PV delete failed: ${pvName}`);
    }
  }

  // NFS orphan cleanup
  if (!opts.skipNfsCleanup) {
    console.log(cyan("\nINFO: Cleaning up orphaned NFS PVCs..."));

    for (const nfs of NFS_CLEANUPS) {
      if (opts.dryRun) {
        console.log(yellow(`  DRY RUN: Would delete NFS PVC ${nfs.namespace}/${nfs.pvcName}`));
        continue;
      }

      try {
        await runKubectl(["delete", "pvc", nfs.pvcName, "-n", nfs.namespace, "--ignore-not-found"]);
        console.log(green(`  OK: Deleted NFS PVC ${nfs.namespace}/${nfs.pvcName}`));
      } catch (err) {
        console.error(red(`  ERROR: Failed to delete NFS PVC: ${(err as Error).message}`));
        result.errors.push(`NFS PVC delete failed: ${nfs.namespace}/${nfs.pvcName}`);
      }

      // Delete associated PV
      const pvMatch = pvData.items.find((pv: Record<string, unknown>) => {
        const ref = (pv as { spec?: { claimRef?: { name: string; namespace: string } } }).spec?.claimRef;
        return ref && ref.name === nfs.pvcName && ref.namespace === nfs.namespace;
      });

      if (pvMatch) {
        const pvName = (pvMatch as { metadata: { name: string } }).metadata.name;
        try {
          await runKubectl(["delete", "pv", pvName, "--ignore-not-found"]);
          console.log(green(`  OK: Deleted NFS PV ${pvName}`));
        } catch (err) {
          console.error(red(`  ERROR: Failed to delete NFS PV: ${(err as Error).message}`));
          result.errors.push(`NFS PV delete failed: ${pvName}`);
        }
      }

      result.details.push(`NFS cleanup: ${nfs.pvcName}`);
    }
  }

  if (result.errors.length > 0) {
    result.status = "partial";
  }

  return result;
}

async function phaseWaitGitOps(opts: Options): Promise<PhaseResult> {
  const result = makeResult("wait-gitops");

  console.log(bold("\n=== Phase 7: Wait for GitOps ===\n"));

  if (opts.skipK8s) {
    console.log(yellow("SKIP: Kubernetes operations skipped (--skip-k8s)"));
    result.status = "skipped";
    return result;
  }

  if (opts.dryRun) {
    console.log(yellow("DRY RUN: Would wait for ArgoCD config apps to sync and PVCs to bind"));
    result.status = "skipped";
    return result;
  }

  // Collect config app names
  const configApps = new Set<string>();
  for (const m of MIGRATIONS) {
    const appName = m.volumeHandle.replace(/-config$/, "").replace(/-data$/, "");
    configApps.add(`${appName}-config`);
  }
  for (const c of CREATES) {
    const appName = c.volumeHandle.replace(/-config.*$/, "").replace(/-db$/, "");
    configApps.add(`${appName}-config`);
  }

  // Wait for ArgoCD apps to sync
  console.log(cyan(`INFO: Waiting for ${configApps.size} ArgoCD config apps to sync...`));

  const start = Date.now();
  while (Date.now() - start < opts.timeout) {
    let allSynced = true;

    for (const appName of configApps) {
      try {
        const raw = await runKubectl([
          "get", "application", appName, "-n", "argocd", "-o",
          "jsonpath={.status.sync.status}/{.status.health.status}",
        ]);
        const [syncStatus, healthStatus] = raw.trim().split("/");
        if (syncStatus !== "Synced" || healthStatus !== "Healthy") {
          allSynced = false;
          if (opts.verbose) {
            console.log(dim(`  ${appName}: sync=${syncStatus} health=${healthStatus}`));
          }
        }
      } catch {
        allSynced = false;
      }
    }

    if (allSynced) {
      console.log(green("OK: All ArgoCD config apps synced"));
      break;
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  // Wait for PVCs to bind
  console.log(cyan("INFO: Waiting for PVCs to bind..."));

  const pvcChecks: Array<{ name: string; namespace: string }> = [];
  for (const m of MIGRATIONS) {
    pvcChecks.push({ name: m.volumeHandle, namespace: m.namespace });
  }
  for (const c of CREATES) {
    pvcChecks.push({ name: c.volumeHandle, namespace: c.namespace });
  }

  const pvcStart = Date.now();
  while (Date.now() - pvcStart < opts.timeout) {
    let allBound = true;

    for (const pvc of pvcChecks) {
      try {
        const raw = await runKubectl([
          "get", "pvc", pvc.name, "-n", pvc.namespace,
          "-o", "jsonpath={.status.phase}",
        ]);
        if (raw.trim() !== "Bound") {
          allBound = false;
        }
      } catch {
        allBound = false;
      }
    }

    if (allBound) {
      console.log(green("OK: All PVCs bound"));
      result.details.push("All PVCs bound");
      return result;
    }

    if (Date.now() - pvcStart > opts.timeout) {
      result.errors.push("Timed out waiting for PVCs to bind");
      result.status = "failed";
      console.error(red("ERROR: Timed out waiting for PVCs to bind"));
      return result;
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  return result;
}

async function phaseScaleUp(
  opts: Options,
  savedState: Map<string, WorkloadState>,
): Promise<PhaseResult> {
  const result = makeResult("scale-up");

  console.log(bold("\n=== Phase 8: Scale Up ===\n"));

  if (opts.skipScale || opts.skipK8s) {
    console.log(yellow("SKIP: Scale up skipped (--skip-scale or --skip-k8s)"));
    result.status = "skipped";
    return result;
  }

  if (opts.dryRun) {
    console.log(yellow("DRY RUN: Would restore workload replicas"));
    for (const [key, state] of savedState) {
      console.log(yellow(`  DRY RUN: Would scale ${key} to ${state.replicas}`));
    }
    result.status = "skipped";
    return result;
  }

  if (savedState.size === 0) {
    console.log(yellow("INFO: No workloads to scale up (none were scaled down)"));
    return result;
  }

  for (const [key, state] of savedState) {
    const resource = state.type === "deployment" ? "deployment" : "statefulset";
    try {
      await runKubectl(["scale", resource, state.name, "-n", state.namespace, `--replicas=${state.replicas}`]);
      console.log(green(`  OK: Scaled ${key} to ${state.replicas}`));
      result.details.push(`${key}: restored to ${state.replicas}`);
    } catch (err) {
      console.error(red(`  ERROR: Failed to scale ${key}: ${(err as Error).message}`));
      result.errors.push(`Scale up failed: ${key}`);
    }
  }

  // Wait for pods to become Ready
  console.log(cyan("\nINFO: Waiting for pods to become Ready..."));
  for (const [_key, state] of savedState) {
    if (state.replicas === 0) continue;
    const resource = state.type === "deployment" ? "deployment" : "statefulset";
    try {
      await runKubectl([
        "rollout", "status", resource, state.name,
        "-n", state.namespace,
        `--timeout=${Math.floor(opts.timeout / 1000)}s`,
      ]);
    } catch {
      if (opts.verbose) {
        console.log(dim(`  (rollout status for ${state.name} may have timed out)`));
      }
    }
  }

  if (result.errors.length > 0) {
    result.status = "partial";
  }

  return result;
}

async function phaseVerify(opts: Options): Promise<PhaseResult> {
  const result = makeResult("verify");

  console.log(bold("\n=== Phase 9: Verify ===\n"));

  if (opts.skipK8s) {
    console.log(yellow("SKIP: Kubernetes operations skipped (--skip-k8s)"));
    result.status = "skipped";
    return result;
  }

  if (opts.dryRun) {
    console.log(yellow("DRY RUN: Would verify all PVCs bound and pods running"));
    result.status = "skipped";
    return result;
  }

  // Check PVCs
  console.log(cyan("INFO: Checking PVC status..."));
  const allPvcs = [
    ...MIGRATIONS.map((m) => ({ name: m.volumeHandle, namespace: m.namespace, kind: "migrated" })),
    ...CREATES.map((c) => ({ name: c.volumeHandle, namespace: c.namespace, kind: "new" })),
  ];

  let boundCount = 0;
  let issueCount = 0;

  for (const pvc of allPvcs) {
    try {
      const raw = await runKubectl([
        "get", "pvc", pvc.name, "-n", pvc.namespace,
        "-o", "jsonpath={.status.phase}",
      ]);
      const phase = raw.trim();
      if (phase === "Bound") {
        boundCount++;
      } else {
        issueCount++;
        console.log(yellow(`  WARN: PVC ${pvc.namespace}/${pvc.name}: ${phase}`));
        result.warnings.push(`PVC not bound: ${pvc.namespace}/${pvc.name} (${phase})`);
      }
    } catch {
      issueCount++;
      console.log(yellow(`  WARN: PVC ${pvc.namespace}/${pvc.name}: not found (config chart may not be synced)`));
      result.warnings.push(`PVC not found: ${pvc.namespace}/${pvc.name}`);
    }
  }

  console.log(boundCount === allPvcs.length
    ? green(`OK: All ${boundCount} PVCs bound`)
    : yellow(`INFO: ${boundCount}/${allPvcs.length} PVCs bound, ${issueCount} pending`));

  // Check pods
  console.log(cyan("\nINFO: Checking workload status..."));
  const workloads = deduplicateWorkloads();
  let runningCount = 0;
  let notDeployed = 0;

  for (const w of workloads) {
    const resource = w.type === "deployment" ? "deployment" : "statefulset";
    try {
      const raw = await runKubectl([
        "get", resource, w.name, "-n", w.namespace,
        "-o", "jsonpath={.status.readyReplicas}/{.spec.replicas}",
      ]);
      const [ready, desired] = raw.trim().split("/");
      if (ready === desired && parseInt(ready || "0", 10) > 0) {
        runningCount++;
      } else {
        console.log(yellow(`  WARN: ${w.namespace}/${w.name}: ${ready}/${desired} ready`));
      }
    } catch {
      notDeployed++;
      console.log(dim(`  SKIP: ${w.namespace}/${w.name}: not deployed`));
    }
  }

  const deployedTotal = workloads.length - notDeployed;
  console.log(runningCount === deployedTotal
    ? green(`OK: All ${runningCount} deployed workloads running`)
    : yellow(`INFO: ${runningCount}/${deployedTotal} deployed workloads running, ${notDeployed} not yet deployed`));

  // Final summary table
  console.log("");
  console.log(bold("--- Final Summary ---"));
  console.log(bold(`  ${"Volume Handle".padEnd(25)} ${"Namespace".padEnd(20)} ${"Type".padEnd(12)} ${"Status"}`));
  console.log("  " + "-".repeat(70));

  for (const pvc of allPvcs) {
    try {
      const raw = await runKubectl([
        "get", "pvc", pvc.name, "-n", pvc.namespace,
        "-o", "jsonpath={.status.phase}",
      ]);
      const phase = raw.trim();
      const statusColor = phase === "Bound" ? green : yellow;
      console.log(`  ${pvc.name.padEnd(25)} ${pvc.namespace.padEnd(20)} ${pvc.kind.padEnd(12)} ${statusColor(phase)}`);
    } catch {
      console.log(`  ${pvc.name.padEnd(25)} ${pvc.namespace.padEnd(20)} ${pvc.kind.padEnd(12)} ${dim("PENDING")}`);
    }
  }

  if (result.errors.length > 0) {
    result.status = "partial";
  } else {
    result.details.push(`${boundCount} PVCs bound, ${runningCount} workloads running`);
  }

  return result;
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

  console.log(bold(`\ntruenas-iscsi-migrate v${VERSION}\n`));
  console.log(cyan(`INFO: TrueNAS API: ${opts.apiUrl}`));
  console.log(cyan(`INFO: Migrations: ${MIGRATIONS.length}, Creates: ${CREATES.length}, NFS Cleanups: ${NFS_CLEANUPS.length}`));

  if (opts.dryRun) {
    console.log(yellow("DRY RUN: No changes will be made (pass --execute to apply)"));
  } else {
    console.log(red(bold("EXECUTE MODE: Changes WILL be applied")));
  }

  if (opts.phase) {
    console.log(cyan(`INFO: Running single phase: ${opts.phase}`));
  }

  const results: PhaseResult[] = [];
  let savedState = new Map<string, WorkloadState>();

  const shouldRun = (phase: PhaseName): boolean => {
    return opts.phase === null || opts.phase === phase;
  };

  // Phase 1: Discovery (always runs when needed)
  let discovery: DiscoveryState | undefined;
  if (shouldRun("discovery") || shouldRun("preflight") || shouldRun("truenas-provision") || shouldRun("truenas-create")) {
    const disc = await phaseDiscovery(opts.apiUrl, apiKey, opts);
    results.push(disc.result);
    discovery = disc.state;

    if (opts.phase === "discovery") {
      printResults(results);
      Deno.exit(0);
    }
  }

  // Phase 2: Preflight
  if (shouldRun("preflight") && discovery) {
    const preResult = await phasePreflight(opts.apiUrl, apiKey, opts, discovery);
    results.push(preResult);

    if (preResult.status === "failed") {
      console.error(red("\nPreflight checks failed. Aborting."));
      printResults(results);
      Deno.exit(2);
    }

    if (opts.phase === "preflight") {
      printResults(results);
      Deno.exit(0);
    }
  }

  // Phase 3: Scale Down
  if (shouldRun("scale-down")) {
    const scaleResult = await phaseScaleDown(opts);
    results.push(scaleResult.result);
    savedState = scaleResult.savedState;

    if (opts.phase === "scale-down") {
      printResults(results);
      Deno.exit(scaleResult.result.errors.length > 0 ? 1 : 0);
    }
  }

  // Phase 4: TrueNAS Provision (NFS → iSCSI migration)
  if (shouldRun("truenas-provision") && discovery) {
    const provResult = await phaseTruenasProvision(opts.apiUrl, apiKey, opts, discovery);
    results.push(provResult);

    if (opts.phase === "truenas-provision") {
      printResults(results);
      Deno.exit(provResult.errors.length > 0 ? 1 : 0);
    }
  }

  // Phase 5: TrueNAS Create (new volumes)
  if (shouldRun("truenas-create") && discovery) {
    const createResult = await phaseTruenasCreate(opts.apiUrl, apiKey, opts, discovery);
    results.push(createResult);

    if (opts.phase === "truenas-create") {
      printResults(results);
      Deno.exit(createResult.errors.length > 0 ? 1 : 0);
    }
  }

  // Phase 6: K8s Cleanup
  if (shouldRun("k8s-cleanup")) {
    const cleanupResult = await phaseK8sCleanup(opts);
    results.push(cleanupResult);

    if (opts.phase === "k8s-cleanup") {
      printResults(results);
      Deno.exit(cleanupResult.errors.length > 0 ? 1 : 0);
    }
  }

  // Phase 7: Wait for GitOps
  if (shouldRun("wait-gitops")) {
    const gitopsResult = await phaseWaitGitOps(opts);
    results.push(gitopsResult);

    if (opts.phase === "wait-gitops") {
      printResults(results);
      Deno.exit(gitopsResult.errors.length > 0 ? 1 : 0);
    }
  }

  // Phase 8: Scale Up
  if (shouldRun("scale-up")) {
    const scaleUpResult = await phaseScaleUp(opts, savedState);
    results.push(scaleUpResult);

    if (opts.phase === "scale-up") {
      printResults(results);
      Deno.exit(scaleUpResult.errors.length > 0 ? 1 : 0);
    }
  }

  // Phase 9: Verify
  if (shouldRun("verify")) {
    const verifyResult = await phaseVerify(opts);
    results.push(verifyResult);
  }

  // Final summary
  printResults(results);

  const hasErrors = results.some((r) => r.status === "failed");
  const hasPartial = results.some((r) => r.status === "partial");
  Deno.exit(hasErrors ? 2 : hasPartial ? 1 : 0);
}

function printResults(results: PhaseResult[]): void {
  console.log("");
  console.log(bold("=== Migration Results ===\n"));
  console.log(bold(`  ${"Phase".padEnd(22)} ${"Status".padEnd(12)} ${"Details"}`));
  console.log("  " + "-".repeat(70));

  for (const r of results) {
    let statusLabel: string;
    switch (r.status) {
      case "success":
        statusLabel = green("SUCCESS".padEnd(12));
        break;
      case "partial":
        statusLabel = yellow("PARTIAL".padEnd(12));
        break;
      case "failed":
        statusLabel = red("FAILED".padEnd(12));
        break;
      case "skipped":
        statusLabel = dim("SKIPPED".padEnd(12));
        break;
    }
    const warnings = r.warnings.length > 0 ? `, ${r.warnings.length} warnings` : "";
    const detail = r.errors.length > 0
      ? `${r.details.length} ok, ${r.errors.length} errors${warnings}`
      : `${r.details.length} items${warnings}`;
    console.log(`  ${r.phase.padEnd(22)} ${statusLabel} ${detail}`);
  }

  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
  const totalWarnings = results.reduce((sum, r) => sum + r.warnings.length, 0);

  if (totalWarnings > 0) {
    console.log("");
    console.log(yellow(bold(`Warnings: ${totalWarnings}`)));
    for (const r of results) {
      for (const w of r.warnings) {
        console.log(yellow(`  [${r.phase}] ${w}`));
      }
    }
  }

  if (totalErrors > 0) {
    console.log("");
    console.log(red(bold(`Errors: ${totalErrors}`)));
    for (const r of results) {
      for (const err of r.errors) {
        console.log(red(`  [${r.phase}] ${err}`));
      }
    }
  }
}

main();
