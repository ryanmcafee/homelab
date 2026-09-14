#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env --allow-read --allow-write

/**
 * localdev-argocd.ts
 *
 * ArgoCD for the Kind localdev loop: install, sync every Application from the
 * working tree, wait for health, diagnose failures (issue #261 Section B).
 *
 * Subcommands:
 *   install   helm upgrade --install argo-cd at the version pinned in
 *             configuration/versions.yaml (charts.argocd) with
 *             localdev/values/argocd-values.yaml plus one --set-file per health
 *             Lua in charts/bootstrap/files/health, apply the root Application
 *             (localdev/argocd/gitops-app.yaml) and log the argocd CLI in
 *             through a kubectl port-forward. Idempotent.
 *   sync      Walk the Application tree tier by tier and sync each app from the
 *             working tree (`argocd app sync --local`; chart apps sync from
 *             their repo). Tier = the sync-wave path from the root
 *             (gitops [0] → bootstrap [0,0] → addons [0,2] → cilium [0,2,-5]
 *             ...), parent = the app named by the argocd.argoproj.io/
 *             tracking-id annotation (ArgoCD v3 default) or the
 *             app.kubernetes.io/instance label; parents always sync before
 *             their children. Git-path apps are rendered first with `argocd
 *             app manifests --local`; when that yields nothing they are
 *             synced plainly if Git renders nothing either (empty app →
 *             Synced/Healthy), left alone when their path does not exist
 *             on the target revision at all (`git cat-file -e
 *             origin/<rev>:<path>`: a chart new on this branch with nothing
 *             to deploy here; any sync would fail with "app path does not
 *             exist") and refused if Git has manifests (ArgoCD
 *             would silently sync the Git revision instead). Apps
 *             that still carry an automated sync policy are not synced
 *             (ArgoCD does that) but are waited for. A tier
 *             is complete when every app is Healthy with a Succeeded operation
 *             or is a parent whose Running operation waits on child
 *             Applications. Newly created children are discovered every poll.
 *             A later subtree (applications [0,3]) is not started while a
 *             lower parent (addons [0,2]) still holds a wave open: its
 *             remaining children (cloudnative-pg, wave 10) do not exist yet,
 *             and in homelab ArgoCD itself starts applications only once
 *             addons is Healthy. Failed/Error operations are retried 3x with
 *             15 s backoff.
 *   wait      Poll until every Application is Healthy with a Succeeded
 *             operation (--require-synced also demands Synced). Runs diagnose
 *             and exits 1 on timeout.
 *   diagnose  Print conditions, operation message, unhealthy resources, recent
 *             namespace events and failing pod describe/logs for every
 *             Application that is not Healthy/Succeeded. Never throws on
 *             missing fields; stdout only.
 *   report    Markdown "Kind preview (level 2)" report (issue #261 item 17,
 *             posted by tilt-ci.yml as the sticky PR comment `kind-preview`):
 *             the pass/fail line and failing checks of the level-2 JSON
 *             (--verify-json; missing or partial JSON is reported, not
 *             fatal), an Application table (health, last operation, vs main)
 *             and, for every Application that is not Synced, `argocd app diff
 *             <app> --exit-code=false`. The root Application tracks GitHub
 *             main while every app was synced from the working tree with
 *             --local, so that diff is exactly PR head vs main; argocd prints
 *             `diff <live> <target>` (live = PR, target = main), which the
 *             report inverts so `-` is main and `+` is the PR. Diffs share
 *             one byte budget (--max-diff-bytes, 0 = unlimited); small diffs
 *             stay whole, large ones are cut at a line boundary with a note.
 *             When ArgoCD is not reachable (localdev:ci failed early) the
 *             report says so and still exits 0.
 *
 * Automated sync is OFF in localdev (ARGOCD_AUTOMATED_SYNC=false): `argocd app
 * sync --local` refuses automated apps, and the whole point of the loop is to
 * sync the working tree, not GitHub main.
 *
 * ArgoCD API access never depends on the Kind host-port mapping. Docker
 * Desktop's host-port proxy forwards packets with bad TCP checksums; kindnet
 * tolerated them but Cilium's BPF delivery makes the pod validate them, so
 * every SYN to localhost:8080 is dropped ("gRPC connection not ready").
 * Instead, install and sync spawn `kubectl port-forward -n argocd
 * svc/argocd-server <local-port>:80 --address 127.0.0.1` (default 18080, next
 * free port if taken), wait for /healthz, run every argocd command with
 * --server 127.0.0.1:<port> --plaintext --insecure --grpc-web, and kill the
 * port-forward on exit, error, SIGINT and SIGTERM. --server <host:port> skips
 * the port-forward. The login passes --skip-test-tls: the CLI's TLS probe on a
 * plaintext port gets a connection reset, which kubectl port-forward treats as
 * fatal. Every kubectl command pins --context kind-homelab-localdev (ADR-009:
 * agents mutate only Kind).
 *
 * Usage:
 *   task localdev:argocd | localdev:sync | localdev:wait | localdev:diagnose
 *   deno run ... scripts/localdev-argocd.ts --help
 *   deno run ... scripts/localdev-argocd.ts install [--dry-run] [--local-port 18080 | --server host:port]
 *   deno run ... scripts/localdev-argocd.ts sync [--warm] [--only a,b] [--timeout 40m] [--dry-run]
 *   deno run ... scripts/localdev-argocd.ts wait [--require-synced] [--exclude a,b] [--timeout 20m]
 *   deno run ... scripts/localdev-argocd.ts diagnose
 *   deno run ... scripts/localdev-argocd.ts report [--out kind-report.md] [--verify-json verify-level2.json]
 *                                                  [--max-diff-bytes 50000] [--no-diff]
 *
 * Exit codes: 0 = success (report: a report was written, whatever it says);
 *             1 = install/sync/wait failed (diagnostics printed), report could
 *             not write its output; 2 = argument error.
 */

import { parse as parseYaml } from "jsr:@std/yaml@^1";
import { expandGlob } from "jsr:@std/fs@^1/expand-glob";
import { join, normalize, resolve } from "jsr:@std/path@^1";

// ============================================================================
// Logging
// ============================================================================
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** `report` may print the Markdown on stdout, so it moves every log line to stderr. */
let logToStderr = false;
const emit = (line: string) =>
  logToStderr ? console.error(line) : console.log(line);

const log = {
  info: (msg: string) => emit(`${cyan("INFO")}  ${msg}`),
  ok: (msg: string) => emit(`${green("OK")}    ${msg}`),
  warn: (msg: string) => emit(`${yellow("WARN")}  ${msg}`),
  error: (msg: string) => console.error(`${red("ERROR")} ${msg}`),
  dry: (msg: string) => emit(`${yellow("DRY")}   ${msg}`),
};

// ============================================================================
// Constants
// ============================================================================
export const KUBE_CONTEXT = "kind-homelab-localdev";
export const ARGOCD_NAMESPACE = "argocd";
export const ARGOCD_SERVICE = "svc/argocd-server";
export const ARGOCD_SERVICE_PORT = 80;
export const DEFAULT_LOCAL_PORT = 18080;
/** How many consecutive ports to try when the preferred one is taken. */
export const PORT_CANDIDATES = 20;
export const ARGOCD_RELEASE = "argocd";
export const ARGOCD_CHART = "argo-cd";
export const ARGOCD_HELM_REPO = "https://argoproj.github.io/argo-helm";
export const ROOT_APP = "gitops";
export const VERSIONS_YAML = "configuration/versions.yaml";
export const ARGOCD_VALUES = "localdev/values/argocd-values.yaml";
export const ROOT_APP_MANIFEST = "localdev/argocd/gitops-app.yaml";
export const HEALTH_LUA_DIR = "charts/bootstrap/files/health";
export const SYNC_WAVE_ANNOTATION = "argocd.argoproj.io/sync-wave";
export const PARENT_LABEL = "app.kubernetes.io/instance";
export const TRACKING_ANNOTATION = "argocd.argoproj.io/tracking-id";
/** `--warm` never syncs this app nor anything under it. */
export const WARM_EXCLUDED_ROOT = "applications";

const POLL_INTERVAL_MS = 10_000;
const LOGIN_RETRY_MS = 2 * 60_000;
const LOGIN_RETRY_INTERVAL_MS = 5_000;
const SYNC_RETRIES = 3;
const SYNC_RETRY_BACKOFF_MS = 15_000;
const DEFAULT_SYNC_TIMEOUT_MS = 40 * 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60_000;
const HELM_WAIT_TIMEOUT = "10m";
const EVENTS_TAIL = 30;
const DESCRIBE_TAIL = 40;
const LOGS_TAIL = "50";
const PORT_FORWARD_READY_MS = 60_000;
const PORT_FORWARD_PROBE_MS = 500;

/** Connection flags for every argocd invocation against `server`. */
export function serverFlags(server: string): string[] {
  return ["--server", server, "--plaintext", "--insecure", "--grpc-web"];
}

/** The kubectl port-forward that exposes argocd-server on 127.0.0.1:<port>. */
export function portForwardCmd(localPort: number): string[] {
  return [
    "kubectl",
    "--context",
    KUBE_CONTEXT,
    "port-forward",
    "-n",
    ARGOCD_NAMESPACE,
    ARGOCD_SERVICE,
    `${localPort}:${ARGOCD_SERVICE_PORT}`,
    "--address",
    "127.0.0.1",
  ];
}

/** preferred, preferred+1, ... (n entries), staying inside the port range. */
export function candidatePorts(
  preferred: number,
  n = PORT_CANDIDATES,
): number[] {
  const out: number[] = [];
  for (let p = preferred; p <= 65535 && out.length < n; p++) out.push(p);
  return out;
}

/** true when 127.0.0.1:<port> can be bound right now. */
export function portIsFree(port: number): boolean {
  try {
    const l = Deno.listen({ hostname: "127.0.0.1", port });
    l.close();
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) return false;
    throw err;
  }
}

/** The first candidate the probe reports free (probe injectable for tests). */
export function findFreePort(
  candidates: number[],
  probe: (port: number) => boolean = portIsFree,
): number {
  for (const port of candidates) {
    if (probe(port)) return port;
  }
  throw new Error(
    `no free port among ${candidates[0]}-${candidates[candidates.length - 1]}`,
  );
}

// ============================================================================
// Application JSON shape (the subset the orchestrator reads)
// ============================================================================
export interface AppResource {
  group?: string;
  version?: string;
  kind?: string;
  namespace?: string;
  name?: string;
  status?: string;
  health?: { status?: string; message?: string };
}

export interface AppSource {
  repoURL?: string;
  path?: string;
  chart?: string;
  targetRevision?: string;
}

export interface Application {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    source?: AppSource;
    sources?: AppSource[];
    destination?: { namespace?: string; server?: string };
    syncPolicy?: { automated?: unknown };
  };
  status?: {
    health?: { status?: string; message?: string };
    sync?: { status?: string };
    operationState?: {
      phase?: string;
      message?: string;
      startedAt?: string;
      finishedAt?: string;
    };
    resources?: AppResource[];
    conditions?: Array<{ type?: string; message?: string }>;
  };
}

export type AppState = "complete" | "failed" | "pending";
export type SourceKind = "local" | "chart" | "multi";
/** Sync waves from the root down to the app; see tierKey. */
export type TierKey = readonly number[];

// ============================================================================
// Pure functions (unit-tested)
// ============================================================================

/** Sync wave from the annotation; missing or unparsable → 0. */
export function parseWave(app: Application): number {
  const raw = app.metadata?.annotations?.[SYNC_WAVE_ANNOTATION];
  if (raw === undefined || raw === null) return 0;
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parent Application name; root → null. ArgoCD v3 tracks resources with the
 * annotation `argocd.argoproj.io/tracking-id: <app>:<group>/<kind>:<ns>/<name>`
 * (application.resourceTrackingMethod defaults to `annotation`); the
 * `app.kubernetes.io/instance` label is the legacy `label` method. Both are
 * honoured, annotation first.
 */
export function parentOf(app: Application): string | null {
  const tracking = app.metadata?.annotations?.[TRACKING_ANNOTATION];
  if (tracking) {
    const parent = tracking.split(":")[0]?.trim();
    if (parent && parent !== app.metadata.name) return parent;
  }
  const parent = app.metadata?.labels?.[PARENT_LABEL];
  if (!parent || parent === app.metadata.name) return null;
  return parent;
}

/** Automated sync policy: `argocd app sync --local` refuses such apps. */
export function isAutomated(app: Application): boolean {
  const a = app.spec?.syncPolicy?.automated;
  return a !== undefined && a !== null;
}

/** ArgoCD could not generate the app's manifests from its repo. */
export function hasComparisonError(app: Application): boolean {
  return (app.status?.conditions ?? []).some((c) =>
    c?.type === "ComparisonError"
  );
}

/** argocd's wording when an operation is already running on the app. */
export function isOperationInProgress(detail: string): boolean {
  return /another operation is already in progress/i.test(detail);
}

/** name → Application for every app in the list. */
export function indexApps(apps: Application[]): Map<string, Application> {
  const m = new Map<string, Application>();
  for (const a of apps) m.set(a.metadata.name, a);
  return m;
}

/**
 * Tier key: the sync waves along the path from the root to the app, e.g.
 * gitops [0], bootstrap [0,0], sops-secrets [0,0,-2], addons [0,2], cilium
 * [0,2,-5], applications [0,3], sonarr-config [0,3,0]. Keys compare
 * lexicographically with a prefix sorting first, so a parent always precedes
 * its children (also on re-runs, when every app already exists) and whole
 * subtrees stay in wave order: everything under bootstrap before everything
 * under addons before everything under applications. The plan's
 * (parent wave, own wave) pair is the last two elements; it alone would put
 * a negative-wave child (0,-2) before its own parent (0,0).
 *
 * A parent that is not in the index counts as an unknown root of wave 0; a
 * cycle in the tracking annotations is cut where a name repeats.
 */
export function tierKey(
  app: Application,
  byName: Map<string, Application>,
): TierKey {
  const path: number[] = [];
  const seen = new Set<string>();
  let cur: Application | undefined = app;
  while (cur && !seen.has(cur.metadata.name)) {
    seen.add(cur.metadata.name);
    path.unshift(parseWave(cur));
    const parent = parentOf(cur);
    if (parent === null) break;
    const next = byName.get(parent);
    if (!next) {
      path.unshift(0);
      break;
    }
    cur = next;
  }
  return path;
}

export function compareTierKey(a: TierKey, b: TierKey): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function formatTierKey(key: TierKey): string {
  return `[${key.join(" › ")}]`;
}

/**
 * The lowest tier among apps not yet done: every not-done app sharing the
 * minimum key, sorted by name. null when nothing is left.
 */
export function nextTier(
  apps: Application[],
  done: Set<string>,
): { key: TierKey; apps: Application[] } | null {
  const byName = indexApps(apps);
  let best: TierKey | null = null;
  const keyed: Array<{ key: TierKey; app: Application }> = [];
  for (const app of apps) {
    if (done.has(app.metadata.name)) continue;
    const key = tierKey(app, byName);
    keyed.push({ key, app });
    if (best === null || compareTierKey(key, best) < 0) best = key;
  }
  if (best === null) return null;
  const tier = keyed
    .filter((k) => compareTierKey(k.key, best!) === 0)
    .map((k) => k.app)
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  return { key: best, apps: tier };
}

/** A parent: its resources include child Applications (gitops, addons, ...). */
export function isParentApp(app: Application): boolean {
  return (app.status?.resources ?? []).some((r) => r?.kind === "Application");
}

/**
 * complete: Healthy + Succeeded, or a parent ("accepted") whose operation is
 * Running or Succeeded while its child Applications are not Healthy yet —
 * ArgoCD holds a parent's operation open per wave until every child is
 * Healthy, and only this orchestrator syncs the children.
 * failed: operation phase Failed/Error (for a parent: typically a child went
 * Degraded during ArgoCD's wave wait; see parentResyncDecision).
 * Everything else: pending.
 */
export function appState(app: Application): AppState {
  const health = app.status?.health?.status;
  const phase = app.status?.operationState?.phase;
  if (phase === "Failed" || phase === "Error") return "failed";
  if (health === "Healthy" && phase === "Succeeded") return "complete";
  if ((phase === "Running" || phase === "Succeeded") && isParentApp(app)) {
    return "complete";
  }
  return "pending";
}

/**
 * Parents whose operation is still Running: ArgoCD holds a sync wave open on
 * them, and their remaining child Applications only appear once that wave's
 * resources are Healthy (e.g. traefik's wave 7 before the wave-8 children).
 * When nothing else is selected (`--warm`, `--only`) the sync loop must keep
 * polling for those children instead of ending; otherwise the final pass waits
 * forever on a parent whose later children nobody syncs. Sorted by name.
 */
export function parentsAwaitingWaves(apps: Application[]): string[] {
  return apps
    .filter((a) =>
      isParentApp(a) && a.status?.operationState?.phase === "Running"
    )
    .map((a) => a.metadata.name)
    .sort();
}

/** True when `prefix` is a prefix of `key` (a key is a prefix of itself). */
export function isTierKeyPrefix(prefix: TierKey, key: TierKey): boolean {
  if (prefix.length > key.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== key[i]) return false;
  }
  return true;
}

/**
 * The awaiting parent (parentsAwaitingWaves, keyed by tierKey) that must
 * settle before `tier` may start: one whose key is strictly lower than the
 * tier and not a prefix of it. A parent holding a wave open never blocks its
 * own subtree (those are exactly the children this loop syncs for it) and the
 * root [0] is a prefix of everything, so it never blocks; but addons [0,2]
 * Running blocks applications [0,3] and every [0,3,…] tier. Without this the
 * loop moved on to applications while addons' later children (cloudnative-pg
 * at wave 10) did not exist yet, and paperclip-database failed on a missing
 * CNPG CRD. In homelab ArgoCD starts applications only once addons is Healthy
 * (gitops waves); this mirrors that. Returns the lowest such parent (by key,
 * then name), or null.
 */
export function tierBlockedBy(
  tier: TierKey,
  awaiting: Array<{ name: string; key: TierKey }>,
): string | null {
  const blocking = awaiting
    .filter(({ key }) =>
      compareTierKey(key, tier) < 0 && !isTierKeyPrefix(key, tier)
    )
    .sort((x, y) =>
      compareTierKey(x.key, y.key) || x.name.localeCompare(y.name)
    );
  return blocking[0]?.name ?? null;
}

/**
 * Apps not done and not being waited on whose tier key is LOWER than the tier
 * currently being waited on. They belong to an earlier subtree (e.g. a parent
 * created wave-8 children while we waited on another parent's wave-12 child),
 * so their prerequisites are complete and they must be synced immediately
 * instead of after the current tier. Sorted by key, then name.
 */
export function discoverable(
  apps: Application[],
  done: Set<string>,
  active: Set<string>,
  currentKey: TierKey,
): Application[] {
  const byName = indexApps(apps);
  return apps
    .filter((a) => !done.has(a.metadata.name) && !active.has(a.metadata.name))
    .map((a) => ({ a, key: tierKey(a, byName) }))
    .filter(({ key }) => compareTierKey(key, currentKey) < 0)
    .sort((x, y) =>
      compareTierKey(x.key, y.key) ||
      x.a.metadata.name.localeCompare(y.a.metadata.name)
    )
    .map(({ a }) => a);
}

/** Children of `parent` (by tracking annotation/label) that are not done. */
export function pendingChildren(
  parent: string,
  apps: Application[],
  done: Set<string>,
): Application[] {
  return apps.filter((a) =>
    parentOf(a) === parent && !done.has(a.metadata.name)
  );
}

export type ParentResync = "none" | "wait" | "resync" | "give-up";

/**
 * What to do with a parent whose operation is Failed/Error (ArgoCD gave up
 * waiting for a child during a wave): nothing if it is not a failed parent;
 * wait while it still has pending children (they are being synced right
 * now); re-sync it with the same command once they are all complete, up to
 * `limit` times; then give up.
 */
export function parentResyncDecision(
  parent: Application,
  pendingChildCount: number,
  retriesUsed: number,
  limit = SYNC_RETRIES,
): ParentResync {
  if (!isParentApp(parent) || appState(parent) !== "failed") return "none";
  if (pendingChildCount > 0) return "wait";
  if (retriesUsed >= limit) return "give-up";
  return "resync";
}

export type FinalPassDecision = "done" | "wait" | "resync";

/**
 * Final pass over the parents: Succeeded → done; Running/Terminating → wait
 * (the operation may be executing PostSync smoke hooks and must never be cut
 * short); Failed/Error or no operation at all → re-sync from the working
 * tree.
 */
export function finalPassDecision(app: Application): FinalPassDecision {
  const phase = app.status?.operationState?.phase;
  if (phase === "Succeeded") return "done";
  if (phase === "Running" || phase === "Terminating") return "wait";
  return "resync";
}

/**
 * One-line hint when an Application is Degraded only because a child
 * Application is Degraded (the message names "Application/<child>").
 */
export function degradedChildHint(app: Application): string | null {
  if (app.status?.health?.status !== "Degraded") return null;
  const children = (app.status?.resources ?? [])
    .filter((r) => r?.kind === "Application" && r.health?.status === "Degraded")
    .map((r) => r.name ?? "?");
  const msgs = [
    app.status?.health?.message ?? "",
    app.status?.operationState?.message ?? "",
  ];
  if (children.length === 0 && !msgs.some((m) => m.includes("Application/"))) {
    return null;
  }
  const who = children.length > 0 ? children.join(", ") : "a child Application";
  return `${app.metadata.name} is Degraded because ${who} is Degraded: fix the child, then re-run \`task localdev:sync\` (the parent re-syncs once its children are complete)`;
}

export function isAppComplete(app: Application): boolean {
  return appState(app) === "complete";
}

export function isTierComplete(apps: Application[]): boolean {
  return apps.every(isAppComplete);
}

export function sourceKind(app: Application): SourceKind {
  if (Array.isArray(app.spec?.sources) && app.spec.sources.length > 0) {
    return "multi";
  }
  if (app.spec?.source?.path) return "local";
  return "chart";
}

/**
 * argocd arguments (after the binary) that sync one Application. Git-path
 * apps sync from the working tree; chart and multi-source apps sync from their
 * repo (`--local` refuses multi-source apps).
 */
export function syncArgs(
  app: Application,
  repoRoot: string,
  opts: { plain?: boolean } = {},
): string[] {
  const name = app.metadata.name;
  const root = normalize(repoRoot).replace(/\/+$/, "");
  const base = ["app", "sync", name];
  if (sourceKind(app) === "local" && !opts.plain) {
    const local = normalize(join(root, app.spec!.source!.path!));
    if (local !== root && !local.startsWith(root + "/")) {
      throw new Error(
        `${name}: spec.source.path ${
          app.spec!.source!.path
        } resolves outside the repo root ${root}`,
      );
    }
    base.push("--local", local, "--local-repo-root", root);
  }
  base.push("--prune", "--async");
  return base;
}

/**
 * argocd arguments that render a git-path app from the working tree without
 * syncing (`argocd app manifests --local`), used to refuse empty renders.
 */
export function manifestsArgs(app: Application, repoRoot: string): string[] {
  const sync = syncArgs(app, repoRoot);
  const i = sync.indexOf("--local");
  if (i < 0) {
    throw new Error(`${app.metadata.name}: not a git-path app`);
  }
  return ["app", "manifests", app.metadata.name, ...sync.slice(i, i + 4)];
}

export type EmptyRenderDecision = "local" | "empty" | "new-empty" | "error";

/**
 * What to do with a git-path app given how many manifests the working tree
 * renders (localCount), when that is zero how many Git renders (gitCount;
 * null when the Git render could not be obtained), and whether the app's
 * source path exists at all on the Git target revision (pathInGit).
 *
 *   local > 0                     → "local": normal `argocd app sync --local`.
 *   local = 0, git = 0, in Git    → "empty": plain `argocd app sync` (no
 *                                   --local); an empty Application becomes
 *                                   Synced/Healthy. Many child charts render
 *                                   nothing in localdev by design.
 *   local = 0, git ≤ 0, not in Git → "new-empty": the chart is new on this
 *                                   branch and has nothing to deploy here. No
 *                                   sync at all: a plain sync generates from
 *                                   Git, where the path is absent, and fails
 *                                   with ComparisonError "app path does not
 *                                   exist" (git = 0 because `argocd app
 *                                   manifests` printed nothing for it).
 *   local = 0, git > 0            → "error": ArgoCD would silently apply the
 *                                   Git revision (the bootstrap-in-localdev
 *                                   case), wherever the path lives.
 *   local = 0, git = null, in Git → "error": fail closed rather than guess.
 */
export function emptyRenderDecision(
  localCount: number,
  gitCount: number | null,
  pathInGit = true,
): EmptyRenderDecision {
  if (localCount > 0) return "local";
  if (gitCount !== null && gitCount > 0) return "error";
  if (!pathInGit) return "new-empty";
  if (gitCount === 0) return "empty";
  return "error";
}

/**
 * ArgoCD's repo-server wording when an Application's source path is absent
 * from the target revision (ComparisonError "Manifest generation error:
 * charts/<x>: app path does not exist"). The fallback signal for
 * pathInGitRevision when git itself cannot answer.
 */
export const MISSING_PATH_SIGNAL = "app path does not exist";

export function mentionsMissingPath(text: string): boolean {
  return text.includes(MISSING_PATH_SIGNAL);
}

/**
 * The local git ref that stands for an Application's spec.source.targetRevision:
 * a SHA is used as is; a branch or tag name (or the empty/HEAD default, which
 * ArgoCD resolves against the remote) becomes `origin/<name>`, since the
 * clone's own `main` may be behind or absent in a worktree while
 * `origin/main` is what the root Application points at.
 */
export function gitRefForRevision(targetRevision: string | undefined): string {
  const rev = (targetRevision ?? "").trim();
  if (rev === "" || rev === "HEAD") return "origin/HEAD";
  if (/^[0-9a-f]{7,40}$/i.test(rev)) return rev;
  if (rev.startsWith("origin/")) return rev;
  return `origin/${rev}`;
}

/**
 * A new chart's Application after the loop skipped it: Healthy with no
 * operation and no resources, and a ComparisonError saying its path does not
 * exist on the target revision. `wait`, `diagnose` and `report` treat it as
 * complete; `verify --level 2` does the same (internal/verify/cluster.go).
 */
export function isNewEmptyApp(app: Application): boolean {
  const st = app.status;
  if (!st) return false;
  if (st.health?.status !== "Healthy") return false;
  if (st.operationState?.phase || st.operationState?.message) return false;
  if ((st.resources ?? []).length > 0) return false;
  return (st.conditions ?? []).some((c) =>
    c?.type === "ComparisonError" && mentionsMissingPath(c.message ?? "")
  );
}

/** Number of non-empty YAML documents in a multi-document stream. */
export function countManifests(yaml: string): number {
  return yaml
    .split(/^---\s*$/m)
    .filter((doc) =>
      doc.split("\n").some((l) => l.trim() && !l.trim().startsWith("#"))
    )
    .length;
}

/** Apply --warm / --only to the discovered app list. */
export function selectApps(
  apps: Application[],
  opts: { warm: boolean; only: string[] | null },
): Application[] {
  let out = apps;
  if (opts.warm) {
    out = out.filter((a) =>
      a.metadata.name !== WARM_EXCLUDED_ROOT &&
      parentOf(a) !== WARM_EXCLUDED_ROOT
    );
  }
  if (opts.only) {
    const wanted = new Set(opts.only);
    out = out.filter((a) => wanted.has(a.metadata.name));
  }
  return out;
}

/**
 * `wait` readiness: Healthy + Succeeded (+ Synced with --require-synced). A
 * new chart's Application (isNewEmptyApp) is ready too: nothing can be
 * synced to it until the chart exists on the target revision, so it never
 * gets an operation and can never be Synced.
 */
export function isReady(app: Application, requireSynced: boolean): boolean {
  if (isNewEmptyApp(app)) return true;
  const health = app.status?.health?.status;
  const phase = app.status?.operationState?.phase;
  if (health !== "Healthy" || phase !== "Succeeded") return false;
  if (requireSynced && app.status?.sync?.status !== "Synced") return false;
  return true;
}

/** Escape a helm --set key segment: every `.` becomes `\.`. */
export function escapeHelmKey(s: string): string {
  return s.replaceAll(".", "\\.");
}

/**
 * One `--set-file configs.cm.resource\.customizations\.health\.<group>_<kind>=<file>`
 * per Lua file, sorted by file name. The group's own dots are escaped too;
 * helm splits --set keys on unescaped dots, so `argoproj.io_Application`
 * would otherwise nest as `argoproj: {io_Application: ...}`.
 */
export function setFileArgs(luaFiles: string[]): string[] {
  const out: string[] = [];
  const sorted = [...luaFiles].sort((a, b) =>
    baseName(a).localeCompare(baseName(b))
  );
  for (const file of sorted) {
    const stem = baseName(file).replace(/\.lua$/, "");
    const key = `configs.cm.${
      escapeHelmKey(`resource.customizations.health.${stem}`)
    }`;
    out.push("--set-file", `${key}=${file}`);
  }
  return out;
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** "40m", "90s", "2h", "1500ms", bare number = seconds. */
export function parseDuration(s: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(s);
  if (!m) throw new Error(`invalid duration "${s}" (use e.g. 40m, 90s, 2h)`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const mult = unit === "ms"
    ? 1
    : unit === "s"
    ? 1000
    : unit === "m"
    ? 60_000
    : 3_600_000;
  return Math.round(n * mult);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** Fixed-width text table (no dependency, no colour). */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const line = (cells: string[]) =>
    "  " +
    cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [
    line(headers),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}

// ============================================================================
// report: pure functions (unit-tested)
// ============================================================================
export const REPORT_TITLE = "Kind preview (level 2)";
export const DEFAULT_MAX_DIFF_BYTES = 50_000;
/** Failing checks printed in full; the rest are counted. */
export const REPORT_MAX_FAILING_CHECKS = 25;
export const REPORT_MAX_FINDINGS = 15;
export const REPORT_MAX_FINDING_CHARS = 400;
export const REPORT_MAX_CELL_CHARS = 80;
/**
 * KUBECTL_EXTERNAL_DIFF for `argocd app diff`: unified format, which GitHub
 * renders as a coloured ```diff block (argocd's default is plain `diff`).
 */
export const DIFF_TOOL = "diff -u";

/** One check of `homelab verify all --json` (internal/verify/types.go). */
export interface VerifyCheck {
  name: string;
  status: string;
  duration_ms?: number;
  detail?: string;
  findings?: string[];
}

export interface VerifyResult {
  level?: number;
  checks: VerifyCheck[];
  pass?: boolean;
  duration_ms?: number;
}

export type VerifyInput =
  | { ok: true; result: VerifyResult }
  | { ok: false; reason: string };

/** `argocd app diff` of one Application, already inverted to main → PR. */
export interface AppDiff {
  app: string;
  diff: string;
  /** Set when argocd could not produce the diff (e.g. path absent on main). */
  error?: string;
  /** Set by truncateDiffs when the diff was cut. */
  originalBytes?: number;
  omittedLines?: number;
}

export interface StatusRow {
  app: string;
  health: string;
  operation: string;
  vsMain: string;
}

export interface ReportInput {
  /** null: `kubectl get applications` failed (no cluster / no ArgoCD). */
  apps: Application[] | null;
  appsError?: string;
  verify: VerifyInput;
  /** Already truncated (truncateDiffs). */
  diffs: AppDiff[];
  /** Why no diffs were taken (--no-diff, ArgoCD API not reachable). */
  diffNote?: string;
  meta?: { sha?: string; runUrl?: string };
}

const utf8 = new TextEncoder();

function byteLength(s: string): number {
  return utf8.encode(s).length;
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Text safe inside a Markdown table cell (no pipes, newlines or HTML). */
export function mdCell(s: string): string {
  return s
    .replace(/\r?\n/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .trim();
}

/** A code fence longer than any backtick run inside `content`. */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) {
    longest = Math.max(longest, m[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The JSON object in a captured `task verify` stdout: the whole text, or the
 * lines from the first `{` line to the last `}` line (task appends its own
 * failure line after the JSON; the tilt-ci.yml Summary step strips it the
 * same way with sed). null when there is no parsable object.
 */
export function extractJsonObject(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the line-based extraction
  }
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("{"));
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("}")) {
      end = i;
      break;
    }
  }
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(lines.slice(start, end + 1).join("\n"));
  } catch {
    return null;
  }
}

/**
 * Level-2 JSON as captured by tilt-ci.yml (`task verify LEVEL=2 | tee
 * verify-level2.json`). text null = the file does not exist. Never throws:
 * a missing or cut-short file becomes a reason the report prints.
 */
export function parseVerifyJson(
  text: string | null,
  source = "verify-level2.json",
): VerifyInput {
  if (text === null) {
    return {
      ok: false,
      reason:
        `\`${source}\` was not written: the Kind loop failed before \`task verify LEVEL=2\` ran (see the job log)`,
    };
  }
  if (!text.trim()) {
    return {
      ok: false,
      reason:
        `\`${source}\` is empty: \`task verify LEVEL=2\` produced no JSON (see the job log)`,
    };
  }
  const obj = extractJsonObject(text) as Partial<VerifyResult> | null;
  if (
    obj === null || typeof obj !== "object" || !Array.isArray(obj.checks)
  ) {
    return {
      ok: false,
      reason:
        `\`${source}\` is not a complete level-2 result (the verify step was probably cut short; see the job log)`,
    };
  }
  const checks = obj.checks.filter((c): c is VerifyCheck =>
    c !== null && typeof c === "object" && typeof c.name === "string"
  );
  return { ok: true, result: { ...obj, checks } as VerifyResult };
}

/** Applications in tree order (tier key from the root, then name). */
export function treeOrder(apps: Application[]): Application[] {
  const byName = indexApps(apps);
  return apps
    .map((a) => ({ a, key: tierKey(a, byName) }))
    .sort((x, y) =>
      compareTierKey(x.key, y.key) ||
      x.a.metadata.name.localeCompare(y.a.metadata.name)
    )
    .map(({ a }) => a);
}

/** Names of the Applications to diff: every one not Synced, in tree order. */
export function appsToDiff(apps: Application[]): string[] {
  // A new chart's Application has no target to diff against: its path is
  // absent from main, so `argocd app diff` could only report that error.
  return treeOrder(apps)
    .filter((a) => a.status?.sync?.status !== "Synced" && !isNewEmptyApp(a))
    .map((a) => a.metadata.name);
}

/** Resources, added and removed lines of an inverted `argocd app diff`. */
export function diffStats(
  diff: string,
): { resources: number; added: number; removed: number } {
  let resources = 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (/^===== .* =+$/.test(line)) resources++;
    else if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { resources, added, removed };
}

/**
 * One table row per Application, in tree order. vs main: Synced → "same as
 * main"; otherwise the sync status plus what the diff found, when one was
 * taken (`diffs` keyed by app name).
 */
export function statusRows(
  apps: Application[],
  diffs: Map<string, AppDiff> = new Map(),
): StatusRow[] {
  return treeOrder(apps).map((a) => {
    const st = a.status ?? {};
    const phase = st.operationState?.phase;
    const msg = firstLine(st.operationState?.message ?? "");
    let operation = phase ?? "-";
    if (phase && phase !== "Succeeded" && msg) {
      operation = clip(`${phase}: ${msg}`, REPORT_MAX_CELL_CHARS);
    }
    const sync = st.sync?.status;
    let vsMain: string;
    if (sync === "Synced") {
      vsMain = "same as main";
    } else if (isNewEmptyApp(a)) {
      operation = "- (new chart, nothing to sync)";
      vsMain = "not on main";
    } else {
      vsMain = sync === "OutOfSync" ? "differs" : (sync ?? "Unknown");
      const d = diffs.get(a.metadata.name);
      if (d?.error !== undefined) vsMain += " · diff unavailable";
      else if (d && !d.diff.trim()) vsMain += " · no resource diff";
      else if (d) {
        const s = diffStats(d.diff);
        vsMain += ` · +${s.added} -${s.removed}${
          d.originalBytes !== undefined ? " (truncated)" : ""
        }`;
      }
    }
    return {
      app: a.metadata.name,
      health: st.health?.status ?? "Unknown",
      operation,
      vsMain,
    };
  });
}

/**
 * Turn `argocd app diff` output (unified format, `diff <live> <target>`) into
 * main → PR: in the Kind loop the live objects are the PR (synced with
 * --local) and the target is GitHub main. Hunk headers swap their ranges,
 * `-`/`+` swap, and the `---`/`+++` file headers (temp paths with
 * timestamps) are dropped; argocd's `===== group/Kind ns/name ======` line
 * names the resource. Within each run of changed lines main's (`-`) lines
 * are emitted before the PR's (`+`), the order `diff -u` itself uses. Hunk
 * line counts are tracked, so content that happens to start with `--- ` is
 * never mistaken for a header.
 */
export function invertUnifiedDiff(text: string): string {
  const out: string[] = [];
  let minus: string[] = [];
  let plus: string[] = [];
  const flush = () => {
    out.push(...minus, ...plus);
    minus = [];
    plus = [];
  };
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of text.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === "-") {
        oldLeft--;
        plus.push(`+${line.slice(1)}`);
        continue;
      }
      if (c === "+") {
        newLeft--;
        minus.push(`-${line.slice(1)}`);
        continue;
      }
      flush();
      if (c === " " || line === "") {
        oldLeft--;
        newLeft--;
        out.push(line);
        continue;
      }
      if (c === "\\") {
        out.push(line);
        continue;
      }
      // Not hunk content after all: resynchronise on this line.
      oldLeft = 0;
      newLeft = 0;
    }
    flush();
    const h = /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@(.*)$/.exec(line);
    if (h) {
      oldLeft = h[2] === undefined ? 1 : Number(h[2].slice(1));
      newLeft = h[4] === undefined ? 1 : Number(h[4].slice(1));
      out.push(`@@ -${h[3]}${h[4] ?? ""} +${h[1]}${h[2] ?? ""} @@${h[5]}`);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("\\")) continue;
    out.push(line);
  }
  flush();
  return out.join("\n");
}

/** The readable message of an argocd CLI error (JSON log lines or text). */
export function argocdErrorMessage(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("{")) {
      try {
        const o = JSON.parse(line) as { msg?: unknown; level?: unknown };
        if (typeof o.msg === "string" && o.msg.trim()) {
          if (
            o.level === undefined || o.level === "fatal" || o.level === "error"
          ) {
            return o.msg.trim();
          }
          continue;
        }
      } catch {
        // not JSON: use the raw line
      }
    }
    return line;
  }
  return "";
}

/**
 * Result of `argocd app diff <app> --exit-code=false`: 0 = no error (diff
 * possibly empty); 1 = "diff found" (only without --exit-code=false, kept for
 * safety); anything else (argocd's generic 20, 127 = no CLI) is an error.
 */
export function classifyDiffResult(
  app: string,
  code: number,
  stdout: string,
  stderr: string,
): AppDiff {
  if (code === 0 || (code === 1 && stdout.trim())) {
    return { app, diff: invertUnifiedDiff(stdout).trim() };
  }
  return {
    app,
    diff: "",
    error: argocdErrorMessage(stderr) || argocdErrorMessage(stdout) ||
      `argocd app diff exited ${code}`,
  };
}

/** The longest prefix of whole lines of `text` that fits in `maxBytes`. */
function cutAtLine(
  text: string,
  maxBytes: number,
): { text: string; omittedLines: number } {
  const lines = text.split("\n");
  let used = 0;
  let kept = 0;
  for (const line of lines) {
    const cost = byteLength(line) + (kept > 0 ? 1 : 0);
    if (used + cost > maxBytes) break;
    used += cost;
    kept++;
  }
  return {
    text: lines.slice(0, kept).join("\n"),
    omittedLines: lines.length - kept,
  };
}

/**
 * Fit every diff into one shared byte budget (the sticky comment must stay
 * under GitHub's 65536-character limit). Water-filling: diffs are served
 * smallest first, each getting at most an equal share of what is left, so
 * small diffs stay whole and only the big ones are cut, at a line boundary.
 * Cut diffs carry originalBytes/omittedLines for the note. maxBytes <= 0
 * means unlimited. Order is preserved; the input is not mutated.
 */
export function truncateDiffs(diffs: AppDiff[], maxBytes: number): AppDiff[] {
  const sizes = diffs.map((d) => byteLength(d.diff));
  const total = sizes.reduce((a, b) => a + b, 0);
  if (maxBytes <= 0 || total <= maxBytes) return diffs.map((d) => ({ ...d }));
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  const budget = new Array<number>(diffs.length).fill(0);
  let remaining = maxBytes;
  let left = diffs.length;
  for (const i of order) {
    const share = Math.floor(remaining / left);
    budget[i] = Math.min(sizes[i], share);
    remaining -= budget[i];
    left--;
  }
  return diffs.map((d, i) => {
    if (budget[i] >= sizes[i]) return { ...d };
    const cut = cutAtLine(d.diff, budget[i]);
    return {
      ...d,
      diff: cut.text,
      originalBytes: sizes[i],
      omittedLines: cut.omittedLines,
    };
  });
}

function fenced(content: string, lang = ""): string {
  const f = fenceFor(content);
  return `${f}${lang}\n${content}\n${f}`;
}

function verifyLine(v: VerifyInput): string {
  if (!v.ok) return `**Level 2:** no result · ${v.reason}`;
  const r = v.result;
  const count = (s: string) => r.checks.filter((c) => c.status === s).length;
  const verdict = r.pass === true
    ? "PASS ✅"
    : r.pass === false
    ? "FAIL ❌"
    : "UNKNOWN";
  const level = r.level !== undefined && r.level !== 2
    ? ` (level ${r.level}, not 2)`
    : "";
  const took = typeof r.duration_ms === "number"
    ? ` · ${formatDuration(r.duration_ms)}`
    : "";
  return `**Level 2:** ${verdict}${level} · ${r.checks.length} checks: ${
    count("pass")
  } pass, ${count("fail")} fail, ${count("skip")} skip${took}`;
}

function failingChecksSection(v: VerifyInput): string[] {
  if (!v.ok) return [];
  const failing = v.result.checks.filter((c) => c.status === "fail");
  if (failing.length === 0) return [];
  const out = [`### Failing checks (${failing.length})`, ""];
  for (const c of failing.slice(0, REPORT_MAX_FAILING_CHECKS)) {
    const findings = c.findings ?? [];
    const body = [
      ...(c.detail ? [c.detail.trim()] : []),
      ...findings.slice(0, REPORT_MAX_FINDINGS).map((f) =>
        `- ${clip(f.trim(), REPORT_MAX_FINDING_CHARS)}`
      ),
      ...(findings.length > REPORT_MAX_FINDINGS
        ? [`… ${findings.length - REPORT_MAX_FINDINGS} more finding(s)`]
        : []),
    ].join("\n");
    out.push(`#### \`${c.name}\``, "");
    if (body) out.push(fenced(body, "text"), "");
  }
  if (failing.length > REPORT_MAX_FAILING_CHECKS) {
    out.push(
      `… ${
        failing.length - REPORT_MAX_FAILING_CHECKS
      } more failing check(s): see the \`verify-level2\` artifact.`,
      "",
    );
  }
  return out;
}

function diffSection(input: ReportInput): string[] {
  const out = ["### Diffs vs main", ""];
  if (input.diffNote) return [...out, input.diffNote, ""];
  if (input.diffs.length === 0) {
    return [
      ...out,
      "Every Application is Synced with `main`: nothing ArgoCD deploys in Kind changes.",
      "",
    ];
  }
  for (const d of input.diffs) {
    const name = mdCell(d.app);
    if (d.error !== undefined) {
      out.push(
        `<details><summary><code>${name}</code> · diff unavailable</summary>`,
        "",
        fenced(d.error, "text"),
        "",
        "Typical cause: the Application or its path does not exist on `main` yet (new in this PR).",
        "",
        "</details>",
        "",
      );
      continue;
    }
    if (!d.diff.trim() && d.originalBytes === undefined) {
      out.push(
        `<details><summary><code>${name}</code> · OutOfSync, no resource diff</summary>`,
        "",
        "`argocd app diff` shows nothing: only fields ArgoCD ignores differ, or only Secrets (never diffed).",
        "",
        "</details>",
        "",
      );
      continue;
    }
    const s = diffStats(d.diff);
    const cut = d.originalBytes !== undefined;
    out.push(
      `<details><summary><code>${name}</code> · ${s.resources} resource(s) · +${s.added} -${s.removed}${
        cut ? " · truncated" : ""
      }</summary>`,
      "",
      fenced(d.diff, "diff"),
      "",
    );
    if (cut) {
      out.push(
        `Truncated: showing ${
          byteLength(d.diff)
        } of ${d.originalBytes} bytes (${d.omittedLines} line(s) omitted). Full diff: \`task localdev:report -- --max-diff-bytes 0\` against a local Kind loop, or \`argocd app diff ${d.app}\`.`,
        "",
      );
    }
    out.push("</details>", "");
  }
  return out;
}

/** The Markdown report (sticky PR comment `kind-preview` + job summary). */
export function renderReport(input: ReportInput): string {
  const out: string[] = [`## ${REPORT_TITLE}`, "", verifyLine(input.verify)];
  const meta: string[] = [];
  if (input.meta?.sha) meta.push(`Commit \`${input.meta.sha.slice(0, 12)}\``);
  if (input.meta?.runUrl) meta.push(`[workflow run](${input.meta.runUrl})`);
  if (meta.length > 0) out.push("", meta.join(" · "));
  out.push("");

  if (input.apps === null) {
    out.push(
      `> **ArgoCD was not reachable** (${
        mdCell(input.appsError ?? "unknown error")
      }). \`task localdev:ci\` failed before ArgoCD was up, so there is no Application table and no diff; see the job log.`,
      "",
    );
    out.push(...failingChecksSection(input.verify));
    return out.join("\n").trimEnd() + "\n";
  }

  out.push(
    "Every Application was synced from this PR's working tree (`argocd app sync --local`) while the root Application `gitops` tracks GitHub `main`, so **vs main** is this PR against `main` as ArgoCD sees it: in the diffs `-` is `main` and `+` is this PR. Child Applications are compared using their live (PR) spec, so a change to a child's chart version or values shows up on its parent's diff (the `Application` resource), not on the child.",
    "",
  );

  if (input.apps.length === 0) {
    out.push(
      "No Applications in namespace `argocd`: the root Application was never applied (see the job log).",
      "",
    );
  } else {
    const byApp = new Map(input.diffs.map((d) => [d.app, d]));
    const rows = statusRows(input.apps, byApp);
    const healthy = rows.filter((r) => r.health === "Healthy").length;
    const differ = input.apps.filter((a) =>
      a.status?.sync?.status !== "Synced"
    ).length;
    out.push(
      `${rows.length} Applications · ${healthy} Healthy · ${
        rows.length - healthy
      } not Healthy · ${differ} not Synced with main`,
      "",
      "| Application | Health | Last operation | vs main |",
      "|---|---|---|---|",
      ...rows.map((r) =>
        `| ${mdCell(r.app)} | ${mdCell(r.health)} | ${mdCell(r.operation)} | ${
          mdCell(r.vsMain)
        } |`
      ),
      "",
    );
  }

  out.push(...failingChecksSection(input.verify));
  if (input.apps.length > 0) out.push(...diffSection(input));
  out.push(
    "<sub>Generated by <code>task localdev:report</code> on the Kind loop. Kubernetes Secrets are never diffed.</sub>",
  );
  return out.join("\n").trimEnd() + "\n";
}

// ============================================================================
// CLI args
// ============================================================================
export type Command = "install" | "sync" | "wait" | "diagnose" | "report";

const COMMANDS: readonly Command[] = [
  "install",
  "sync",
  "wait",
  "diagnose",
  "report",
];

export interface Args {
  command: Command | null;
  help: boolean;
  dryRun: boolean;
  warm: boolean;
  only: string[] | null;
  exclude: string[];
  requireSynced: boolean;
  timeoutMs: number | null;
  repoRoot: string | null;
  /** --server host:port: use this ArgoCD API directly, no port-forward. */
  server: string | null;
  /** --local-port: preferred local port for the port-forward. */
  localPort: number | null;
  /** report --out: Markdown file (null = stdout). */
  out: string | null;
  /** report --verify-json: level-2 JSON captured from `task verify LEVEL=2`. */
  verifyJson: string | null;
  /** report --max-diff-bytes: shared diff budget (0 = unlimited). */
  maxDiffBytes: number;
  /** report --no-diff: table and checks only, no `argocd app diff`. */
  noDiff: boolean;
}

export function parsePort(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid port "${s}" (1-65535)`);
  }
  return n;
}

export function parseByteCount(s: string): number {
  const n = Number(s);
  if (!/^\d+$/.test(s.trim()) || !Number.isSafeInteger(n)) {
    throw new Error(`invalid byte count "${s}" (a non-negative integer)`);
  }
  return n;
}

function splitList(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: null,
    help: false,
    dryRun: false,
    warm: false,
    only: null,
    exclude: [],
    requireSynced: false,
    timeoutMs: null,
    repoRoot: null,
    server: null,
    localPort: null,
    out: null,
    verifyJson: null,
    maxDiffBytes: DEFAULT_MAX_DIFF_BYTES,
    noDiff: false,
  };
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--warm") args.warm = true;
    else if (a === "--require-synced") args.requireSynced = true;
    else if (a === "--only") args.only = splitList(valueOf(i++, a));
    else if (a.startsWith("--only=")) {
      args.only = splitList(a.slice("--only=".length));
    } else if (a === "--exclude") args.exclude = splitList(valueOf(i++, a));
    else if (a.startsWith("--exclude=")) {
      args.exclude = splitList(a.slice("--exclude=".length));
    } else if (a === "--timeout") {
      args.timeoutMs = parseDuration(valueOf(i++, a));
    } else if (a.startsWith("--timeout=")) {
      args.timeoutMs = parseDuration(a.slice("--timeout=".length));
    } else if (a === "--repo-root") args.repoRoot = valueOf(i++, a);
    else if (a.startsWith("--repo-root=")) {
      args.repoRoot = a.slice("--repo-root=".length);
    } else if (a === "--server") args.server = valueOf(i++, a);
    else if (a.startsWith("--server=")) {
      args.server = a.slice("--server=".length);
    } else if (a === "--local-port") {
      args.localPort = parsePort(valueOf(i++, a));
    } else if (a.startsWith("--local-port=")) {
      args.localPort = parsePort(a.slice("--local-port=".length));
    } else if (a === "--out") args.out = valueOf(i++, a);
    else if (a.startsWith("--out=")) args.out = a.slice("--out=".length);
    else if (a === "--verify-json") args.verifyJson = valueOf(i++, a);
    else if (a.startsWith("--verify-json=")) {
      args.verifyJson = a.slice("--verify-json=".length);
    } else if (a === "--max-diff-bytes") {
      args.maxDiffBytes = parseByteCount(valueOf(i++, a));
    } else if (a.startsWith("--max-diff-bytes=")) {
      args.maxDiffBytes = parseByteCount(a.slice("--max-diff-bytes=".length));
    } else if (a === "--no-diff") args.noDiff = true;
    else if (a.startsWith("-")) {
      throw new Error(`Unknown argument: ${a}`);
    } else if (args.command === null) {
      if ((COMMANDS as readonly string[]).includes(a)) {
        args.command = a as Command;
      } else {
        throw new Error(
          `Unknown command: ${a} (expected install, sync, wait, diagnose or report)`,
        );
      }
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    `localdev-argocd.ts — ArgoCD install + sync orchestrator for the Kind localdev loop

Usage:
  deno run --allow-net --allow-run --allow-env --allow-read --allow-write \\
    scripts/localdev-argocd.ts <command> [flags]

Commands:
  install    helm upgrade --install argo-cd (version: ${VERSIONS_YAML} charts.argocd,
             values: ${ARGOCD_VALUES}, health Lua: ${HEALTH_LUA_DIR}/*.lua),
             apply ${ROOT_APP_MANIFEST}, log the argocd CLI in.
             Idempotent.                                        (task localdev:argocd)
  sync       Sync every Application from the working tree, tier by tier
             (argocd app sync --local for git-path apps, plain sync for chart apps).
                                                                  (task localdev:sync)
  wait       Block until every Application is Healthy with a Succeeded operation.
                                                                  (task localdev:wait)
  diagnose   Print conditions, unhealthy resources, events and failing pod logs for
             every Application that is not Healthy/Succeeded.  (task localdev:diagnose)
  report     Markdown "${REPORT_TITLE}": level-2 pass/fail and failing checks
             (--verify-json), Application table (health, last operation, vs main)
             and \`argocd app diff <app> --exit-code=false\` of every Application
             that is not Synced. The root app tracks GitHub main and everything
             was synced with --local, so the diff is PR head vs main (\`-\` main,
             \`+\` PR). Exits 0 whenever a report was written, also when ArgoCD
             is unreachable (the report says so).            (task localdev:report)

Flags:
  --help, -h            Show this help and exit 0
  --dry-run             install/sync: print the exact commands and exit 0 without
                        touching the cluster (sync lists Applications when a cluster
                        is reachable, otherwise plans the root app only)
  --timeout <dur>       sync: default 40m; wait: default 20m (e.g. 90s, 15m, 1h)
  --warm                sync: stop once everything under ${ROOT_APP}/bootstrap/addons is
                        done; never sync '${WARM_EXCLUDED_ROOT}' or its children
  --only <a,b>          sync: only these Applications (still in tier order)
  --repo-root <dir>     sync: working tree to sync from (default: git toplevel of cwd)
  --require-synced      wait: also require status.sync.status == Synced (off by
                        default: --local syncs are OutOfSync against GitHub by design)
  --exclude <a,b>       wait: ignore these Applications
  --local-port <n>      install/sync: preferred local port for the kubectl
                        port-forward (default ${DEFAULT_LOCAL_PORT}; the next free port is
                        used if it is taken)
  --server <host:port>  install/sync/report: talk to this ArgoCD API directly and
                        skip the port-forward
  --out <file>          report: write the Markdown here (default: stdout; logs
                        always go to stderr)
  --verify-json <file>  report: level-2 JSON (\`task verify LEVEL=2 | tee <file>\`); a
                        trailing task error line is tolerated, a missing or cut
                        file is reported
  --max-diff-bytes <n>  report: byte budget shared by all diffs (default
                        ${DEFAULT_MAX_DIFF_BYTES}; 0 = unlimited). Small diffs stay whole, big
                        ones are cut at a line boundary with a note
  --no-diff             report: skip \`argocd app diff\` (no port-forward)

Connection:
  kubectl --context ${KUBE_CONTEXT}. install, sync and report spawn
  \`kubectl port-forward -n ${ARGOCD_NAMESPACE} ${ARGOCD_SERVICE} <local-port>:${ARGOCD_SERVICE_PORT} --address 127.0.0.1\`,
  wait for http://127.0.0.1:<local-port>/healthz, run every argocd command with
  --server 127.0.0.1:<local-port> --plaintext --insecure --grpc-web, and kill
  the port-forward on exit (also on error, SIGINT and SIGTERM). The Kind
  host-port mapping (NodePort 30080 -> localhost:8080) is not used: Docker
  Desktop's proxy corrupts TCP checksums and Cilium drops those packets. Every
  command logs in with the argocd-initial-admin-secret first, so the CLI
  context can never point at another cluster.

Exit codes:
  0  Success (report: a report was written, even one that says ArgoCD was
     unreachable or the level-2 JSON is missing)
  1  Install failed, a sync tier failed or timed out, wait timed out (diagnose
     output is printed first), the cluster is unreachable, or report could not
     write --out
  2  Argument error
`,
  );
}

// ============================================================================
// Shell helpers
// ============================================================================
interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(
  cmd: string[],
  opts: { cwd?: string; quiet?: boolean; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  });
  try {
    const out = await p.output();
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      code: out.code,
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { stdout: "", stderr: `${cmd[0]}: command not found`, code: 127 };
    }
    throw err;
  }
}

/** Run with inherited stdio (streams helm/argocd output to the terminal). */
async function runInherit(cmd: string[], cwd?: string): Promise<number> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const out = await p.output();
  return out.code;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s)
    ? s
    : `'${s.replaceAll("'", "'\\''")}'`;
}

function fmtCmd(cmd: string[]): string {
  return cmd.map(shellQuote).join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function findRepoRoot(): Promise<string> {
  const r = await run(["git", "rev-parse", "--show-toplevel"]);
  if (r.code !== 0) {
    throw new Error(`git rev-parse --show-toplevel failed:\n${r.stderr}`);
  }
  return r.stdout.trim();
}

/**
 * Whether `path` exists in the tree of `ref` (`git cat-file -e <ref>:<path>`
 * in the local clone): true/false when git answers, null when it cannot
 * (unknown ref, e.g. `origin/main` never fetched, or git missing). A path
 * that is on disk but not in the ref is exactly the "new chart" case; git
 * says "exists on disk, but not in '<ref>'" for it.
 */
async function pathInGitRevision(
  repoRoot: string,
  ref: string,
  path: string,
): Promise<boolean | null> {
  const clean = normalize(path).replace(/^\.\//, "").replace(/\/+$/, "");
  if (clean === "" || clean === ".") return null;
  const r = await run(["git", "cat-file", "-e", `${ref}:${clean}`], {
    cwd: repoRoot,
  });
  if (r.code === 0) return true;
  if (/does not exist in|exists on disk, but not in/.test(r.stderr)) {
    return false;
  }
  return null;
}

function kubectl(...args: string[]): string[] {
  return ["kubectl", "--context", KUBE_CONTEXT, ...args];
}

/** ArgoCD API address every argocd command targets; set by withArgocdServer. */
let argocdServer = `127.0.0.1:${DEFAULT_LOCAL_PORT}`;

function argocd(...args: string[]): string[] {
  return ["argocd", ...args, ...serverFlags(argocdServer)];
}

// ============================================================================
// Port-forward supervisor
// ============================================================================
class PortForward {
  #child: Deno.ChildProcess | null = null;
  #exited: Promise<Deno.CommandStatus> | null = null;
  #stderr = "";
  #stopped = false;
  readonly port: number;

  constructor(port: number) {
    this.port = port;
  }

  get server(): string {
    return `127.0.0.1:${this.port}`;
  }

  /** Spawn kubectl port-forward and wait until /healthz answers. */
  async start(): Promise<void> {
    const cmd = portForwardCmd(this.port);
    log.info(fmtCmd(cmd));
    const child = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).spawn();
    this.#child = child;
    this.#stderr = "";
    // Drain stderr so kubectl never blocks; keep the tail for error reports.
    (async () => {
      try {
        for await (const chunk of child.stderr) {
          this.#stderr = (this.#stderr + new TextDecoder().decode(chunk))
            .slice(-2000);
        }
      } catch {
        // stream closed with the process
      }
    })();
    this.#exited = child.status;
    let exited = false;
    this.#exited.then(() => {
      exited = true;
    });
    const deadline = Date.now() + PORT_FORWARD_READY_MS;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `kubectl port-forward exited before ${this.server} was ready: ${
            this.#stderr.trim() || "(no stderr)"
          }`,
        );
      }
      if (await this.healthy()) {
        log.ok(`ArgoCD API reachable at http://${this.server} (port-forward)`);
        return;
      }
      await sleep(PORT_FORWARD_PROBE_MS);
    }
    await this.stop();
    throw new Error(
      `port-forward to ${this.server} not ready within ${
        formatDuration(PORT_FORWARD_READY_MS)
      }: ${this.#stderr.trim()}`,
    );
  }

  async healthy(): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2000);
      const r = await fetch(`http://${this.server}/healthz`, {
        signal: ctl.signal,
      });
      clearTimeout(t);
      await r.body?.cancel();
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Respawn if kubectl died (pod restart, lost connection) since last use. */
  async ensure(): Promise<void> {
    if (this.#stopped || !this.#child) return;
    const alive = await Promise.race([
      this.#exited!.then(() => false),
      sleep(0).then(() => true),
    ]);
    if (alive) return;
    log.warn(
      `port-forward to ${this.server} died (${
        this.#stderr.trim().split("\n").pop() ?? ""
      }); restarting`,
    );
    await this.start();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    try {
      await Promise.race([this.#exited, sleep(2000)]);
    } catch {
      // exit status of a killed process is not interesting
    }
  }
}

let activePortForward: PortForward | null = null;

function stopPortForwardSync(): void {
  // Signal handlers cannot await; a SIGTERM to the child is enough.
  const pf = activePortForward;
  activePortForward = null;
  if (pf) pf.stop();
}

/**
 * Run `fn` with the argocd CLI pointed at a working ArgoCD API: --server as
 * given, or a supervised kubectl port-forward that is torn down afterwards
 * whatever happens (return, throw, SIGINT, SIGTERM).
 */
async function withArgocdServer<T>(
  args: Args,
  fn: () => Promise<T>,
): Promise<T> {
  if (args.server) {
    argocdServer = args.server;
    log.info(`using ArgoCD API at ${argocdServer} (--server; no port-forward)`);
    return await fn();
  }
  const port = findFreePort(
    candidatePorts(args.localPort ?? DEFAULT_LOCAL_PORT),
  );
  if (args.localPort !== null && port !== args.localPort) {
    log.warn(`--local-port ${args.localPort} is in use; using ${port}`);
  }
  const pf = new PortForward(port);
  activePortForward = pf;
  const onSignal = () => {
    stopPortForwardSync();
    Deno.exit(130);
  };
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);
  try {
    await pf.start();
    argocdServer = pf.server;
    return await fn();
  } finally {
    Deno.removeSignalListener("SIGINT", onSignal);
    Deno.removeSignalListener("SIGTERM", onSignal);
    activePortForward = null;
    await pf.stop();
  }
}

/** Before each argocd call: restart the port-forward if it died. */
async function ensureArgocdReachable(): Promise<void> {
  if (activePortForward) await activePortForward.ensure();
}

// ============================================================================
// Cluster access
// ============================================================================
async function listApplications(): Promise<Application[]> {
  const r = await run(
    kubectl(
      "get",
      "applications.argoproj.io",
      "-n",
      ARGOCD_NAMESPACE,
      "-o",
      "json",
    ),
  );
  if (r.code !== 0) {
    throw new Error(
      `kubectl get applications failed: ${
        r.stderr.trim().split("\n").filter((l) => l.trim())[0] ??
          `exit ${r.code}`
      }`,
    );
  }
  const parsed = JSON.parse(r.stdout) as { items?: Application[] };
  return (parsed.items ?? []).filter((a) => a?.metadata?.name);
}

async function getApplication(name: string): Promise<Application | null> {
  const r = await run(
    kubectl(
      "get",
      "applications.argoproj.io",
      name,
      "-n",
      ARGOCD_NAMESPACE,
      "-o",
      "json",
    ),
  );
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as Application;
  } catch {
    return null;
  }
}

async function readAdminPassword(): Promise<string | null> {
  const r = await run(
    kubectl(
      "get",
      "secret",
      "argocd-initial-admin-secret",
      "-n",
      ARGOCD_NAMESPACE,
      "-o",
      "jsonpath={.data.password}",
    ),
  );
  if (r.code !== 0 || !r.stdout.trim()) return null;
  return new TextDecoder().decode(
    Uint8Array.from(atob(r.stdout.trim()), (c) => c.charCodeAt(0)),
  );
}

function loginCmd(password: string): string[] {
  return [
    "argocd",
    "login",
    argocdServer,
    "--plaintext",
    "--insecure",
    "--grpc-web",
    // `argocd login` probes the server with a TLS ClientHello even with
    // --plaintext; argocd-server resets that connection and kubectl
    // port-forward treats the reset as fatal ("lost connection to pod").
    "--skip-test-tls",
    "--username",
    "admin",
    "--password",
    password,
  ];
}

/** Log the CLI in, retrying while the server comes up (up to 2 minutes). */
async function login(dryRun: boolean): Promise<void> {
  if (dryRun) {
    log.dry(fmtCmd(loginCmd("<argocd-initial-admin-secret .data.password>")));
    return;
  }
  const deadline = Date.now() + LOGIN_RETRY_MS;
  let lastErr = "";
  for (;;) {
    const password = await readAdminPassword();
    if (password === null) {
      lastErr = "argocd-initial-admin-secret not readable yet";
    } else {
      await ensureArgocdReachable();
      const r = await run(loginCmd(password));
      if (r.code === 0) {
        log.ok(`argocd CLI logged in at ${argocdServer} as admin`);
        return;
      }
      lastErr = (r.stderr || r.stdout).trim().split("\n").pop() ?? "";
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `argocd login at ${argocdServer} did not succeed within ${
          formatDuration(LOGIN_RETRY_MS)
        }: ${lastErr}`,
      );
    }
    log.info(`waiting for ArgoCD server (${lastErr}); retrying in 5 s`);
    await sleep(LOGIN_RETRY_INTERVAL_MS);
  }
}

// ============================================================================
// install
// ============================================================================
async function readArgocdChartVersion(repoRoot: string): Promise<string> {
  const text = await Deno.readTextFile(join(repoRoot, VERSIONS_YAML));
  const doc = parseYaml(text) as { charts?: Record<string, unknown> };
  const v = doc?.charts?.["argocd"];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${VERSIONS_YAML}: charts.argocd is not set`);
  }
  return v.trim();
}

async function listHealthLua(repoRoot: string): Promise<string[]> {
  const files: string[] = [];
  const dir = join(repoRoot, HEALTH_LUA_DIR);
  try {
    if (!(await Deno.stat(dir)).isDirectory) return files;
  } catch {
    return files;
  }
  for await (const e of expandGlob("*.lua", { root: dir })) {
    if (e.isFile) files.push(`${HEALTH_LUA_DIR}/${e.name}`);
  }
  return files.sort();
}

async function helmInstallCmd(repoRoot: string): Promise<string[]> {
  const version = await readArgocdChartVersion(repoRoot);
  const lua = await listHealthLua(repoRoot);
  if (lua.length === 0) {
    log.warn(
      `${HEALTH_LUA_DIR} has no .lua files; custom resource health will be missing`,
    );
  } else {
    log.info(`health Lua: ${lua.map(baseName).join(", ")}`);
  }
  return [
    "helm",
    "--kube-context",
    KUBE_CONTEXT,
    "upgrade",
    "--install",
    ARGOCD_RELEASE,
    ARGOCD_CHART,
    "--repo",
    ARGOCD_HELM_REPO,
    "--version",
    version,
    "--namespace",
    ARGOCD_NAMESPACE,
    "--create-namespace",
    "-f",
    ARGOCD_VALUES,
    ...setFileArgs(lua),
    "--wait",
    "--timeout",
    HELM_WAIT_TIMEOUT,
  ];
}

function applyRootAppCmd(): string[] {
  return kubectl(
    "apply",
    "--server-side",
    "--force-conflicts",
    "-f",
    ROOT_APP_MANIFEST,
  );
}

async function cmdInstall(args: Args, repoRoot: string): Promise<number> {
  const helm = await helmInstallCmd(repoRoot);
  const apply = applyRootAppCmd();
  if (args.dryRun) {
    log.dry(`(cwd ${repoRoot})`);
    log.dry(fmtCmd(helm));
    log.dry(fmtCmd(apply));
    dryRunConnection(args);
    await login(true);
    return 0;
  }
  log.info(`installing ArgoCD chart ${helm[helm.indexOf("--version") + 1]}`);
  const code = await runInherit(helm, repoRoot);
  if (code !== 0) {
    log.error(`helm upgrade --install exited ${code}`);
    return 1;
  }
  log.ok("ArgoCD installed");
  log.info(`applying root Application from ${ROOT_APP_MANIFEST}`);
  const r = await run(apply, { cwd: repoRoot });
  if (r.code !== 0) {
    log.error(`kubectl apply failed:\n${r.stderr.trim()}`);
    return 1;
  }
  log.ok(r.stdout.trim());
  await withArgocdServer(args, () => login(false));
  return 0;
}

/** Dry-run: show how the API would be reached and pin the printed server. */
function dryRunConnection(args: Args): void {
  if (args.server) {
    argocdServer = args.server;
    log.dry(`(ArgoCD API at ${argocdServer} via --server; no port-forward)`);
    return;
  }
  const port = args.localPort ?? DEFAULT_LOCAL_PORT;
  argocdServer = `127.0.0.1:${port}`;
  log.dry(
    `${
      fmtCmd(portForwardCmd(port))
    }  # background; next free port if ${port} is taken`,
  );
  log.dry(`wait for http://${argocdServer}/healthz`);
}

// ============================================================================
// sync
// ============================================================================
interface TierRow {
  app: string;
  kind: SourceKind;
  result: string;
  startedAt: number;
  finishedAt?: number;
}

async function syncOne(
  app: Application,
  repoRoot: string,
  dryRun: boolean,
  opts: { terminateRunning?: boolean } = {},
): Promise<{ ok: boolean; detail: string; skipped?: string }> {
  const name = app.metadata.name;
  if (isAutomated(app)) {
    // Not from the working tree: ArgoCD syncs it from its repo on its own.
    // Expected only when ARGOCD_AUTOMATED_SYNC=false did not reach this app.
    const msg =
      `${name}: automated sync policy; ArgoCD syncs it from its own repo (argocd app sync --local would be refused). Set ARGOCD_AUTOMATED_SYNC=false for localdev to sync it from the working tree.`;
    if (dryRun) log.dry(`skip ${msg}`);
    else log.warn(msg);
    return { ok: true, detail: "", skipped: "automated" };
  }
  let cmd = argocd(...syncArgs(app, repoRoot));
  if (dryRun) {
    if (sourceKind(app) === "local") {
      log.dry(
        `${
          fmtCmd(argocd(...manifestsArgs(app, repoRoot)))
        }  # if this renders nothing and \`argocd app manifests ${name}\` (Git) renders nothing too: ${
          fmtCmd(argocd(...syncArgs(app, repoRoot, { plain: true })))
        }; nothing locally and the path absent from ${
          gitRefForRevision(app.spec?.source?.targetRevision)
        }: no sync (new chart); nothing locally but something in Git: error`,
      );
    }
    log.dry(fmtCmd(cmd));
    return { ok: true, detail: "dry-run" };
  }
  await ensureArgocdReachable();
  let skipped: string | undefined;
  if (sourceKind(app) === "local") {
    // ArgoCD treats a local sync with zero manifests as "no local manifests"
    // and silently syncs spec.source.targetRevision from Git instead — the
    // one thing this loop must never do. Render first and decide.
    const m = await run(argocd(...manifestsArgs(app, repoRoot)), {
      cwd: repoRoot,
    });
    if (m.code !== 0) {
      return {
        ok: false,
        detail: `local render failed:\n${(m.stderr || m.stdout).trim()}`,
      };
    }
    const localCount = countManifests(m.stdout);
    let gitCount: number | null = null;
    let pathInGit = true;
    const rev = app.spec?.source?.targetRevision;
    if (localCount === 0) {
      // Many child charts legitimately render nothing in localdev. Whether
      // this one does depends on what Git would render instead.
      const g = await run(argocd("app", "manifests", name), { cwd: repoRoot });
      gitCount = g.code === 0 ? countManifests(g.stdout) : null;
      if (g.code !== 0) {
        log.warn(
          `${name}: Git render failed: ${(g.stderr || g.stdout).trim()}`,
        );
      }
      // A chart that is new on this branch does not exist on the target
      // revision at all: `argocd app manifests` prints nothing for it (exit
      // 0), and any sync without --local would fail with "app path does
      // not exist". Ask git; fall back to that wording from the Git render.
      const ref = gitRefForRevision(rev);
      const inGit = await pathInGitRevision(
        repoRoot,
        ref,
        app.spec?.source?.path ?? "",
      );
      pathInGit = inGit ?? !mentionsMissingPath(g.stderr + g.stdout);
      if (inGit === null) {
        log.warn(
          `${name}: could not check ${ref}:${app.spec?.source?.path} with git (is origin fetched?); relying on ArgoCD's Git render`,
        );
      }
    }
    const decision = emptyRenderDecision(localCount, gitCount, pathInGit);
    if (decision === "new-empty") {
      // Nothing to deploy from the working tree and no chart on the target
      // revision to fall back to: every sync would fail. Leave the
      // Application alone; ArgoCD keeps it Healthy with a ComparisonError,
      // which wait/report/verify recognise (isNewEmptyApp).
      log.info(
        `sync ${name} (new chart with nothing to deploy in localdev; skipped until it exists on ${
          rev ?? "the target revision"
        })`,
      );
      return { ok: true, detail: "", skipped: "new-empty" };
    }
    if (decision === "error") {
      return {
        ok: false,
        detail:
          `${name} renders no manifests from ${repoRoot}/${app.spec?.source?.path} but ${
            gitCount === null ? "an unknown number" : gitCount
          } from ${
            app.spec?.source?.targetRevision ?? "the Git revision"
          }; ArgoCD would silently sync the Git revision instead. Disable this Application in its parent's localdev values (it has nothing to deploy here) or give it something to render.`,
      };
    }
    if (decision === "empty") {
      // Nothing to deploy from either side: a plain sync (no --local) makes
      // the empty Application Synced/Healthy without touching the cluster.
      cmd = argocd(...syncArgs(app, repoRoot, { plain: true }));
      skipped = "empty";
      log.info(
        `sync ${name} (empty: no manifests locally or in Git; plain sync)`,
      );
    } else {
      log.info(
        `sync ${name} (local, ${localCount} manifest${
          localCount === 1 ? "" : "s"
        })`,
      );
    }
  } else {
    log.info(`sync ${name} (${sourceKind(app)})`);
  }
  let r = await run(cmd, { cwd: repoRoot });
  if (r.code !== 0 && isOperationInProgress((r.stderr || r.stdout).trim())) {
    if (!opts.terminateRunning) {
      // Re-syncs and the final pass never cut a running operation short
      // (it may be executing PostSync hooks): wait for it instead.
      log.warn(`${name}: an operation is already running; waiting for it`);
      return { ok: true, detail: "", skipped: "in-progress" };
    }
    // First sync of this run: a previous run left an operation running
    // (typically a parent waiting on children the working tree no longer
    // renders). Re-runs exist to push the current tree, so end that
    // operation and sync once more.
    log.warn(
      `${name}: an operation is already running from a previous run; terminating it and re-syncing`,
    );
    await terminateOperation(name);
    r = await run(cmd, { cwd: repoRoot });
    if (r.code !== 0 && isOperationInProgress((r.stderr || r.stdout).trim())) {
      log.warn(`${name}: still running an operation; waiting for it`);
      return { ok: true, detail: "", skipped: "in-progress" };
    }
  }
  if (r.code !== 0) {
    return { ok: false, detail: (r.stderr || r.stdout).trim() };
  }
  return { ok: true, detail: "", skipped };
}

/** argocd app terminate-op, then wait (≤ 60 s) for the phase to leave Running. */
async function terminateOperation(name: string): Promise<void> {
  const t = await run(argocd("app", "terminate-op", name));
  if (t.code !== 0) {
    log.warn(`${name}: terminate-op: ${(t.stderr || t.stdout).trim()}`);
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const app = await getApplication(name);
    const phase = app?.status?.operationState?.phase;
    if (phase !== "Running" && phase !== "Terminating") return;
    await sleep(2000);
  }
  log.warn(`${name}: operation still running 60 s after terminate-op`);
}

function printTier(key: TierKey, rows: TierRow[]): void {
  console.log(`\nTier ${formatTierKey(key)}:`);
  console.log(
    formatTable(
      ["APP", "KIND", "RESULT", "DURATION"],
      rows.map((r) => [
        r.app,
        r.kind,
        r.result,
        formatDuration((r.finishedAt ?? Date.now()) - r.startedAt),
      ]),
    ),
  );
  console.log("");
}

function summarise(apps: Application[]): string {
  return apps
    .map((a) =>
      `${a.metadata.name}=${a.status?.health?.status ?? "?"}/${
        a.status?.operationState?.phase ?? "-"
      }`
    )
    .join(" ");
}

/**
 * Root-only synthetic app for `sync --dry-run` without a reachable cluster:
 * mirrors localdev/argocd/gitops-app.yaml so the printed command is exact.
 */
function syntheticRootApp(): Application {
  return {
    metadata: {
      name: ROOT_APP,
      namespace: ARGOCD_NAMESPACE,
      annotations: { [SYNC_WAVE_ANNOTATION]: "0" },
    },
    spec: { source: { path: "charts/gitops" } },
  };
}

async function cmdSyncDryRun(args: Args, repoRoot: string): Promise<number> {
  const opts = { warm: args.warm, only: args.only };
  log.dry(`(cwd ${repoRoot})`);
  dryRunConnection(args);
  await login(true);
  let apps: Application[];
  let live = true;
  try {
    apps = await listApplications();
  } catch (err) {
    live = false;
    log.warn(
      `cluster not reachable (${
        (err instanceof Error ? err.message : String(err)).split("\n")[0]
      }); planning the root app only`,
    );
    apps = [syntheticRootApp()];
  }
  const selected = selectApps(apps, opts);
  const done = new Set<string>();
  for (;;) {
    const tier = nextTier(selected, done);
    if (!tier) break;
    console.log(`\nTier ${formatTierKey(tier.key)}:`);
    for (const app of tier.apps) {
      await syncOne(app, repoRoot, true);
      done.add(app.metadata.name);
    }
  }
  console.log("");
  if (!live) {
    log.info(
      "with a cluster, every child Application the root sync creates is discovered on the next poll and synced in its own tier: git-path apps as `argocd app sync <app> --local <repo>/<spec.source.path> --local-repo-root <repo> --prune --async`, chart apps as `argocd app sync <app> --prune --async`",
    );
  }
  log.dry(
    `then poll every ${
      formatDuration(POLL_INTERVAL_MS)
    } until each tier is complete (timeout ${
      formatDuration(args.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS)
    }); Failed/Error operations retry ${SYNC_RETRIES}x with ${
      formatDuration(SYNC_RETRY_BACKOFF_MS)
    } backoff`,
  );
  return 0;
}

async function cmdSync(args: Args, repoRoot: string): Promise<number> {
  if (args.dryRun) return cmdSyncDryRun(args, repoRoot);
  return await withArgocdServer(args, () => syncLoop(args, repoRoot));
}

async function syncLoop(args: Args, repoRoot: string): Promise<number> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const opts = { warm: args.warm, only: args.only };
  const start = Date.now();
  const deadline = start + timeoutMs;
  const done = new Set<string>();
  const retries = new Map<string, number>();
  /** Rows being waited on, by app name. */
  const active = new Map<string, TierRow>();
  /** Every row, grouped by tier key, for the per-tier tables. */
  const tables = new Map<string, { key: TierKey; rows: TierRow[] }>();
  const printed = new Set<string>();
  let tiersRun = 0;

  const fail = async (msg: string): Promise<number> => {
    flushTables(tables, printed, true);
    log.error(msg);
    await cmdDiagnose();
    return 1;
  };

  /** Issue the sync for one app and start waiting on it. */
  const startSync = async (
    app: Application,
    key: TierKey,
    label?: string,
  ): Promise<string | null> => {
    const row: TierRow = {
      app: app.metadata.name,
      kind: sourceKind(app),
      result: label ?? "syncing",
      startedAt: Date.now(),
    };
    const k = formatTierKey(key);
    if (!tables.has(k)) tables.set(k, { key, rows: [] });
    tables.get(k)!.rows.push(row);
    active.set(app.metadata.name, row);
    const r = await syncOne(app, repoRoot, false, { terminateRunning: true });
    if (!r.ok) {
      row.result = "sync-cmd-failed";
      row.finishedAt = Date.now();
      return `argocd app sync ${app.metadata.name} failed:\n${r.detail}`;
    }
    if (r.skipped) row.result = r.skipped;
    if (r.skipped === "new-empty") {
      // No operation was issued and none ever will be: the Application is
      // done as far as this run is concerned (it stays Healthy, no operation).
      row.finishedAt = Date.now();
      done.add(app.metadata.name);
      active.delete(app.metadata.name);
    }
    return null;
  };

  await login(false);
  log.info(
    `syncing from ${repoRoot}${
      args.warm ? " (--warm: bootstrap + addons only)" : ""
    }${args.only ? ` (--only ${args.only.join(",")})` : ""}; timeout ${
      formatDuration(timeoutMs)
    }`,
  );

  for (;;) {
    let apps = selectApps(await listApplications(), opts);
    if (active.size === 0) {
      const tier = nextTier(apps, done);
      if (!tier) {
        // No next tier yet, but a parent may still be holding a wave open:
        // its later children appear only after that wave is Healthy. Keep
        // polling until they show up or every parent's operation settles.
        const waiting = parentsAwaitingWaves(apps);
        if (waiting.length === 0) break;
        if (Date.now() >= deadline) {
          return await fail(
            `sync timed out after ${
              formatDuration(timeoutMs)
            } waiting for the remaining child Applications of: ${
              waiting.join(", ")
            }`,
          );
        }
        log.info(
          `[${formatDuration(Date.now() - start)}] waiting for ${
            waiting.join(", ")
          } to create their next wave`,
        );
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      // A lower parent still holding a wave open (addons Running while we
      // would start applications): its later children do not exist yet, so
      // wait for it to settle instead of moving on to a later subtree.
      const byNameNow = indexApps(apps);
      const blocker = tierBlockedBy(
        tier.key,
        parentsAwaitingWaves(apps).map((name) => ({
          name,
          key: tierKey(byNameNow.get(name)!, byNameNow),
        })),
      );
      if (blocker !== null) {
        if (Date.now() >= deadline) {
          return await fail(
            `sync timed out after ${
              formatDuration(timeoutMs)
            } waiting for ${blocker} to finish its waves before ${
              formatTierKey(tier.key)
            }`,
          );
        }
        log.info(
          `[${
            formatDuration(Date.now() - start)
          }] waiting for ${blocker} to finish its waves before tier ${
            formatTierKey(tier.key)
          }`,
        );
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      tiersRun++;
      log.info(
        `tier ${formatTierKey(tier.key)}: ${
          tier.apps.map((a) => a.metadata.name).join(", ")
        }`,
      );
      for (const app of tier.apps) {
        const err = await startSync(app, tier.key);
        if (err) return await fail(err);
      }
    }

    await sleep(POLL_INTERVAL_MS);
    apps = selectApps(await listApplications(), opts);
    const byName = indexApps(apps);

    // A parent accepted earlier whose operation has since failed (a child
    // went Degraded during ArgoCD's wave wait) is no longer done.
    for (const app of apps) {
      const name = app.metadata.name;
      if (
        done.has(name) && !active.has(name) && isParentApp(app) &&
        appState(app) === "failed"
      ) {
        done.delete(name);
        const key = tierKey(app, byName);
        log.warn(
          `${name}: parent operation ${app.status?.operationState?.phase} after acceptance (${
            (app.status?.operationState?.message ?? "").split("\n")[0]
          }); will re-sync once its children are complete`,
        );
        const row: TierRow = {
          app: name,
          kind: sourceKind(app),
          result: "re-sync pending",
          startedAt: Date.now(),
        };
        const k = formatTierKey(key);
        if (!tables.has(k)) tables.set(k, { key, rows: [] });
        tables.get(k)!.rows.push(row);
        active.set(name, row);
      }
    }

    // Discover apps in LOWER tiers than anything we are waiting on (created
    // by a parent while we waited elsewhere) and sync them right away.
    let currentKey: TierKey | null = null;
    for (const name of active.keys()) {
      const app = byName.get(name);
      if (!app) continue;
      const key = tierKey(app, byName);
      if (currentKey === null || compareTierKey(key, currentKey) < 0) {
        currentKey = key;
      }
    }
    if (currentKey !== null) {
      const found = discoverable(
        apps,
        done,
        new Set(active.keys()),
        currentKey,
      );
      if (found.length > 0) {
        log.info(
          `discovered lower-tier app(s) while waiting on ${
            formatTierKey(currentKey)
          }: ${found.map((a) => a.metadata.name).join(", ")}`,
        );
        for (const app of found) {
          const err = await startSync(app, tierKey(app, byName));
          if (err) return await fail(err);
        }
      }
    }

    // Evaluate everything we are waiting on.
    const pending: Application[] = [];
    for (const [name, row] of [...active.entries()]) {
      const app = byName.get(name);
      if (!app) {
        // Pruned by its parent while we waited: nothing left to sync.
        row.result = "gone";
        row.finishedAt = Date.now();
        done.add(name);
        active.delete(name);
        log.warn(`${name} disappeared during sync (pruned by its parent?)`);
        continue;
      }
      const state = appState(app);
      if (state !== "complete" && isAutomated(app) && hasComparisonError(app)) {
        // Nobody will fix this from here: ArgoCD cannot render the app from
        // its repo and we are not allowed to push the working tree into it.
        row.result = "comparison-error";
        row.finishedAt = Date.now();
        return await fail(
          `${name}: automated app cannot be rendered by ArgoCD: ${
            (app.status?.conditions ?? []).find((c) =>
              c?.type === "ComparisonError"
            )?.message ?? ""
          }`,
        );
      }
      if (state === "complete") {
        // "accepted": a parent's operation stays open until its child
        // Applications (synced in later tiers) are Healthy.
        const healthy = app.status?.health?.status === "Healthy" &&
          app.status?.operationState?.phase === "Succeeded";
        if (row.result === "empty") {
          // keep the label
        } else {
          row.result = healthy ? "complete" : "accepted";
        }
        row.finishedAt = Date.now();
        done.add(name);
        active.delete(name);
        continue;
      }
      if (state === "failed") {
        const msg = (app.status?.operationState?.message ?? "").split("\n")[0];
        const used = retries.get(name) ?? 0;
        if (isParentApp(app)) {
          const kids = pendingChildren(name, apps, done).length;
          const decision = parentResyncDecision(app, kids, used);
          if (decision === "wait") {
            row.result = `re-sync pending (${kids} child${
              kids === 1 ? "" : "ren"
            } pending)`;
            pending.push(app);
            continue;
          }
          if (decision === "give-up") {
            row.result = `failed (${SYNC_RETRIES} re-syncs)`;
            row.finishedAt = Date.now();
            return await fail(
              `${name}: parent operation ${app.status?.operationState?.phase} after ${SYNC_RETRIES} re-syncs: ${msg}`,
            );
          }
          retries.set(name, used + 1);
          log.warn(
            `${name}: parent operation ${app.status?.operationState?.phase} (${msg}); children complete, re-sync ${
              used + 1
            }/${SYNC_RETRIES}`,
          );
          const r = await syncOne(app, repoRoot, false);
          if (!r.ok) log.warn(`${name}: re-sync command failed: ${r.detail}`);
          row.result = `re-sync ${used + 1}`;
          pending.push(app);
          continue;
        }
        const n = used + 1;
        if (n > SYNC_RETRIES) {
          row.result = `failed (${SYNC_RETRIES} retries)`;
          row.finishedAt = Date.now();
          return await fail(
            `${name}: operation ${app.status?.operationState?.phase} after ${SYNC_RETRIES} retries: ${msg}`,
          );
        }
        retries.set(name, n);
        log.warn(
          `${name}: operation ${app.status?.operationState?.phase} (${msg}); retry ${n}/${SYNC_RETRIES} in ${
            formatDuration(SYNC_RETRY_BACKOFF_MS)
          }`,
        );
        await sleep(SYNC_RETRY_BACKOFF_MS);
        const r = await syncOne(app, repoRoot, false);
        if (!r.ok) log.warn(`${name}: re-sync command failed: ${r.detail}`);
        row.result = `retry ${n}`;
        pending.push(app);
        continue;
      }
      pending.push(app);
    }

    flushTables(tables, printed, false);
    if (Date.now() >= deadline) {
      return await fail(
        `sync timed out after ${formatDuration(timeoutMs)} waiting for: ${
          summarise(pending)
        }`,
      );
    }
    if (pending.length > 0) {
      log.info(
        `[${formatDuration(Date.now() - start)}] waiting: ${
          summarise(pending)
        }`,
      );
    }
  }
  flushTables(tables, printed, true);

  // Final pass: every parent whose last operation is not Succeeded gets one
  // more sync from the working tree (deepest parents first, root last) so
  // the parent's own PostSync hooks run and ArgoCD records a clean result.
  const rc = await finishParents(repoRoot, opts, deadline, start);
  if (rc !== 0) return rc;

  log.ok(
    `${done.size} Application(s) synced in ${tiersRun} tier(s), ${
      formatDuration(Date.now() - start)
    }`,
  );
  return 0;
}

/** Print each tier table once all its rows are finished (or all, at the end). */
function flushTables(
  tables: Map<string, { key: TierKey; rows: TierRow[] }>,
  printed: Set<string>,
  all: boolean,
): void {
  for (const [k, t] of tables) {
    if (printed.has(k)) continue;
    if (all || t.rows.every((r) => r.finishedAt !== undefined)) {
      printTier(t.key, t.rows);
      printed.add(k);
    }
  }
}

async function finishParents(
  repoRoot: string,
  opts: { warm: boolean; only: string[] | null },
  deadline: number,
  start: number,
): Promise<number> {
  const apps = selectApps(await listApplications(), opts);
  const byName = indexApps(apps);
  const parents = apps
    .filter((a) => isParentApp(a) && finalPassDecision(a) !== "done")
    .sort((x, y) => -compareTierKey(tierKey(x, byName), tierKey(y, byName)));
  if (parents.length === 0) return 0;
  log.info(
    `final pass: parent(s) without a Succeeded operation: ${
      parents.map((a) =>
        `${a.metadata.name} (${
          a.status?.operationState?.phase ?? "no operation"
        })`
      ).join(", ")
    }`,
  );
  for (const parent of parents) {
    const name = parent.metadata.name;
    let resyncs = 0;
    let app: Application | null = parent;
    for (;;) {
      const decision = app ? finalPassDecision(app) : "resync";
      if (decision === "done") {
        log.ok(`${name}: operation Succeeded (${app?.status?.health?.status})`);
        break;
      }
      if (decision === "resync") {
        const msg = (app?.status?.operationState?.message ?? "").split("\n")[0];
        if (resyncs >= SYNC_RETRIES) {
          log.error(
            `${name}: final re-sync ${
              app?.status?.operationState?.phase ?? "-"
            } after ${SYNC_RETRIES} attempts: ${msg}`,
          );
          await cmdDiagnose();
          return 1;
        }
        resyncs++;
        log.warn(
          `${name}: operation ${
            app?.status?.operationState?.phase ?? "missing"
          }${msg ? ` (${msg})` : ""}; final re-sync ${resyncs}/${SYNC_RETRIES}`,
        );
        const r = await syncOne(parent, repoRoot, false);
        if (!r.ok) {
          log.error(`final re-sync of ${name} failed:\n${r.detail}`);
          await cmdDiagnose();
          return 1;
        }
      } else {
        log.info(
          `[${
            formatDuration(Date.now() - start)
          }] final pass: waiting for ${name} (${
            app?.status?.health?.status ?? "?"
          }/${app?.status?.operationState?.phase ?? "-"})`,
        );
      }
      if (Date.now() >= deadline) {
        log.error(
          `sync timed out after ${
            formatDuration(deadline - start)
          } in the final parent pass waiting for ${name}`,
        );
        await cmdDiagnose();
        return 1;
      }
      await sleep(POLL_INTERVAL_MS);
      app = await getApplication(name);
      if (!app) {
        log.warn(`${name} disappeared during the final pass`);
        break;
      }
    }
  }
  return 0;
}

// ============================================================================
// wait
// ============================================================================
async function cmdWait(args: Args): Promise<number> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const excluded = new Set(args.exclude);
  const hinted = new Set<string>();
  const start = Date.now();
  const deadline = start + timeoutMs;
  log.info(
    `waiting for every Application to be Healthy + Succeeded${
      args.requireSynced ? " + Synced" : ""
    }${
      excluded.size ? ` (excluding ${[...excluded].join(", ")})` : ""
    }; timeout ${formatDuration(timeoutMs)}`,
  );
  for (;;) {
    const apps = (await listApplications()).filter((a) =>
      !excluded.has(a.metadata.name)
    );
    const notReady = apps.filter((a) => !isReady(a, args.requireSynced));
    if (apps.length > 0 && notReady.length === 0) {
      log.ok(
        `${apps.length} Application(s) Healthy after ${
          formatDuration(Date.now() - start)
        }`,
      );
      return 0;
    }
    if (Date.now() >= deadline) {
      log.error(
        `wait timed out after ${formatDuration(timeoutMs)}; not ready: ${
          apps.length === 0 ? "(no Applications found)" : summarise(notReady)
        }`,
      );
      await cmdDiagnose();
      return 1;
    }
    log.info(
      `[${formatDuration(Date.now() - start)}] ${
        apps.length - notReady.length
      }/${apps.length} ready; waiting: ${
        apps.length === 0 ? "(no Applications yet)" : summarise(notReady)
      }`,
    );
    for (const app of notReady) {
      const hint = degradedChildHint(app);
      if (hint && !hinted.has(app.metadata.name)) {
        hinted.add(app.metadata.name);
        log.warn(hint);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ============================================================================
// diagnose
// ============================================================================
function tail(text: string, n: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

interface ContainerStatusSummary {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
}

export interface PodSummary {
  metadata?: { name?: string; namespace?: string };
  status?: {
    phase?: string;
    containerStatuses?: ContainerStatusSummary[];
    initContainerStatuses?: ContainerStatusSummary[];
  };
}

/**
 * Whether diagnose should dump a pod: any phase other than Running/Succeeded,
 * or a Running pod with a container that is not ready, has restarted, or is
 * waiting (CrashLoopBackOff keeps the pod phase at Running, which is exactly
 * the pod whose logs explain a Progressing workload).
 */
export function podNeedsDiagnosis(pod: PodSummary): boolean {
  const phase = pod.status?.phase ?? "Unknown";
  if (phase !== "Running" && phase !== "Succeeded") return true;
  if (phase === "Succeeded") return false;
  const all = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  return all.some((c) =>
    c.ready === false || (c.restartCount ?? 0) > 0 || !!c.state?.waiting
  );
}

/** True when a container of the pod has restarted (a --previous log exists). */
export function podHasRestarted(pod: PodSummary): boolean {
  return [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ].some((c) => (c.restartCount ?? 0) > 0);
}

/** A managed resource `kubectl describe` can name; group is "" for core kinds. */
export interface DescribeTarget {
  group: string;
  kind: string;
  ns: string;
  name: string;
}

/** The namespace a resource lives in: its own, else the app's destination. */
function resourceNamespace(r: AppResource, app: Application): string {
  return r.namespace ?? app.spec?.destination?.namespace ?? "";
}

/** ArgoCD omits health for kinds it cannot assess; that counts as not Healthy. */
function resourceNotHealthy(r: AppResource): boolean {
  return r.health?.status !== "Healthy";
}

/** `<group/>kind ns/name: <health or "-">[ — message]` for one resource. */
export function formatResource(r: AppResource, app: Application): string {
  const ns = resourceNamespace(r, app);
  const msg = r.health?.message ? ` — ${r.health.message}` : "";
  return `${r.group ? `${r.group}/` : ""}${r.kind ?? "?"} ${
    ns ? `${ns}/` : ""
  }${r.name ?? "?"}: ${r.health?.status ?? "-"}${msg}`;
}

/**
 * Resource lines for the diagnose output: every managed resource when the
 * Application itself is not Healthy (ArgoCD may omit per-resource health, so
 * the reader still sees what the app manages), otherwise only those that are
 * not Healthy.
 */
export function resourceLines(app: Application): string[] {
  const all = (app.status?.resources ?? []).filter((r) => r != null);
  const shown = app.status?.health?.status === "Healthy"
    ? all.filter(resourceNotHealthy)
    : all;
  return shown.map((r) => formatResource(r, app));
}

/**
 * Namespaces to diagnose for the unhealthy Applications: every destination
 * namespace plus the namespace of every resource that is not Healthy (child
 * Applications excluded), de-duplicated; `argocd` last, so an unhealthy
 * parent's events do not bury the workload namespaces.
 */
export function diagnoseNamespaces(unhealthy: Application[]): string[] {
  const seen = new Set<string>();
  for (const app of unhealthy) {
    const dest = app.spec?.destination?.namespace;
    if (dest) seen.add(dest);
    for (const r of app.status?.resources ?? []) {
      if (!r || r.kind === "Application" || !resourceNotHealthy(r)) continue;
      const ns = resourceNamespace(r, app);
      if (ns) seen.add(ns);
    }
  }
  const others = [...seen].filter((ns) => ns !== ARGOCD_NAMESPACE).sort();
  return seen.has(ARGOCD_NAMESPACE) ? [...others, ARGOCD_NAMESPACE] : others;
}

/**
 * Resources worth a `kubectl describe`: not Healthy (or without health), in a
 * non-core API group other than argoproj.io, de-duplicated. The describe
 * shows a custom resource's own status conditions and events, which the
 * Application's health line alone hides.
 */
export function describeTargets(unhealthy: Application[]): DescribeTarget[] {
  const seen = new Set<string>();
  const out: DescribeTarget[] = [];
  for (const app of unhealthy) {
    for (const r of app.status?.resources ?? []) {
      if (!r?.group || r.group === "argoproj.io" || !r.kind || !r.name) {
        continue;
      }
      if (!resourceNotHealthy(r)) continue;
      const t = {
        group: r.group,
        kind: r.kind,
        ns: resourceNamespace(r, app),
        name: r.name,
      };
      const key = `${t.group}/${t.kind} ${t.ns}/${t.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/** `kubectl describe <kind>.<group> <name> [-n <ns>]` arguments for a target. */
export function describeArgs(t: DescribeTarget): string[] {
  const resource = t.group ? `${t.kind.toLowerCase()}.${t.group}` : t.kind;
  return t.ns
    ? ["describe", resource, t.name, "-n", t.ns]
    : ["describe", resource, t.name];
}

async function diagnoseEvents(ns: string): Promise<void> {
  console.log(`\n--- namespace ${ns}: last ${EVENTS_TAIL} events ---`);
  const ev = await run(
    kubectl("get", "events", "-n", ns, "--sort-by=.lastTimestamp"),
  );
  console.log(
    ev.code === 0
      ? tail(ev.stdout, EVENTS_TAIL) || "(no events)"
      : `(kubectl get events failed: ${ev.stderr.trim()})`,
  );
}

async function diagnosePods(ns: string): Promise<void> {
  const pods = await run(kubectl("get", "pods", "-n", ns, "-o", "json"));
  if (pods.code !== 0) {
    console.log(`(kubectl get pods failed: ${pods.stderr.trim()})`);
    return;
  }
  let items: PodSummary[] = [];
  try {
    items = (JSON.parse(pods.stdout) as { items?: PodSummary[] }).items ?? [];
  } catch {
    console.log("(pod list was not JSON)");
    return;
  }
  for (const pod of items) {
    const phase = pod.status?.phase ?? "Unknown";
    const name = pod.metadata?.name;
    if (!name || !podNeedsDiagnosis(pod)) continue;
    console.log(`\n--- pod ${ns}/${name} (${phase}): describe tail ---`);
    const d = await run(kubectl("describe", "pod", name, "-n", ns));
    console.log(d.code === 0 ? tail(d.stdout, DESCRIBE_TAIL) : d.stderr.trim());
    console.log(
      `\n--- pod ${ns}/${name}: logs --tail=${LOGS_TAIL} --all-containers ---`,
    );
    const l = await run(
      kubectl(
        "logs",
        name,
        "-n",
        ns,
        `--tail=${LOGS_TAIL}`,
        "--all-containers",
      ),
    );
    console.log((l.code === 0 ? l.stdout : l.stderr).trim() || "(no logs)");
    if (podHasRestarted(pod)) {
      // A crash-looping container is usually Waiting with an empty current
      // log; the previous run is the one that failed.
      console.log(
        `\n--- pod ${ns}/${name}: logs --previous --tail=${LOGS_TAIL} --all-containers ---`,
      );
      const p = await run(
        kubectl(
          "logs",
          name,
          "-n",
          ns,
          "--previous",
          `--tail=${LOGS_TAIL}`,
          "--all-containers",
        ),
      );
      console.log((p.code === 0 ? p.stdout : p.stderr).trim() || "(no logs)");
    }
  }
}

/** Workloads table: a StatefulSet at READY 0/1 with no pod shows up here. */
async function diagnoseWorkloads(ns: string): Promise<void> {
  console.log(`\n--- namespace ${ns}: statefulsets, deployments, jobs ---`);
  const w = await run(
    kubectl("get", "statefulsets,deployments,jobs", "-n", ns),
  );
  console.log((w.code === 0 ? w.stdout : w.stderr).trim() || "(none)");
}

async function describeResources(targets: DescribeTarget[]): Promise<void> {
  for (const t of targets) {
    console.log(
      `\n--- ${t.group}/${t.kind} ${t.ns}/${t.name}: describe tail ---`,
    );
    const d = await run(kubectl(...describeArgs(t)));
    console.log(
      (d.code === 0 ? tail(d.stdout, DESCRIBE_TAIL) : d.stderr.trim()) ||
        "(no output)",
    );
  }
}

async function diagnoseNamespace(
  ns: string,
  targets: DescribeTarget[],
): Promise<void> {
  await diagnoseEvents(ns);
  await diagnosePods(ns);
  await diagnoseWorkloads(ns);
  await describeResources(targets.filter((t) => t.ns === ns));
}

function printApplication(app: Application): void {
  const st = app.status ?? {};
  console.log(`\n=== ${app.metadata.name} ===`);
  console.log(
    `  health: ${st.health?.status ?? "-"}  sync: ${
      st.sync?.status ?? "-"
    }  operation: ${st.operationState?.phase ?? "-"}`,
  );
  if (st.health?.message) {
    console.log(`  health message: ${st.health.message}`);
  }
  if (st.operationState?.message) {
    console.log(`  operation message: ${st.operationState.message}`);
  }
  for (const c of st.conditions ?? []) {
    console.log(`  condition ${c?.type ?? "?"}: ${c?.message ?? ""}`);
  }
  const lines = resourceLines(app);
  if (lines.length > 0) {
    console.log("  resources:");
    for (const line of lines) console.log(`    ${line}`);
  } else if ((st.resources ?? []).length === 0) {
    console.log("  resources: (none reported)");
  }
}

async function cmdDiagnose(): Promise<number> {
  let apps: Application[];
  try {
    apps = await listApplications();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const unhealthy = apps.filter((a) => !isReady(a, false));
  console.log(
    `\n===== diagnose: ${unhealthy.length}/${apps.length} Application(s) not Healthy/Succeeded =====`,
  );
  if (unhealthy.length === 0) {
    log.ok("every Application is Healthy with a Succeeded operation");
    return 0;
  }
  for (const app of unhealthy) printApplication(app);
  const targets = describeTargets(unhealthy);
  for (const ns of diagnoseNamespaces(unhealthy)) {
    try {
      await diagnoseNamespace(ns, targets);
    } catch (err) {
      log.warn(
        `diagnose ${ns}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log("");
  return 0;
}

// ============================================================================
// report
// ============================================================================
async function readVerifyInput(path: string | null): Promise<VerifyInput> {
  if (path === null) {
    return {
      ok: false,
      reason:
        "no level-2 JSON given (`--verify-json <file>` from `task verify LEVEL=2 | tee <file>`)",
    };
  }
  let text: string | null;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    text = null;
  }
  return parseVerifyJson(text, path);
}

/** `argocd app diff <app>`, inverted to main → PR. Never throws. */
async function diffApp(name: string): Promise<AppDiff> {
  await ensureArgocdReachable();
  const r = await run(argocd("app", "diff", name, "--exit-code=false"), {
    env: { KUBECTL_EXTERNAL_DIFF: DIFF_TOOL },
  });
  const d = classifyDiffResult(name, r.code, r.stdout, r.stderr);
  if (d.error !== undefined) log.warn(`${name}: diff unavailable: ${d.error}`);
  else log.ok(`${name}: ${diffStats(d.diff).resources} resource(s) differ`);
  return d;
}

/** Commit and run link when running in GitHub Actions. */
function githubMeta(): ReportInput["meta"] {
  const env = (k: string) => Deno.env.get(k)?.trim() || undefined;
  const server = env("GITHUB_SERVER_URL");
  const repo = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  return {
    // On pull_request GITHUB_SHA is the merge commit; the workflow passes
    // the PR head as PR_HEAD_SHA.
    sha: env("PR_HEAD_SHA") ?? env("GITHUB_SHA"),
    runUrl: server && repo && runId
      ? `${server}/${repo}/actions/runs/${runId}`
      : undefined,
  };
}

async function cmdReport(args: Args): Promise<number> {
  logToStderr = true;
  const verify = await readVerifyInput(args.verifyJson);
  if (!verify.ok) log.warn(verify.reason);

  let apps: Application[] | null = null;
  let appsError: string | undefined;
  try {
    apps = await listApplications();
    log.info(
      `${apps.length} Application(s) in ${KUBE_CONTEXT}/${ARGOCD_NAMESPACE}`,
    );
  } catch (err) {
    appsError = firstLine(err instanceof Error ? err.message : String(err));
    log.warn(`ArgoCD not reachable: ${appsError}`);
  }

  let diffs: AppDiff[] = [];
  let diffNote: string | undefined;
  if (apps !== null) {
    const targets = appsToDiff(apps);
    if (args.noDiff) {
      diffNote = "Diffs skipped (`--no-diff`).";
    } else if (targets.length > 0) {
      log.info(
        `argocd app diff for ${targets.length} app(s): ${targets.join(", ")}`,
      );
      try {
        diffs = await withArgocdServer(args, async () => {
          await login(false);
          const out: AppDiff[] = [];
          for (const name of targets) out.push(await diffApp(name));
          return out;
        });
      } catch (err) {
        const why = firstLine(err instanceof Error ? err.message : String(err));
        log.warn(`no diffs: ${why}`);
        diffNote = `Diffs unavailable: the ArgoCD API was not reachable (${
          mdCell(why)
        }).`;
      }
    }
  }

  const markdown = renderReport({
    apps,
    appsError,
    verify,
    diffs: truncateDiffs(diffs, args.maxDiffBytes),
    diffNote,
    meta: githubMeta(),
  });
  if (args.out === null) {
    await Deno.stdout.write(utf8.encode(markdown));
    return 0;
  }
  try {
    await Deno.writeTextFile(args.out, markdown);
  } catch (err) {
    log.error(
      `cannot write ${args.out}: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }
  log.ok(`report written to ${args.out} (${byteLength(markdown)} bytes)`);
  return 0;
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(Deno.args);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    console.error("Run with --help for usage.");
    return 2;
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.command === null) {
    log.error("missing command (install, sync, wait, diagnose or report)");
    console.error("Run with --help for usage.");
    return 2;
  }
  const repoRoot = async () =>
    args.repoRoot ? resolve(args.repoRoot) : await findRepoRoot();
  switch (args.command) {
    case "install":
      return await cmdInstall(args, await repoRoot());
    case "sync":
      return await cmdSync(args, await repoRoot());
    case "wait":
      return await cmdWait(args);
    case "diagnose":
      return await cmdDiagnose();
    case "report":
      return await cmdReport(args);
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
