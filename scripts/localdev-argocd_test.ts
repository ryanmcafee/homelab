#!/usr/bin/env -S deno test
/**
 * Unit tests for the pure orchestration logic in localdev-argocd.ts.
 *
 * The live install/sync/wait need a Kind cluster and the argocd CLI; these do
 * not. They pin the tier algorithm from the Section B plan ("Cross-package
 * interfaces → Sync orchestration") against hand-built Application objects in
 * the shape `kubectl get applications -o json` returns.
 *
 *   deno test scripts/localdev-argocd_test.ts
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@^1";
import { parse as parseYaml } from "jsr:@std/yaml@^1";
import {
  type AppDiff,
  type Application,
  appState,
  appsToDiff,
  argocdErrorMessage,
  branchFromUpstream,
  candidatePorts,
  chartVersionFromVersions,
  chooseRevision,
  classifyDiffResult,
  compareTierKey,
  countManifests,
  crdsInstallArgs,
  DEFAULT_BASE,
  DEFAULT_LOCAL_PORT,
  DEFAULT_MAX_DIFF_BYTES,
  degradedChildHint,
  describeArgs,
  describeTargets,
  diagnoseNamespaces,
  diffArgs,
  diffStats,
  discoverable,
  emptyRenderDecision,
  escapeHelmKey,
  extractJsonObject,
  fenceFor,
  finalPassDecision,
  findFreePort,
  gitRefForRevision,
  hasComparisonError,
  indexApps,
  invertUnifiedDiff,
  isAppComplete,
  isAutomated,
  isNewEmptyApp,
  isOperationInProgress,
  isParentApp,
  isReady,
  isTierComplete,
  isTierKeyPrefix,
  manifestsArgs,
  mdCell,
  mentionsMissingPath,
  nextTier,
  parentOf,
  parentResyncDecision,
  parentsAwaitingWaves,
  parseArgs,
  parseByteCount,
  parsePort,
  parseVerifyJson,
  parseWave,
  pendingChildren,
  podHasRestarted,
  podNeedsDiagnosis,
  type PodSummary,
  portForwardCmd,
  PROMETHEUS_CRDS_HELM_REPO,
  PROMETHEUS_CRDS_RELEASE,
  renderReport,
  renderRootApp,
  REPORT_MAX_FINDINGS,
  REPORT_TITLE,
  resourceLines,
  selectApps,
  serverFlags,
  setFileArgs,
  sourceKind,
  statusRows,
  syncArgs,
  tierBlockedBy,
  tierKey,
  treeOrder,
  truncateDiffs,
  type VerifyInput,
} from "./localdev-argocd.ts";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------
interface AppOpts {
  name: string;
  wave?: string;
  parent?: string;
  path?: string;
  chart?: string;
  sources?: boolean;
  health?: string;
  phase?: string;
  sync?: string;
  resourceKinds?: string[];
}

function app(o: AppOpts): Application {
  const a: Application = {
    metadata: { name: o.name, namespace: "argocd" },
    spec: { source: {}, destination: { namespace: "argocd" } },
    status: {},
  };
  if (o.wave !== undefined) {
    a.metadata.annotations = { "argocd.argoproj.io/sync-wave": o.wave };
  }
  if (o.parent !== undefined) {
    a.metadata.labels = { "app.kubernetes.io/instance": o.parent };
  }
  if (o.path !== undefined) a.spec!.source = { path: o.path };
  if (o.chart !== undefined) {
    a.spec!.source = { chart: o.chart, repoURL: "https://charts.example" };
  }
  if (o.sources) {
    delete a.spec!.source;
    a.spec!.sources = [{ path: "a" }, { chart: "b" }];
  }
  if (o.health !== undefined) a.status!.health = { status: o.health };
  if (o.phase !== undefined) a.status!.operationState = { phase: o.phase };
  if (o.sync !== undefined) a.status!.sync = { status: o.sync };
  if (o.resourceKinds) {
    a.status!.resources = o.resourceKinds.map((kind) => ({ kind }));
  }
  return a;
}

const REPO = "/work/homelab";

// The localdev app tree: root gitops (no label) → bootstrap/addons/applications
// (label gitops) → their children (label addons / applications / bootstrap).
const gitops = app({ name: "gitops", wave: "0", path: "charts/gitops" });
const bootstrap = app({
  name: "bootstrap",
  wave: "0",
  parent: "gitops",
  path: "charts/bootstrap",
});
const addons = app({
  name: "addons",
  wave: "2",
  parent: "gitops",
  path: "charts/addons",
});
const applications = app({
  name: "applications",
  wave: "3",
  parent: "gitops",
  path: "charts/applications",
});
const cilium = app({
  name: "cilium",
  wave: "-5",
  parent: "addons",
  chart: "cilium",
});
const traefik = app({
  name: "traefik",
  wave: "1",
  parent: "addons",
  chart: "traefik",
});
const sonarrConfig = app({
  name: "sonarr-config",
  wave: "0",
  parent: "applications",
  path: "charts/sonarr-config",
});
const argocdApp = app({
  name: "argocd",
  wave: "1",
  parent: "bootstrap",
  chart: "argo-cd",
});

// ----------------------------------------------------------------------------
// parseWave / parentOf
// ----------------------------------------------------------------------------
Deno.test("parseWave: reads the sync-wave annotation as an integer", () => {
  assertEquals(parseWave(app({ name: "a", wave: "2" })), 2);
  assertEquals(parseWave(app({ name: "a", wave: "-5" })), -5);
  assertEquals(parseWave(app({ name: "a", wave: " 7 " })), 7);
});

Deno.test("parseWave: missing or unparsable annotation is wave 0", () => {
  assertEquals(parseWave(app({ name: "a" })), 0);
  assertEquals(parseWave(app({ name: "a", wave: "" })), 0);
  assertEquals(parseWave(app({ name: "a", wave: "later" })), 0);
  assertEquals(parseWave({ metadata: { name: "bare" } }), 0);
});

Deno.test("parentOf: the ArgoCD tracking label names the parent", () => {
  assertEquals(parentOf(addons), "gitops");
  assertEquals(parentOf(cilium), "addons");
});

Deno.test("parentOf: the root has no parent; a self-label is ignored", () => {
  assertEquals(parentOf(gitops), null);
  assertEquals(parentOf({ metadata: { name: "x" } }), null);
  assertEquals(parentOf(app({ name: "loop", parent: "loop" })), null);
});

Deno.test("indexApps: maps every app name to the app", () => {
  const byName = indexApps([gitops, addons, cilium]);
  assertEquals(byName.get("gitops"), gitops);
  assertEquals(byName.get("cilium")?.metadata.name, "cilium");
});

// ----------------------------------------------------------------------------
// tierKey / nextTier
// ----------------------------------------------------------------------------
Deno.test("tierKey: the root's key is just its own wave", () => {
  assertEquals(tierKey(gitops, indexApps([gitops])), [0]);
});

Deno.test("tierKey: children are keyed by the wave path from the root", () => {
  const all = [gitops, bootstrap, addons, applications, cilium, sonarrConfig];
  const byName = indexApps(all);
  assertEquals(tierKey(bootstrap, byName), [0, 0]);
  assertEquals(tierKey(addons, byName), [0, 2]);
  assertEquals(tierKey(applications, byName), [0, 3]);
  assertEquals(tierKey(cilium, byName), [0, 2, -5]);
  assertEquals(tierKey(sonarrConfig, byName), [0, 3, 0]);
});

Deno.test("tierKey: a parent that is not in the index counts as an unknown wave-0 root", () => {
  // Cannot happen in a consistent cluster (the parent created the child), but
  // the key must still be total so the loop never stalls.
  assertEquals(tierKey(cilium, new Map()), [0, -5]);
});

Deno.test("tierKey: a cycle in the tracking annotations is cut, not looped", () => {
  const a = app({ name: "a", wave: "1", parent: "b" });
  const b = app({ name: "b", wave: "2", parent: "a" });
  assertEquals(tierKey(a, indexApps([a, b])), [2, 1]);
});

Deno.test("compareTierKey: a parent sorts before its children, even negative-wave ones", () => {
  // The plan's (parent wave, own wave) pair would put sops-secrets (0,-2)
  // before its parent bootstrap (0,0); the wave path keeps the parent first.
  assert(compareTierKey([0, 0], [0, 0, -2]) < 0);
  assert(compareTierKey([0, 0, -2], [0, 0, -1]) < 0);
  assert(compareTierKey([0, 0, 5], [0, 2]) < 0);
  assert(compareTierKey([0, 2, -5], [0, 3]) < 0);
  assertEquals(compareTierKey([0, 2], [0, 2]), 0);
});

Deno.test("nextTier: walks the tree root → gitops children → addon children → application children", () => {
  const all = [
    sonarrConfig,
    traefik,
    cilium,
    applications,
    addons,
    bootstrap,
    argocdApp,
    gitops,
  ];
  const done = new Set<string>();
  const order: string[][] = [];
  for (;;) {
    const tier = nextTier(all, done);
    if (!tier) break;
    order.push(tier.apps.map((a) => a.metadata.name));
    for (const a of tier.apps) done.add(a.metadata.name);
  }
  // Whole subtrees in wave order: everything under bootstrap, then under
  // addons, then under applications (the addon children come before the
  // `applications` parent itself is synced).
  assertEquals(order, [
    ["gitops"],
    ["bootstrap"],
    ["argocd"],
    ["addons"],
    ["cilium"],
    ["traefik"],
    ["applications"],
    ["sonarr-config"],
  ]);
});

Deno.test("nextTier: apps sharing a key form one tier, sorted by name", () => {
  const a = app({ name: "zeta", wave: "1", parent: "addons", chart: "z" });
  const b = app({ name: "alpha", wave: "1", parent: "addons", chart: "a" });
  const tier = nextTier([gitops, addons, a, b], new Set(["gitops", "addons"]));
  assert(tier);
  assertEquals(tier.key, [0, 2, 1]);
  assertEquals(tier.apps.map((x) => x.metadata.name), ["alpha", "zeta"]);
});

Deno.test("nextTier: returns null once everything is done", () => {
  assertEquals(nextTier([gitops], new Set(["gitops"])), null);
  assertEquals(nextTier([], new Set()), null);
});

Deno.test("nextTier: a later round can reuse an earlier key when children appear", () => {
  // bootstrap is (0,0); once it is synced its wave-0 child shows up with the
  // same key and must be picked up as a new tier, not skipped.
  const child = app({
    name: "sops-secrets",
    wave: "0",
    parent: "bootstrap",
    path: "charts/secrets/onepassword",
  });
  const tier = nextTier(
    [gitops, bootstrap, addons, child],
    new Set(["gitops", "bootstrap"]),
  );
  assert(tier);
  assertEquals(tier.key, [0, 0, 0]);
  assertEquals(tier.apps.map((x) => x.metadata.name), ["sops-secrets"]);
});

// ----------------------------------------------------------------------------
// appState / isAppComplete / isTierComplete
// ----------------------------------------------------------------------------
Deno.test("appState: Healthy + Succeeded is complete", () => {
  assertEquals(
    appState(app({ name: "a", health: "Healthy", phase: "Succeeded" })),
    "complete",
  );
  assert(
    isAppComplete(app({ name: "a", health: "Healthy", phase: "Succeeded" })),
  );
});

Deno.test("appState: a parent whose Running operation waits on child Applications is complete", () => {
  const parent = app({
    name: "addons",
    health: "Progressing",
    phase: "Running",
    resourceKinds: ["Application", "Application"],
  });
  assertEquals(appState(parent), "complete");
});

Deno.test("appState: a Running operation without child Applications is pending", () => {
  const leaf = app({
    name: "traefik",
    health: "Progressing",
    phase: "Running",
    resourceKinds: ["Deployment", "Service"],
  });
  assertEquals(appState(leaf), "pending");
  assertEquals(
    appState(app({ name: "x", health: "Healthy", phase: "Running" })),
    "pending",
  );
});

Deno.test("appState: Succeeded but not yet Healthy is pending", () => {
  assertEquals(
    appState(app({ name: "a", health: "Progressing", phase: "Succeeded" })),
    "pending",
  );
  assertEquals(
    appState(app({ name: "a", health: "Degraded", phase: "Succeeded" })),
    "pending",
  );
});

Deno.test("appState: Failed and Error operations are failed", () => {
  assertEquals(appState(app({ name: "a", phase: "Failed" })), "failed");
  assertEquals(
    appState(app({ name: "a", health: "Healthy", phase: "Error" })),
    "failed",
  );
});

Deno.test("appState: never-synced or fieldless apps are pending", () => {
  assertEquals(appState(app({ name: "a" })), "pending");
  assertEquals(appState({ metadata: { name: "bare" } }), "pending");
});

Deno.test("isTierComplete: every app in the tier must be complete", () => {
  const ok = app({ name: "a", health: "Healthy", phase: "Succeeded" });
  const parent = app({
    name: "p",
    phase: "Running",
    resourceKinds: ["Application"],
  });
  const pending = app({ name: "c", health: "Progressing", phase: "Running" });
  assert(isTierComplete([ok, parent]));
  assert(!isTierComplete([ok, pending]));
  assert(!isTierComplete([app({ name: "f", phase: "Failed" })]));
  assert(isTierComplete([]));
});

// ----------------------------------------------------------------------------
// sourceKind / syncArgs
// ----------------------------------------------------------------------------
Deno.test("sourceKind: path → local, chart → chart, sources → multi", () => {
  assertEquals(sourceKind(gitops), "local");
  assertEquals(sourceKind(cilium), "chart");
  assertEquals(sourceKind(app({ name: "m", sources: true })), "multi");
  assertEquals(sourceKind({ metadata: { name: "bare" } }), "chart");
});

Deno.test("syncArgs: git-path apps sync from the working tree", () => {
  assertEquals(syncArgs(gitops, REPO), [
    "app",
    "sync",
    "gitops",
    "--local",
    "/work/homelab/charts/gitops",
    "--local-repo-root",
    "/work/homelab",
    "--prune",
    "--async",
  ]);
  assertEquals(syncArgs(sonarrConfig, REPO).slice(3, 5), [
    "--local",
    "/work/homelab/charts/sonarr-config",
  ]);
});

Deno.test("syncArgs: chart and multi-source apps sync without --local", () => {
  assertEquals(syncArgs(cilium, REPO), [
    "app",
    "sync",
    "cilium",
    "--prune",
    "--async",
  ]);
  assertEquals(syncArgs(app({ name: "m", sources: true }), REPO), [
    "app",
    "sync",
    "m",
    "--prune",
    "--async",
  ]);
});

Deno.test("syncArgs: a trailing slash on the repo root does not double up", () => {
  assertEquals(
    syncArgs(gitops, "/work/homelab/")[4],
    "/work/homelab/charts/gitops",
  );
  assertEquals(syncArgs(gitops, "/work/homelab/")[6], "/work/homelab");
});

Deno.test("syncArgs: a path that escapes the repo root is refused", () => {
  const evil = app({ name: "evil", path: "../../etc" });
  assertThrows(() => syncArgs(evil, REPO), Error, "outside");
});

// ----------------------------------------------------------------------------
// selectApps (--warm / --only)
// ----------------------------------------------------------------------------
Deno.test("selectApps: --warm drops `applications` and everything under it", () => {
  const all = [gitops, bootstrap, addons, applications, cilium, sonarrConfig];
  const names = selectApps(all, { warm: true, only: null }).map((a) =>
    a.metadata.name
  );
  assertEquals(names, ["gitops", "bootstrap", "addons", "cilium"]);
});

Deno.test("selectApps: --only keeps just the named apps, in list order", () => {
  const all = [gitops, bootstrap, addons, cilium];
  const names = selectApps(all, { warm: false, only: ["cilium", "gitops"] })
    .map((a) => a.metadata.name);
  assertEquals(names, ["gitops", "cilium"]);
});

Deno.test("selectApps: --only names that do not exist are simply absent", () => {
  assertEquals(selectApps([gitops], { warm: false, only: ["nope"] }), []);
});

// ----------------------------------------------------------------------------
// isReady (wait)
// ----------------------------------------------------------------------------
Deno.test("isReady: Healthy + Succeeded; --require-synced adds Synced", () => {
  const outOfSync = app({
    name: "a",
    health: "Healthy",
    phase: "Succeeded",
    sync: "OutOfSync",
  });
  assert(isReady(outOfSync, false));
  assert(!isReady(outOfSync, true));
  assert(
    isReady({
      ...outOfSync,
      status: { ...outOfSync.status, sync: { status: "Synced" } },
    }, true),
  );
  assert(
    !isReady(app({ name: "b", health: "Healthy", phase: "Running" }), false),
  );
  assert(
    !isReady(app({ name: "c", health: "Degraded", phase: "Succeeded" }), false),
  );
  assert(!isReady({ metadata: { name: "bare" } }, false));
});

// ----------------------------------------------------------------------------
// setFileArgs / escapeHelmKey
// ----------------------------------------------------------------------------
Deno.test("escapeHelmKey: every dot becomes a backslash-dot", () => {
  assertEquals(
    escapeHelmKey("resource.customizations.health.argoproj.io_Application"),
    "resource\\.customizations\\.health\\.argoproj\\.io_Application",
  );
  assertEquals(escapeHelmKey("plain"), "plain");
});

Deno.test("setFileArgs: one --set-file per Lua file under configs.cm, dots in the group escaped", () => {
  // helm --set-file splits on unescaped dots, so `argoproj.io_Application`
  // would otherwise become configs.cm."resource...argoproj".io_Application.
  const args = setFileArgs([
    "charts/bootstrap/files/health/tailscale.com_Connector.lua",
    "charts/bootstrap/files/health/argoproj.io_Application.lua",
  ]);
  assertEquals(args, [
    "--set-file",
    "configs.cm.resource\\.customizations\\.health\\.argoproj\\.io_Application=charts/bootstrap/files/health/argoproj.io_Application.lua",
    "--set-file",
    "configs.cm.resource\\.customizations\\.health\\.tailscale\\.com_Connector=charts/bootstrap/files/health/tailscale.com_Connector.lua",
  ]);
});

Deno.test("crdsInstallArgs: the CRD chart installs at the pinned version, before ArgoCD, and only waits", () => {
  const args = crdsInstallArgs("30.0.0");
  assertEquals(args.slice(0, 3), [
    "helm",
    "--kube-context",
    "kind-homelab-localdev",
  ]);
  assertEquals(args.slice(3, 7), [
    "upgrade",
    "--install",
    PROMETHEUS_CRDS_RELEASE,
    "prometheus-operator-crds",
  ]);
  assertEquals(args[args.indexOf("--repo") + 1], PROMETHEUS_CRDS_HELM_REPO);
  assertEquals(args[args.indexOf("--version") + 1], "30.0.0");
  assert(args.includes("--wait"));
  // nothing chart-specific: no values file, no --set-file
  assert(!args.includes("-f") && !args.includes("--set-file"));
});

Deno.test("chartVersionFromVersions: reads charts.<key> and names the missing key", () => {
  const text =
    'charts:\n  argocd: "9.7.1"\n  prometheus-operator-crds: "30.0.0"\n';
  assertEquals(
    chartVersionFromVersions(text, "prometheus-operator-crds"),
    "30.0.0",
  );
  assertEquals(chartVersionFromVersions(text, "argocd"), "9.7.1");
  assertThrows(
    () => chartVersionFromVersions(text, "cilium"),
    Error,
    "charts.cilium is not set",
  );
});

Deno.test("setFileArgs: no Lua files means no flags", () => {
  assertEquals(setFileArgs([]), []);
});

Deno.test("setFileArgs: a kind without a group keeps its plain name", () => {
  assertEquals(setFileArgs(["h/ConfigMap.lua"]), [
    "--set-file",
    "configs.cm.resource\\.customizations\\.health\\.ConfigMap=h/ConfigMap.lua",
  ]);
});

// ----------------------------------------------------------------------------
// parseArgs
// ----------------------------------------------------------------------------
Deno.test("parseArgs: subcommand plus flags", () => {
  const a = parseArgs([
    "sync",
    "--warm",
    "--only",
    "gitops,addons",
    "--timeout=5m",
    "--dry-run",
  ]);
  assertEquals(a.command, "sync");
  assert(a.warm);
  assertEquals(a.only, ["gitops", "addons"]);
  assertEquals(a.timeoutMs, 5 * 60_000);
  assert(a.dryRun);
});

Deno.test("parseArgs: wait flags and duration units", () => {
  const a = parseArgs([
    "wait",
    "--require-synced",
    "--exclude",
    "a, b",
    "--timeout",
    "90s",
  ]);
  assertEquals(a.command, "wait");
  assert(a.requireSynced);
  assertEquals(a.exclude, ["a", "b"]);
  assertEquals(a.timeoutMs, 90_000);
});

Deno.test("parseArgs: --help and no command", () => {
  assert(parseArgs(["--help"]).help);
  assert(parseArgs(["sync", "-h"]).help);
  assertEquals(parseArgs([]).command, null);
});

Deno.test("parseArgs: unknown flags and bad durations are argument errors", () => {
  assertThrows(() => parseArgs(["sync", "--bogus"]), Error, "Unknown argument");
  assertThrows(
    () => parseArgs(["sync", "--timeout", "soon"]),
    Error,
    "duration",
  );
  assertThrows(() => parseArgs(["frobnicate"]), Error, "Unknown command");
});

// ----------------------------------------------------------------------------
// Port-forward helpers
// ----------------------------------------------------------------------------
Deno.test("serverFlags: pins the server with plaintext, insecure and grpc-web", () => {
  assertEquals(serverFlags("127.0.0.1:18080"), [
    "--server",
    "127.0.0.1:18080",
    "--plaintext",
    "--insecure",
    "--grpc-web",
  ]);
});

Deno.test("portForwardCmd: kubectl port-forward on the Kind context, loopback only", () => {
  assertEquals(portForwardCmd(18080), [
    "kubectl",
    "--context",
    "kind-homelab-localdev",
    "port-forward",
    "-n",
    "argocd",
    "svc/argocd-server",
    "18080:80",
    "--address",
    "127.0.0.1",
  ]);
});

Deno.test("candidatePorts: preferred first, then consecutive ports, clipped at 65535", () => {
  assertEquals(candidatePorts(18080, 3), [18080, 18081, 18082]);
  assertEquals(candidatePorts(65534, 5), [65534, 65535]);
  assertEquals(candidatePorts(DEFAULT_LOCAL_PORT).length, 20);
});

Deno.test("findFreePort: skips ports the probe reports busy", () => {
  const busy = new Set([18080, 18081]);
  assertEquals(
    findFreePort([18080, 18081, 18082], (p) => !busy.has(p)),
    18082,
  );
  assertEquals(findFreePort([18080], () => true), 18080);
});

Deno.test("findFreePort: fails when every candidate is taken", () => {
  assertThrows(
    () => findFreePort([18080, 18081], () => false),
    Error,
    "no free port",
  );
});

Deno.test("parsePort / --local-port / --server", () => {
  assertEquals(parsePort("18080"), 18080);
  assertThrows(() => parsePort("0"), Error, "invalid port");
  assertThrows(() => parsePort("http"), Error, "invalid port");
  const a = parseArgs(["sync", "--local-port", "19000"]);
  assertEquals(a.localPort, 19000);
  assertEquals(a.server, null);
  const b = parseArgs(["install", "--server=argocd.example:443"]);
  assertEquals(b.server, "argocd.example:443");
  assertEquals(b.localPort, null);
});

// ----------------------------------------------------------------------------
// ArgoCD v3 annotation tracking / automated apps
// ----------------------------------------------------------------------------
Deno.test("parentOf: ArgoCD v3 tracking-id annotation names the parent (no label)", () => {
  // application.resourceTrackingMethod defaults to `annotation` in ArgoCD 3.x:
  // children carry no app.kubernetes.io/instance label at all.
  const child: Application = {
    metadata: {
      name: "bootstrap",
      annotations: {
        "argocd.argoproj.io/sync-wave": "0",
        "argocd.argoproj.io/tracking-id":
          "gitops:argoproj.io/Application:argocd/bootstrap",
      },
    },
  };
  assertEquals(parentOf(child), "gitops");
  assertEquals(tierKey(child, indexApps([gitops, child])), [0, 0]);
});

Deno.test("parentOf: the annotation wins over the label; a self tracking-id is ignored", () => {
  const both: Application = {
    metadata: {
      name: "x",
      labels: { "app.kubernetes.io/instance": "label-parent" },
      annotations: {
        "argocd.argoproj.io/tracking-id":
          "anno-parent:argoproj.io/Application:argocd/x",
      },
    },
  };
  assertEquals(parentOf(both), "anno-parent");
  const selfTracked: Application = {
    metadata: {
      name: "x",
      annotations: { "argocd.argoproj.io/tracking-id": "x:v1/ConfigMap:ns/x" },
    },
  };
  assertEquals(parentOf(selfTracked), null);
});

Deno.test("isAutomated / hasComparisonError / isOperationInProgress", () => {
  assert(!isAutomated(gitops));
  assert(
    isAutomated({
      metadata: { name: "a" },
      spec: { syncPolicy: { automated: {} } },
    }),
  );
  assert(
    isAutomated({
      metadata: { name: "a" },
      spec: { syncPolicy: { automated: { prune: true } } },
    }),
  );
  assert(!hasComparisonError(gitops));
  assert(hasComparisonError({
    metadata: { name: "a" },
    status: {
      conditions: [{ type: "ComparisonError", message: "ksops not found" }],
    },
  }));
  assert(
    isOperationInProgress(
      '{"level":"fatal","msg":"rpc error: code = FailedPrecondition desc = another operation is already in progress"}',
    ),
  );
  assert(
    !isOperationInProgress(
      "Cannot use local sync when Automatic Sync Policy is enabled",
    ),
  );
});

Deno.test("nextTier: on a re-run with every app present, parents still come before children", () => {
  const sops = app({
    name: "sops-secrets",
    wave: "-2",
    parent: "bootstrap",
    path: "charts/secrets/onepassword",
  });
  const all = [sops, cilium, addons, bootstrap, gitops];
  const done = new Set<string>();
  const order: string[] = [];
  for (;;) {
    const tier = nextTier(all, done);
    if (!tier) break;
    for (const a of tier.apps) {
      order.push(a.metadata.name);
      done.add(a.metadata.name);
    }
  }
  assertEquals(order, [
    "gitops",
    "bootstrap",
    "sops-secrets",
    "addons",
    "cilium",
  ]);
});

Deno.test("parentOf via tracking-id feeds tierKey the same way as the label", () => {
  const child: Application = {
    metadata: {
      name: "bootstrap",
      annotations: {
        "argocd.argoproj.io/sync-wave": "0",
        "argocd.argoproj.io/tracking-id":
          "gitops:argoproj.io/Application:argocd/bootstrap",
      },
    },
  };
  assertEquals(tierKey(child, indexApps([gitops, child])), [0, 0]);
});

Deno.test("manifestsArgs: renders a git-path app locally without syncing", () => {
  assertEquals(manifestsArgs(gitops, REPO), [
    "app",
    "manifests",
    "gitops",
    "--local",
    "/work/homelab/charts/gitops",
    "--local-repo-root",
    "/work/homelab",
  ]);
  assertThrows(() => manifestsArgs(cilium, REPO), Error, "not a git-path app");
});

Deno.test("countManifests: counts non-empty YAML documents", () => {
  assertEquals(countManifests(""), 0);
  assertEquals(countManifests("---\n"), 0);
  assertEquals(countManifests("---\n# only a comment\n---\n"), 0);
  assertEquals(countManifests("apiVersion: v1\nkind: ConfigMap\n"), 1);
  assertEquals(
    countManifests(
      "---\napiVersion: v1\nkind: A\n---\napiVersion: v1\nkind: B\n---\n",
    ),
    2,
  );
});

Deno.test("emptyRenderDecision: local manifests → --local sync", () => {
  assertEquals(emptyRenderDecision(3, null), "local");
  assertEquals(emptyRenderDecision(1, 0), "local");
});

Deno.test("emptyRenderDecision: nothing locally and nothing in Git → plain sync of an empty app", () => {
  // 22 child charts (cert-manager-config, sonarr-config, ...) render nothing
  // in localdev by design; a plain sync makes them Synced/Healthy.
  assertEquals(emptyRenderDecision(0, 0), "empty");
});

Deno.test("emptyRenderDecision: nothing locally but manifests in Git → error", () => {
  // ArgoCD would silently apply the Git revision (bootstrap in localdev).
  assertEquals(emptyRenderDecision(0, 7), "error");
  assertEquals(emptyRenderDecision(0, null), "error");
});

Deno.test("emptyRenderDecision: table with the path-in-Git flag", () => {
  // paperclip-dependencies on PR #280: new on the branch, renders nothing in
  // localdev, absent from origin/main. `argocd app manifests` printed nothing
  // (git = 0) yet the plain sync failed with "app path does not exist".
  const cases: Array<
    [number, number | null, boolean, ReturnType<typeof emptyRenderDecision>]
  > = [
    [3, null, true, "local"],
    [1, 0, false, "local"], // local manifests win whatever Git has
    [0, 0, true, "empty"], // existing case: nothing on either side
    [0, 0, false, "new-empty"], // new chart, nothing to deploy: no sync
    [0, null, false, "new-empty"], // Git render failed, but git says absent
    [0, 7, true, "error"], // existing case: Git would be applied
    [0, 7, false, "error"], // manifests from somewhere: fail closed
    [0, null, true, "error"], // existing case: unknown, fail closed
  ];
  for (const [local, git, inGit, want] of cases) {
    assertEquals(
      emptyRenderDecision(local, git, inGit),
      want,
      `local=${local} git=${git} pathInGit=${inGit}`,
    );
  }
});

Deno.test("gitRefForRevision: branches resolve against origin, SHAs as is", () => {
  assertEquals(gitRefForRevision("main"), "origin/main");
  assertEquals(gitRefForRevision("feat/paperclip"), "origin/feat/paperclip");
  assertEquals(gitRefForRevision("origin/main"), "origin/main");
  assertEquals(gitRefForRevision(undefined), "origin/HEAD");
  assertEquals(gitRefForRevision(""), "origin/HEAD");
  assertEquals(gitRefForRevision("HEAD"), "origin/HEAD");
  assertEquals(
    gitRefForRevision("8d8eb0c1afccbdc4ecffad639e5b3e2ac327dde6"),
    "8d8eb0c1afccbdc4ecffad639e5b3e2ac327dde6",
  );
  assertEquals(gitRefForRevision("8d8eb0c"), "8d8eb0c");
  assertEquals(gitRefForRevision("v1.2.3"), "origin/v1.2.3");
});

Deno.test("mentionsMissingPath: ArgoCD's repo-server wording", () => {
  assert(
    mentionsMissingPath(
      "rpc error: code = Unknown desc = Manifest generation error (cached): charts/paperclip-dependencies: app path does not exist",
    ),
  );
  assert(!mentionsMissingPath(""));
  assert(!mentionsMissingPath("another operation is already in progress"));
});

/** The Application ArgoCD shows for a skipped new chart (PR #280 job log). */
function newEmptyApp(name: string): Application {
  return {
    metadata: { name, namespace: "argocd" },
    spec: {
      source: { path: `charts/${name}`, targetRevision: "main" },
      destination: { namespace: "argocd" },
    },
    status: {
      sync: { status: "Unknown" },
      health: { status: "Healthy" },
      resources: [],
      conditions: [{
        type: "ComparisonError",
        message:
          `Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = Manifest generation error (cached): charts/${name}: app path does not exist`,
      }],
    },
  };
}

Deno.test("isNewEmptyApp: Healthy, no operation, no resources, path missing on the target", () => {
  const a = newEmptyApp("paperclip-dependencies");
  assert(isNewEmptyApp(a));
  // Any of the four legs missing → not the new-chart case.
  assert(
    !isNewEmptyApp({
      ...a,
      status: { ...a.status, health: { status: "Missing" } },
    }),
  );
  assert(
    !isNewEmptyApp({
      ...a,
      status: { ...a.status, operationState: { phase: "Error" } },
    }),
  );
  assert(
    !isNewEmptyApp({
      ...a,
      status: { ...a.status, resources: [{ kind: "ConfigMap" }] },
    }),
  );
  assert(
    !isNewEmptyApp({
      ...a,
      status: {
        ...a.status,
        conditions: [{ type: "ComparisonError", message: "some other error" }],
      },
    }),
  );
  assert(!isNewEmptyApp({ ...a, status: { ...a.status, conditions: [] } }));
  assert(!isNewEmptyApp({ metadata: { name: "bare" } }));
  // An ordinary empty child chart (plain-synced) is not it either.
  assert(
    !isNewEmptyApp(
      app({ name: "x", health: "Healthy", phase: "Succeeded", sync: "Synced" }),
    ),
  );
});

Deno.test("isReady: a new chart's Application counts as ready, even with --require-synced", () => {
  const a = newEmptyApp("paperclip-dependencies");
  assert(isReady(a, false));
  assert(isReady(a, true));
});

Deno.test("appsToDiff / statusRows: a new chart's Application is not diffed and is labelled", () => {
  const a = newEmptyApp("paperclip-dependencies");
  const synced = app({
    name: "s",
    path: "charts/s",
    health: "Healthy",
    phase: "Succeeded",
    sync: "Synced",
  });
  const differs = app({
    name: "d",
    path: "charts/d",
    health: "Healthy",
    phase: "Succeeded",
    sync: "OutOfSync",
  });
  // Every git-path app is diffed against the base whatever its sync status
  // (Synced now means "the tree equals the pushed head", not "same as main").
  assertEquals(appsToDiff([a, synced, differs]), ["d", "s"]);
  const rows = statusRows([a, differs]);
  assertEquals(rows.find((r) => r.app === "paperclip-dependencies"), {
    app: "paperclip-dependencies",
    health: "Healthy",
    sync: "Unknown",
    operation: "- (new chart, nothing to sync)",
    vsMain: "not on main",
  });
  // No diff taken for d: the row says so instead of guessing from sync status.
  assertEquals(rows.find((r) => r.app === "d")!.vsMain, "not diffed");
  assertEquals(rows.find((r) => r.app === "d")!.sync, "OutOfSync");
});

Deno.test("appsToDiff: chart-sourced Applications are never diffed (no git revision to render)", () => {
  assertEquals(appsToDiff([gitops, cilium]), ["gitops"]);
  const [row] = statusRows([cilium]);
  assertEquals(row.vsMain, "chart (compared on its parent)");
});

Deno.test("diffArgs: every diff is taken against the base revision", () => {
  assertEquals(diffArgs("addons", "main"), [
    "app",
    "diff",
    "addons",
    "--revision",
    "main",
    "--exit-code=false",
  ]);
  assertEquals(DEFAULT_BASE, "main");
});

// ----------------------------------------------------------------------------
// install --revision: which Git revision the root Application tracks
// ----------------------------------------------------------------------------
Deno.test("branchFromUpstream: strips the remote, keeps slashes in the branch name", () => {
  assertEquals(branchFromUpstream("origin/feat/paperclip"), "feat/paperclip");
  assertEquals(branchFromUpstream("origin/main"), "main");
  assertEquals(branchFromUpstream("upstream/renovate/x"), "renovate/x");
  assertEquals(branchFromUpstream("  origin/main\n"), "main");
  assertEquals(branchFromUpstream(""), null);
  assertEquals(branchFromUpstream("main"), null);
  assertEquals(branchFromUpstream("origin/"), null);
});

Deno.test("chooseRevision: flag, then env, then the upstream branch, then main", () => {
  assertEquals(
    chooseRevision({ flag: "abc1234", env: "x", upstream: "origin/y" }),
    { revision: "abc1234", source: "flag" },
  );
  assertEquals(
    chooseRevision({ flag: null, env: " feat/z ", upstream: "origin/y" }),
    { revision: "feat/z", source: "env" },
  );
  assertEquals(
    chooseRevision({ flag: null, env: undefined, upstream: "origin/y" }),
    { revision: "y", source: "upstream" },
  );
  assertEquals(
    chooseRevision({ flag: null, env: "", upstream: "origin/main" }),
    { revision: "main", source: "upstream" },
  );
  assertEquals(
    chooseRevision({ flag: null, env: undefined, upstream: null }),
    { revision: "main", source: "default" },
  );
  // A flag that is only whitespace counts as absent.
  assertEquals(
    chooseRevision({ flag: "  ", env: undefined, upstream: null }),
    { revision: "main", source: "default" },
  );
});

const ROOT_APP_FIXTURE = `# Root Application for the Kind localdev loop.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: gitops
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/ryanmcafee/homelab.git
    targetRevision: main
    path: charts/gitops
    helm:
      valueFiles:
        - values.yaml
        - values-localdev.yaml
      valuesObject:
        global:
          targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
`;

// deno-lint-ignore no-explicit-any
type Loose = any;

Deno.test("renderRootApp: targetRevision and helm.valuesObject.global.targetRevision follow the revision", () => {
  const sha = "0d96cfd31fb10e66d4fe0628a142edd17c7dd9f9";
  const out = parseYaml(renderRootApp(ROOT_APP_FIXTURE, sha)) as Loose;
  assertEquals(out.spec.source.targetRevision, sha);
  assertEquals(out.spec.source.helm.valuesObject.global.targetRevision, sha);
  // Everything else survives untouched.
  assertEquals(out.metadata.name, "gitops");
  assertEquals(out.spec.source.path, "charts/gitops");
  assertEquals(out.spec.source.helm.valueFiles, [
    "values.yaml",
    "values-localdev.yaml",
  ]);
  assertEquals(out.spec.syncPolicy.syncOptions, [
    "CreateNamespace=true",
    "ServerSideApply=true",
  ]);
  assertEquals(out.metadata.annotations["argocd.argoproj.io/sync-wave"], "0");

  const branch = parseYaml(
    renderRootApp(ROOT_APP_FIXTURE, "feat/paperclip"),
  ) as Loose;
  assertEquals(branch.spec.source.targetRevision, "feat/paperclip");
  assertEquals(
    branch.spec.source.helm.valuesObject.global.targetRevision,
    "feat/paperclip",
  );
});

Deno.test("renderRootApp: creates helm.valuesObject.global when the manifest has no helm block", () => {
  const bare = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: gitops
spec:
  source:
    repoURL: https://github.com/ryanmcafee/homelab.git
    targetRevision: main
    path: charts/gitops
`;
  const out = parseYaml(renderRootApp(bare, "feat/x")) as Loose;
  assertEquals(out.spec.source.targetRevision, "feat/x");
  assertEquals(
    out.spec.source.helm.valuesObject.global.targetRevision,
    "feat/x",
  );
  // A manifest without spec.source is refused rather than silently patched.
  assertThrows(
    () => renderRootApp("apiVersion: v1\nkind: ConfigMap\n", "main"),
    Error,
    "spec.source",
  );
});

Deno.test("syncArgs: plain option drops --local for a git-path app", () => {
  assertEquals(syncArgs(gitops, REPO, { plain: true }), [
    "app",
    "sync",
    "gitops",
    "--prune",
    "--async",
  ]);
  assertEquals(syncArgs(cilium, REPO, { plain: true }), syncArgs(cilium, REPO));
});

// ----------------------------------------------------------------------------
// Lower-tier discovery and parent re-sync (live-run defects)
// ----------------------------------------------------------------------------
Deno.test("appState: a parent with a Succeeded operation but unhealthy children is accepted", () => {
  const parent = app({
    name: "applications",
    health: "Progressing",
    phase: "Succeeded",
    resourceKinds: ["Application"],
  });
  assertEquals(appState(parent), "complete");
  assert(isParentApp(parent));
  assert(!isParentApp(app({ name: "leaf", resourceKinds: ["Deployment"] })));
});

Deno.test("discoverable: apps in a lower tier than the one being waited on are synced immediately", () => {
  // Waiting on applications' wave-12 child [0,3,12] when addons creates its
  // wave-8 children [0,2,8]: those must not wait for the current tier.
  const flaresolverr = app({
    name: "flaresolverr",
    wave: "12",
    parent: "applications",
    chart: "f",
  });
  const trInt = app({
    name: "traefik-internal-config",
    wave: "8",
    parent: "addons",
    path: "charts/traefik-internal-config",
  });
  const trExt = app({
    name: "traefik-external-config",
    wave: "8",
    parent: "addons",
    path: "charts/traefik-external-config",
  });
  const later = app({
    name: "zzz",
    wave: "13",
    parent: "applications",
    chart: "z",
  });
  const all = [gitops, addons, applications, flaresolverr, trInt, trExt, later];
  const done = new Set(["gitops", "addons", "applications"]);
  const active = new Set(["flaresolverr"]);
  const found = discoverable(all, done, active, [0, 3, 12]);
  assertEquals(found.map((a) => a.metadata.name), [
    "traefik-external-config",
    "traefik-internal-config",
  ]);
});

Deno.test("discoverable: nothing when every pending app is in the current or a higher tier", () => {
  const later = app({
    name: "zzz",
    wave: "13",
    parent: "applications",
    chart: "z",
  });
  const same = app({
    name: "same",
    wave: "12",
    parent: "applications",
    chart: "s",
  });
  const all = [gitops, applications, later, same];
  assertEquals(
    discoverable(all, new Set(["gitops", "applications"]), new Set(), [
      0,
      3,
      12,
    ]),
    [],
  );
});

Deno.test("isTierKeyPrefix: a key is a prefix of itself and of its descendants only", () => {
  assert(isTierKeyPrefix([0], [0]));
  assert(isTierKeyPrefix([0], [0, 2, 9]));
  assert(isTierKeyPrefix([0, 2], [0, 2, -5]));
  assert(!isTierKeyPrefix([0, 2], [0, 3]));
  assert(!isTierKeyPrefix([0, 2], [0, 3, 11]));
  assert(!isTierKeyPrefix([0, 2, 9], [0, 2]));
});

Deno.test("tierBlockedBy: addons holding a wave open blocks the applications subtree", () => {
  // CI on PR #280: after addons' wave-6 children completed, its wave 7+
  // children did not exist yet, so nextTier moved on to applications [0,3]
  // and paperclip-database failed on a CNPG CRD that cloudnative-pg (addons
  // wave 10) had not installed. addons [0,2] Running must block [0,3] and
  // every tier under it.
  const awaiting = [{ name: "addons", key: [0, 2] }];
  assertEquals(tierBlockedBy([0, 3], awaiting), "addons");
  assertEquals(tierBlockedBy([0, 3, 11], awaiting), "addons");
});

Deno.test("tierBlockedBy: a parent never blocks its own subtree nor itself", () => {
  const awaiting = [{ name: "addons", key: [0, 2] }];
  assertEquals(tierBlockedBy([0, 2, 7], awaiting), null);
  assertEquals(tierBlockedBy([0, 2, -5], awaiting), null);
  assertEquals(tierBlockedBy([0, 2], awaiting), null);
});

Deno.test("tierBlockedBy: the root gitops holding a wave open blocks nothing", () => {
  const awaiting = [{ name: "gitops", key: [0] }];
  assertEquals(tierBlockedBy([0, 0], awaiting), null);
  assertEquals(tierBlockedBy([0, 2], awaiting), null);
  assertEquals(tierBlockedBy([0, 3, 11], awaiting), null);
});

Deno.test("tierBlockedBy: a parent with a higher key does not block a lower tier", () => {
  // applications [0,3] Running while addons creates a wave-9 child [0,2,9]:
  // that child belongs to an earlier subtree and must be synced now.
  const awaiting = [{ name: "applications", key: [0, 3] }];
  assertEquals(tierBlockedBy([0, 2, 9], awaiting), null);
  assertEquals(tierBlockedBy([0, 2], awaiting), null);
});

Deno.test("tierBlockedBy: with several awaiting parents the lowest one is returned", () => {
  const awaiting = [
    { name: "gitops", key: [0] },
    { name: "addons", key: [0, 2] },
    { name: "bootstrap", key: [0, 0] },
  ];
  assertEquals(tierBlockedBy([0, 3], awaiting), "bootstrap");
  // Same key: sorted by name.
  assertEquals(
    tierBlockedBy([0, 3], [
      { name: "zeta", key: [0, 2] },
      { name: "alpha", key: [0, 2] },
    ]),
    "alpha",
  );
  assertEquals(tierBlockedBy([0, 3], []), null);
});

Deno.test("pendingChildren: children of a parent that are not done", () => {
  const all = [gitops, addons, cilium, traefik];
  assertEquals(
    pendingChildren("addons", all, new Set(["cilium"])).map((a) =>
      a.metadata.name
    ),
    ["traefik"],
  );
  assertEquals(
    pendingChildren("addons", all, new Set(["cilium", "traefik"])),
    [],
  );
});

Deno.test("parentResyncDecision: only a failed parent is considered", () => {
  const okParent = app({
    name: "p",
    phase: "Running",
    resourceKinds: ["Application"],
  });
  assertEquals(parentResyncDecision(okParent, 0, 0), "none");
  const failedLeaf = app({
    name: "l",
    phase: "Failed",
    resourceKinds: ["Deployment"],
  });
  assertEquals(parentResyncDecision(failedLeaf, 0, 0), "none");
});

Deno.test("parentResyncDecision: wait while children are pending, re-sync when they are complete, give up after the limit", () => {
  const failedParent = app({
    name: "applications",
    health: "Degraded",
    phase: "Failed",
    resourceKinds: ["Application", "Application"],
  });
  assertEquals(parentResyncDecision(failedParent, 2, 0), "wait");
  assertEquals(parentResyncDecision(failedParent, 0, 0), "resync");
  assertEquals(parentResyncDecision(failedParent, 0, 2), "resync");
  assertEquals(parentResyncDecision(failedParent, 0, 3), "give-up");
  assertEquals(parentResyncDecision(failedParent, 0, 1, 1), "give-up");
});

Deno.test("degradedChildHint: names the Degraded child Application", () => {
  const parent: Application = {
    metadata: { name: "applications" },
    status: {
      health: { status: "Degraded" },
      operationState: {
        phase: "Failed",
        message:
          "one or more synchronization tasks completed unsuccessfully (retried 5 times)",
      },
      resources: [
        {
          kind: "Application",
          name: "flaresolverr",
          health: { status: "Degraded" },
        },
        { kind: "Application", name: "sonarr", health: { status: "Healthy" } },
      ],
    },
  };
  const hint = degradedChildHint(parent);
  assert(
    hint && hint.includes("flaresolverr") &&
      hint.includes("task localdev:sync"),
  );
  const viaMessage: Application = {
    metadata: { name: "addons" },
    status: {
      health: { status: "Degraded", message: "Application/traefik: Degraded" },
    },
  };
  assert(degradedChildHint(viaMessage));
  assertEquals(degradedChildHint(app({ name: "x", health: "Degraded" })), null);
  assertEquals(degradedChildHint(app({ name: "x", health: "Healthy" })), null);
});

Deno.test("finalPassDecision: Running parents are waited on, never terminated; only Failed/Error re-sync", () => {
  // A Running operation may be executing the PostSync smoke-hook Jobs.
  assertEquals(
    finalPassDecision(
      app({
        name: "applications",
        phase: "Running",
        resourceKinds: ["Application"],
      }),
    ),
    "wait",
  );
  assertEquals(
    finalPassDecision(app({ name: "applications", phase: "Terminating" })),
    "wait",
  );
  assertEquals(
    finalPassDecision(app({ name: "applications", phase: "Succeeded" })),
    "done",
  );
  assertEquals(
    finalPassDecision(app({ name: "applications", phase: "Failed" })),
    "resync",
  );
  assertEquals(
    finalPassDecision(app({ name: "applications", phase: "Error" })),
    "resync",
  );
  assertEquals(finalPassDecision(app({ name: "never-synced" })), "resync");
});

// ============================================================================
// report (issue #261 item 17)
// ============================================================================

// `kubectl get applications.argoproj.io -n argocd -o json` after a Kind loop
// run on a PR: ArgoCD v3 tracking-id annotations, a healthy out-of-sync
// parent, a Degraded child with a Failed operation, a child that is the same
// as main, a Running parent and an app whose path does not exist on main.
const REPORT_APPS_JSON = `{
  "apiVersion": "v1",
  "kind": "List",
  "items": [
    {
      "metadata": {
        "name": "traefik",
        "namespace": "argocd",
        "annotations": {
          "argocd.argoproj.io/sync-wave": "1",
          "argocd.argoproj.io/tracking-id": "addons:argoproj.io/Application:argocd/traefik"
        }
      },
      "spec": { "source": { "chart": "traefik", "repoURL": "https://traefik.github.io/charts" } },
      "status": {
        "health": { "status": "Degraded", "message": "Deployment traefik: 0/1 available" },
        "sync": { "status": "OutOfSync" },
        "operationState": {
          "phase": "Failed",
          "message": "one or more objects failed to apply | reason: Deployment.apps \\"traefik\\" is invalid: spec.template.spec.containers[0].ports[0].containerPort: must be between 1 and 65535\\nsecond line"
        }
      }
    },
    {
      "metadata": {
        "name": "gitops",
        "namespace": "argocd",
        "annotations": { "argocd.argoproj.io/sync-wave": "0" }
      },
      "spec": { "source": { "path": "charts/gitops", "targetRevision": "0d96cfd31fb10e66d4fe0628a142edd17c7dd9f9" } },
      "status": {
        "health": { "status": "Healthy" },
        "sync": { "status": "OutOfSync" },
        "operationState": { "phase": "Succeeded", "message": "successfully synced (all tasks run)" },
        "resources": [{ "kind": "Application", "name": "addons" }]
      }
    },
    {
      "metadata": {
        "name": "cilium",
        "namespace": "argocd",
        "annotations": {
          "argocd.argoproj.io/sync-wave": "-5",
          "argocd.argoproj.io/tracking-id": "addons:argoproj.io/Application:argocd/cilium"
        }
      },
      "spec": { "source": { "chart": "cilium", "repoURL": "https://helm.cilium.io/" } },
      "status": {
        "health": { "status": "Healthy" },
        "sync": { "status": "Synced" },
        "operationState": { "phase": "Succeeded" }
      }
    },
    {
      "metadata": {
        "name": "addons",
        "namespace": "argocd",
        "annotations": {
          "argocd.argoproj.io/sync-wave": "2",
          "argocd.argoproj.io/tracking-id": "gitops:argoproj.io/Application:argocd/addons"
        }
      },
      "spec": { "source": { "path": "charts/addons", "targetRevision": "main" } },
      "status": {
        "health": { "status": "Healthy" },
        "sync": { "status": "OutOfSync" },
        "operationState": { "phase": "Succeeded" },
        "resources": [{ "kind": "Application", "name": "cilium" }, { "kind": "Application", "name": "traefik" }]
      }
    },
    {
      "metadata": {
        "name": "applications",
        "namespace": "argocd",
        "annotations": {
          "argocd.argoproj.io/sync-wave": "3",
          "argocd.argoproj.io/tracking-id": "gitops:argoproj.io/Application:argocd/applications"
        }
      },
      "spec": { "source": { "path": "charts/applications", "targetRevision": "main" } },
      "status": {
        "health": { "status": "Progressing" },
        "sync": { "status": "Synced" },
        "operationState": { "phase": "Running", "message": "waiting for healthy state of argoproj.io/Application/agent-readonly" }
      }
    },
    {
      "metadata": {
        "name": "agent-readonly",
        "namespace": "argocd",
        "annotations": {
          "argocd.argoproj.io/sync-wave": "1",
          "argocd.argoproj.io/tracking-id": "applications:argoproj.io/Application:argocd/agent-readonly"
        }
      },
      "spec": { "source": { "path": "charts/agent-readonly", "targetRevision": "main" } },
      "status": {
        "health": { "status": "Healthy" },
        "sync": { "status": "Unknown" },
        "operationState": { "phase": "Succeeded" },
        "conditions": [{ "type": "ComparisonError", "message": "charts/agent-readonly: app path does not exist" }]
      }
    }
  ]
}`;

const reportApps = (JSON.parse(REPORT_APPS_JSON) as { items: Application[] })
  .items;

// `task verify LEVEL=2 | tee verify-level2.json` on a failing run: the JSON
// object, then task's own failure line.
const VERIFY_FINDINGS = Array.from(
  { length: REPORT_MAX_FINDINGS + 5 },
  (_, i) => `Deployment traefik/traefik: finding ${i + 1}`,
);
const VERIFY_LEVEL2_TEXT = `${
  JSON.stringify(
    {
      level: 2,
      checks: [
        { name: "argocd/cilium", status: "pass", duration_ms: 3 },
        {
          name: "argocd/traefik",
          status: "fail",
          duration_ms: 4,
          detail: "health Degraded, operation Failed",
          findings: VERIFY_FINDINGS,
        },
        { name: "e2e/traefik", status: "skip", duration_ms: 0 },
        { name: "render/localdev/addons", status: "pass", duration_ms: 120 },
      ],
      pass: false,
      duration_ms: 431_000,
    },
    null,
    2,
  )
}\ntask: Failed to run task "verify": exit status 1\n`;

// Raw `argocd app diff addons --exit-code=false` with KUBECTL_EXTERNAL_DIFF=
// "diff -u": argocd runs `diff <live> <target>`, so `-` is the PR (live in
// Kind) and `+` is main (the target revision).
const RAW_ADDONS_DIFF = `
===== argoproj.io/Application argocd/traefik ======
--- /tmp/argocd-diff123/traefik-live.yaml\t2026-09-13 10:00:00.000000000 +0000
+++ /tmp/argocd-diff123/traefik\t2026-09-13 10:00:00.000000000 +0000
@@ -10,6 +10,6 @@ spec:
     helm:
       valuesObject:
         ports:
-          web: 8081
+          web: 8080
     chart: traefik
-    targetRevision: 39.1.0
+    targetRevision: 39.0.9
@@ -30 +30 @@
--- a line whose content starts with three dashes
+--- the same on main
===== /ConfigMap traefik/new-in-pr ======
--- /tmp/argocd-diff123/new-in-pr-live.yaml\t2026-09-13 10:00:00.000000000 +0000
+++ /tmp/argocd-diff123/new-in-pr\t2026-09-13 10:00:00.000000000 +0000
@@ -1,3 +0,0 @@
-apiVersion: v1
-kind: ConfigMap
-data: {}
`;

function diffOf(app: string, lines: number, width = 40): AppDiff {
  const body = Array.from(
    { length: lines },
    (_, i) => `+  line-${i}: ${"x".repeat(width)}`,
  );
  return {
    app,
    diff: [`===== /ConfigMap ns/${app} ======`, ...body].join("\n"),
  };
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

Deno.test("parseArgs: report flags and their defaults", () => {
  const d = parseArgs(["report"]);
  assertEquals(d.command, "report");
  assertEquals(d.out, null);
  assertEquals(d.verifyJson, null);
  assertEquals(d.maxDiffBytes, DEFAULT_MAX_DIFF_BYTES);
  assertEquals(d.noDiff, false);
  const a = parseArgs([
    "report",
    "--out",
    "kind-report.md",
    "--verify-json=verify-level2.json",
    "--max-diff-bytes",
    "1000",
    "--no-diff",
    "--local-port",
    "19000",
  ]);
  assertEquals(a.out, "kind-report.md");
  assertEquals(a.verifyJson, "verify-level2.json");
  assertEquals(a.maxDiffBytes, 1000);
  assert(a.noDiff);
  assertEquals(a.localPort, 19000);
  assertEquals(parseArgs(["report", "--max-diff-bytes=0"]).maxDiffBytes, 0);
  // report --base: the revision every diff is taken against (default: main,
  // resolved at run time so the env var can still override).
  assertEquals(d.base, null);
  assertEquals(parseArgs(["report", "--base", "release"]).base, "release");
  assertEquals(parseArgs(["report", "--base=main"]).base, "main");
  assertThrows(
    () => parseArgs(["report", "--base"]),
    Error,
    "requires a value",
  );
});

Deno.test("parseArgs: install --revision", () => {
  assertEquals(parseArgs(["install"]).revision, null);
  assertEquals(
    parseArgs(["install", "--revision", "feat/paperclip"]).revision,
    "feat/paperclip",
  );
  assertEquals(
    parseArgs(["install", "--revision=abc1234"]).revision,
    "abc1234",
  );
  assertThrows(
    () => parseArgs(["install", "--revision"]),
    Error,
    "requires a value",
  );
});

Deno.test("parseArgs: a bad --max-diff-bytes is an argument error", () => {
  assertThrows(
    () => parseArgs(["report", "--max-diff-bytes", "-1"]),
    Error,
    "invalid byte count",
  );
  assertThrows(
    () => parseArgs(["report", "--max-diff-bytes=lots"]),
    Error,
    "invalid byte count",
  );
  assertThrows(() => parseByteCount("1.5"), Error, "invalid byte count");
  assertEquals(parseByteCount("50000"), 50000);
  assertThrows(() => parseArgs(["report", "--out"]), Error, "requires a value");
});

Deno.test("extractJsonObject: whole text, or the object before task's trailing error line", () => {
  assertEquals(extractJsonObject('{"a":1}'), { a: 1 });
  assertEquals(
    extractJsonObject(
      '{\n  "a": 1\n}\ntask: Failed to run task "verify": exit status 1\n',
    ),
    { a: 1 },
  );
  assertEquals(extractJsonObject("no json here"), null);
  assertEquals(extractJsonObject('{\n  "a": [1,\n'), null);
});

Deno.test("parseVerifyJson: a failing level-2 run with task's trailing error line", () => {
  const v = parseVerifyJson(VERIFY_LEVEL2_TEXT);
  assert(v.ok);
  assertEquals(v.result.level, 2);
  assertEquals(v.result.pass, false);
  assertEquals(v.result.checks.length, 4);
});

Deno.test("parseVerifyJson: missing, empty and cut-short files become reasons, never throws", () => {
  const missing = parseVerifyJson(null, "verify-level2.json");
  assert(!missing.ok);
  assertStringIncludes(missing.reason, "was not written");
  const empty = parseVerifyJson("  \n");
  assert(!empty.ok);
  assertStringIncludes(empty.reason, "is empty");
  const partial = parseVerifyJson(VERIFY_LEVEL2_TEXT.slice(0, 200));
  assert(!partial.ok);
  assertStringIncludes(partial.reason, "cut short");
  const noChecks = parseVerifyJson('{"level":2,"pass":true}');
  assert(!noChecks.ok);
});

Deno.test("parseVerifyJson: malformed check entries are dropped", () => {
  const v = parseVerifyJson(
    '{"level":2,"pass":true,"checks":[null,{"status":"pass"},{"name":"x","status":"pass"}]}',
  );
  assert(v.ok);
  assertEquals(v.result.checks.map((c) => c.name), ["x"]);
});

Deno.test("treeOrder / appsToDiff: tree order; every git-path app is diffed, whatever its sync status", () => {
  assertEquals(treeOrder(reportApps).map((a) => a.metadata.name), [
    "gitops",
    "addons",
    "cilium",
    "traefik",
    "applications",
    "agent-readonly",
  ]);
  // cilium and traefik are chart sources (no git revision to render at the
  // base) and are compared on their parent's diff instead; applications is
  // Synced but still diffed against the base.
  assertEquals(appsToDiff(reportApps), [
    "gitops",
    "addons",
    "applications",
    "agent-readonly",
  ]);
});

Deno.test("statusRows: health, sync, last operation and vs base per Application", () => {
  const addonsDiff = classifyDiffResult("addons", 0, RAW_ADDONS_DIFF, "");
  const diffs = new Map<string, AppDiff>([
    ["gitops", { app: "gitops", diff: "" }],
    ["addons", addonsDiff],
    ["applications", { app: "applications", diff: "", error: "boom" }],
    [
      "agent-readonly",
      { app: "agent-readonly", diff: "", error: "app path does not exist" },
    ],
  ]);
  const rows = statusRows(reportApps, diffs);
  const by = new Map(rows.map((r) => [r.app, r]));
  assertEquals(rows.map((r) => r.app)[0], "gitops");
  // An empty diff against the base is "same as main", whatever the sync status.
  assertEquals(by.get("gitops"), {
    app: "gitops",
    health: "Healthy",
    sync: "OutOfSync",
    operation: "Succeeded",
    vsMain: "same as main",
  });
  assertEquals(by.get("addons")!.vsMain, "differs · +6 -3");
  assertEquals(by.get("cilium")!.vsMain, "chart (compared on its parent)");
  assertEquals(by.get("cilium")!.sync, "Synced");
  assertEquals(by.get("applications")!.health, "Progressing");
  assert(by.get("applications")!.operation.startsWith("Running: waiting for"));
  assertEquals(by.get("applications")!.vsMain, "diff unavailable");
  // Failed operation: first line of the message, clipped to the cell width.
  const traefik = by.get("traefik")!;
  assertEquals(traefik.health, "Degraded");
  assert(traefik.operation.startsWith("Failed: one or more objects"));
  assert(traefik.operation.length <= 80 && traefik.operation.endsWith("…"));
  assert(!traefik.operation.includes("second line"));
  // traefik is a chart source (no git revision to render at the base).
  assertEquals(traefik.vsMain, "chart (compared on its parent)");
  // The base's missing-path error means the chart is new in this PR.
  assertEquals(by.get("agent-readonly")!.vsMain, "not on main");
  assertEquals(by.get("agent-readonly")!.sync, "Unknown");
  // Another base name flows into the labels.
  const rel = statusRows(reportApps, diffs, "release");
  assertEquals(rel.find((r) => r.app === "gitops")!.vsMain, "same as release");
  assertEquals(
    rel.find((r) => r.app === "agent-readonly")!.vsMain,
    "not on release",
  );
});

Deno.test("statusRows: a truncated diff keeps its marker", () => {
  const diffs = new Map<string, AppDiff>([
    ["addons", {
      app: "addons",
      diff: "===== v1/ConfigMap a/b ======\n-x\n+y",
      originalBytes: 5000,
      omittedLines: 9,
    }],
  ]);
  const row = statusRows(reportApps, diffs).find((r) => r.app === "addons")!;
  assertEquals(row.vsMain, "differs · +1 -1 (truncated)");
});

Deno.test("statusRows: fieldless apps never throw", () => {
  assertEquals(statusRows([{ metadata: { name: "bare" } }]), [
    {
      app: "bare",
      health: "Unknown",
      sync: "Unknown",
      operation: "-",
      vsMain: "chart (compared on its parent)",
    },
  ]);
});

Deno.test("invertUnifiedDiff: main becomes `-`, the PR `+`; temp-file headers dropped", () => {
  const inv = invertUnifiedDiff(RAW_ADDONS_DIFF);
  const lines = inv.split("\n");
  assert(!lines.some((l) => l.includes("/tmp/argocd-diff")));
  assert(lines.includes("-          web: 8080"));
  assert(lines.includes("+          web: 8081"));
  assert(lines.includes("-    targetRevision: 39.0.9"));
  assert(lines.includes("+    targetRevision: 39.1.0"));
  // Hunk ranges swap; a missing count stays missing.
  assert(lines.includes("@@ -10,6 +10,6 @@ spec:"));
  assert(lines.includes("@@ -30 +30 @@"));
  // Content that starts with "--- " inside a hunk is content, not a header.
  assert(lines.includes("+-- a line whose content starts with three dashes"));
  assert(lines.includes("---- the same on main"));
  // A resource only the PR has: every line is an addition.
  assert(lines.includes("@@ -0,0 +1,3 @@"));
  assert(lines.includes("+kind: ConfigMap"));
  assert(lines.includes("===== /ConfigMap traefik/new-in-pr ======"));
});

Deno.test("invertUnifiedDiff: context lines and no-newline markers are kept", () => {
  const raw =
    "@@ -1,3 +1,3 @@\n a: 1\n-b: live\n\\ No newline at end of file\n+b: main\n c: 3\n";
  assertEquals(
    invertUnifiedDiff(raw),
    "@@ -1,3 +1,3 @@\n a: 1\n+b: live\n\\ No newline at end of file\n-b: main\n c: 3\n",
  );
  assertEquals(invertUnifiedDiff(""), "");
});

Deno.test("invertUnifiedDiff: within a changed run, main's lines come before the PR's", () => {
  const raw = "@@ -1,3 +1,2 @@\n-a: live\n-b: live\n+a: main\n c: 1";
  assertEquals(
    invertUnifiedDiff(raw),
    "@@ -1,2 +1,3 @@\n-a: main\n+a: live\n+b: live\n c: 1",
  );
  // A hunk that ends on a changed line is flushed too.
  assertEquals(
    invertUnifiedDiff("@@ -1 +1 @@\n-x: live\n+x: main"),
    "@@ -1 +1 @@\n-x: main\n+x: live",
  );
});

Deno.test("diffStats: resources and +/- lines of an inverted diff", () => {
  const inv = invertUnifiedDiff(RAW_ADDONS_DIFF);
  assertEquals(diffStats(inv), { resources: 2, added: 6, removed: 3 });
  assertEquals(diffStats(""), { resources: 0, added: 0, removed: 0 });
});

Deno.test("argocdErrorMessage: the msg of argocd's JSON fatal line, or the first text line", () => {
  assertEquals(
    argocdErrorMessage(
      '{"level":"info","msg":"connecting"}\n{"level":"fatal","msg":"rpc error: code = Unknown desc = charts/agent-readonly: app path does not exist","time":"2026-09-13T10:00:00Z"}\n',
    ),
    "rpc error: code = Unknown desc = charts/agent-readonly: app path does not exist",
  );
  assertEquals(
    argocdErrorMessage("\nargocd: command not found\n"),
    "argocd: command not found",
  );
  assertEquals(argocdErrorMessage(""), "");
});

Deno.test("classifyDiffResult: 0 and 1-with-output are diffs, anything else an error", () => {
  const ok = classifyDiffResult("addons", 0, RAW_ADDONS_DIFF, "");
  assertEquals(ok.error, undefined);
  assert(ok.diff.startsWith("===== argoproj.io/Application argocd/traefik"));
  assertEquals(classifyDiffResult("x", 0, "", ""), { app: "x", diff: "" });
  assertEquals(
    classifyDiffResult("x", 1, RAW_ADDONS_DIFF, "").error,
    undefined,
  );
  const err = classifyDiffResult(
    "agent-readonly",
    20,
    "",
    '{"level":"fatal","msg":"app path does not exist"}',
  );
  assertEquals(err, {
    app: "agent-readonly",
    diff: "",
    error: "app path does not exist",
  });
  assertEquals(
    classifyDiffResult("y", 127, "", "").error,
    "argocd app diff exited 127",
  );
});

Deno.test("truncateDiffs: under the budget nothing changes", () => {
  const diffs = [diffOf("a", 3), diffOf("b", 5)];
  const out = truncateDiffs(diffs, 100_000);
  assertEquals(out, diffs);
  assert(out[0] !== diffs[0], "returns copies");
  assertEquals(truncateDiffs(diffs, 0), diffs, "0 = unlimited");
});

Deno.test("truncateDiffs: a big diff is cut at a line boundary; small diffs stay whole", () => {
  const small = diffOf("small", 3);
  const big = diffOf("big", 5000); // ~260 KB
  const tiny = { app: "tiny", diff: "" };
  const budget = 20_000;
  const out = truncateDiffs([big, small, tiny], budget);
  assertEquals(out.map((d) => d.app), ["big", "small", "tiny"]);
  assertEquals(out[1], small);
  assertEquals(out[2], tiny);
  const cut = out[0];
  assertEquals(cut.originalBytes, bytes(big.diff));
  assert(bytes(cut.diff) <= budget - bytes(small.diff));
  assert(bytes(cut.diff) > budget - bytes(small.diff) - 200, "budget is used");
  assert(big.diff.startsWith(cut.diff + "\n"), "whole lines only");
  assertEquals(
    cut.omittedLines,
    big.diff.split("\n").length - cut.diff.split("\n").length,
  );
  const total = out.reduce((n, d) => n + bytes(d.diff), 0);
  assert(total <= budget);
  // The input is not mutated.
  assertEquals(big.originalBytes, undefined);
});

Deno.test("truncateDiffs: two big diffs share the budget equally", () => {
  const out = truncateDiffs([diffOf("a", 2000), diffOf("b", 3000)], 10_000);
  for (const d of out) {
    assert(d.originalBytes !== undefined);
    assert(bytes(d.diff) <= 5_000 && bytes(d.diff) > 4_900);
  }
});

Deno.test("truncateDiffs: the budget counts UTF-8 bytes, not characters", () => {
  const d = {
    app: "u",
    diff: Array.from({ length: 100 }, () => "+ é€漢字").join("\n"),
  };
  const out = truncateDiffs([d], 300);
  assert(bytes(out[0].diff) <= 300);
  assert(out[0].diff.length < 300, "multi-byte characters cost more than 1");
});

Deno.test("mdCell / fenceFor: table cells and code fences cannot be broken out of", () => {
  assertEquals(mdCell("a | b\nc <x> & y"), "a \\| b c &lt;x&gt; &amp; y");
  assertEquals(fenceFor("plain"), "```");
  assertEquals(fenceFor("has ``` inside"), "````");
  assertEquals(fenceFor("has ````` inside"), "``````");
});

function fullReport(maxDiffBytes = DEFAULT_MAX_DIFF_BYTES): string {
  const verify = parseVerifyJson(VERIFY_LEVEL2_TEXT);
  const diffs = truncateDiffs([
    { app: "gitops", diff: "" },
    classifyDiffResult("addons", 0, RAW_ADDONS_DIFF, ""),
    diffOf("traefik", 5000),
    { app: "agent-readonly", diff: "", error: "app path does not exist" },
  ], maxDiffBytes);
  return renderReport({
    apps: reportApps,
    verify,
    diffs,
    meta: {
      sha: "0123456789abcdef0123",
      runUrl: "https://github.com/o/r/actions/runs/1",
    },
  });
}

Deno.test("renderReport: title, pass/fail line, table, failing checks and one collapsed diff per app", () => {
  const md = fullReport();
  assert(md.startsWith(`## ${REPORT_TITLE}\n`));
  assertStringIncludes(
    md,
    "**Level 2:** FAIL ❌ · 4 checks: 2 pass, 1 fail, 1 skip · 7m11s",
  );
  assertStringIncludes(
    md,
    "Commit `0123456789ab` · [workflow run](https://github.com/o/r/actions/runs/1)",
  );
  assertStringIncludes(md, "on its parent's diff");
  // The head every Application tracks comes from the live root Application.
  assertStringIncludes(md, "tracks `0d96cfd31fb1`");
  assertStringIncludes(md, "`argocd app diff --revision main`");
  assertStringIncludes(
    md,
    "| Application | Health | Sync | Last operation | vs main |",
  );
  assertStringIncludes(
    md,
    "| cilium | Healthy | Synced | Succeeded | chart (compared on its parent) |",
  );
  assertStringIncludes(
    md,
    "| gitops | Healthy | OutOfSync | Succeeded | same as main |",
  );
  assertStringIncludes(
    md,
    "| addons | Healthy | OutOfSync | Succeeded | differs · +6 -3 |",
  );
  assertStringIncludes(
    md,
    "| traefik | Degraded | OutOfSync | Failed: one or more objects failed to apply \\| reason:",
  );
  assertStringIncludes(
    md,
    "| agent-readonly | Healthy | Unknown | Succeeded | not on main |",
  );
  assertStringIncludes(
    md,
    "6 Applications · 4 Healthy · 2 not Healthy · 4 not Synced with `0d96cfd31fb1`",
  );
  // Failing checks: the detail and the capped findings.
  assertStringIncludes(md, "### Failing checks (1)");
  assertStringIncludes(md, "#### `argocd/traefik`");
  assertStringIncludes(md, "health Degraded, operation Failed");
  assertStringIncludes(
    md,
    `- Deployment traefik/traefik: finding ${REPORT_MAX_FINDINGS}\n`,
  );
  assert(!md.includes(`finding ${REPORT_MAX_FINDINGS + 1}\n`));
  assertStringIncludes(md, "… 5 more finding(s)");
  assert(!md.includes("argocd/cilium"), "passing checks are not listed");
  // Diffs.
  assertStringIncludes(
    md,
    "<details><summary><code>addons</code> · 2 resource(s) · +6 -3</summary>",
  );
  assertStringIncludes(
    md,
    "```diff\n===== argoproj.io/Application argocd/traefik ======",
  );
  // An empty diff against the base is "same as main" in the table and gets
  // no collapsed block: the sync status no longer says anything about main.
  assert(!md.includes("<code>gitops</code>"));
  assert(!md.includes("no resource diff"));
  // A path absent from the base is labelled like the table, not as an error.
  assertStringIncludes(md, "<code>agent-readonly</code> · not on main");
  assertStringIncludes(
    md,
    "does not exist on `main`: everything it deploys is new in this PR",
  );
  assert(!md.includes("diff unavailable"));
  assertStringIncludes(md, "<code>traefik</code> · 1 resource(s)");
  assertStringIncludes(md, "· truncated</summary>");
  assertStringIncludes(
    md,
    "line(s) omitted). Full diff: `task localdev:report -- --max-diff-bytes 0`",
  );
  assertStringIncludes(md, "or `argocd app diff traefik --revision main`");
  assertEquals(md.split("<details>").length - 1, 3);
  assertEquals(md.split("</details>").length - 1, 3);
});

Deno.test("renderReport: --base names the branch everywhere", () => {
  const md = renderReport({
    apps: reportApps,
    verify: parseVerifyJson(null),
    diffs: [
      { app: "gitops", diff: "" },
      { app: "agent-readonly", diff: "", error: "app path does not exist" },
    ],
    base: "release",
  });
  assertStringIncludes(md, "| vs release |");
  assertStringIncludes(md, "### Diffs vs release");
  assertStringIncludes(md, "`argocd app diff --revision release`");
  assertStringIncludes(md, "| same as release |");
  assertStringIncludes(md, "| not on release |");
  assertStringIncludes(md, "<code>agent-readonly</code> · not on release");
  assertStringIncludes(md, "does not exist on `release`: everything");
  assert(!md.includes("vs main"));
});

Deno.test("renderReport: a huge diff keeps the comment under GitHub's 65536-character limit", () => {
  const md = fullReport();
  assert(md.length < 65_536, `report is ${md.length} characters`);
  const unlimited = fullReport(0);
  assert(unlimited.length > 200_000, "0 = unlimited keeps the full diff");
  assert(!unlimited.includes("Truncated:"));
});

Deno.test("renderReport: missing verify JSON is reported, the rest still renders", () => {
  const md = renderReport({
    apps: reportApps,
    verify: parseVerifyJson(null, "verify-level2.json"),
    diffs: [],
    diffNote: "Diffs skipped (`--no-diff`).",
  });
  assertStringIncludes(
    md,
    "**Level 2:** no result · `verify-level2.json` was not written",
  );
  assert(!md.includes("### Failing checks"));
  assertStringIncludes(
    md,
    "| gitops | Healthy | OutOfSync | Succeeded | not diffed |",
  );
  assertStringIncludes(md, "### Diffs vs main\n\nDiffs skipped (`--no-diff`).");
});

Deno.test("renderReport: ArgoCD not reachable (localdev:ci failed early) says so instead of failing", () => {
  const verify: VerifyInput = parseVerifyJson(null);
  const md = renderReport({
    apps: null,
    appsError:
      'kubectl get applications failed: error: context "kind-homelab-localdev" does not exist',
    verify,
    diffs: [],
  });
  assertStringIncludes(md, "**ArgoCD was not reachable**");
  assertStringIncludes(md, "`task localdev:ci` failed before ArgoCD was up");
  assert(!md.includes("| Application |"));
  assert(!md.includes("### Diffs vs main"));
  assert(md.endsWith("\n") && !md.endsWith("\n\n"));
});

Deno.test("renderReport: every diff empty means nothing changes vs main; no Applications is explained", () => {
  const synced = reportApps.map((a) => ({
    ...a,
    status: { ...a.status, sync: { status: "Synced" } },
  }));
  const pass = parseVerifyJson(
    '{"level":2,"pass":true,"duration_ms":1500,"checks":[{"name":"a","status":"pass"}]}',
  );
  // Diffs were taken (empty ones) for every git-path app: nothing differs.
  const md = renderReport({
    apps: synced,
    verify: pass,
    diffs: appsToDiff(synced).map((app) => ({ app, diff: "" })),
  });
  assertStringIncludes(
    md,
    "**Level 2:** PASS ✅ · 1 checks: 1 pass, 0 fail, 0 skip · 2s",
  );
  assertStringIncludes(md, "0 not Synced with `0d96cfd31fb1`");
  assertStringIncludes(md, "No Application differs from `main`");
  assert(!md.includes("<details>"));
  const none = renderReport({ apps: [], verify: pass, diffs: [] });
  assertStringIncludes(none, "No Applications in namespace `argocd`");
  assert(!none.includes("### Diffs vs main"));
});

Deno.test("renderReport: diff content with backtick fences cannot close the code block", () => {
  const md = renderReport({
    apps: reportApps,
    verify: parseVerifyJson(null),
    diffs: [{
      app: "gitops",
      diff: "+  readme: |\n+    ```sh\n+    task up\n+    ```",
    }],
  });
  assertStringIncludes(md, "````diff\n+  readme: |");
});

Deno.test("parentsAwaitingWaves: only parents with a Running operation, sorted", () => {
  const mk = (
    name: string,
    phase: string | undefined,
    parent: boolean,
  ): Application =>
    ({
      metadata: { name },
      status: {
        operationState: phase ? { phase } : undefined,
        resources: parent
          ? [{ kind: "Application", name: `${name}-child` }]
          : [],
      },
    }) as unknown as Application;
  const apps = [
    mk("traefik-external", "Running", false), // not a parent
    mk("addons", "Running", true), // holding wave 7 open
    mk("gitops", "Succeeded", true), // settled
    mk("applications", "Running", true),
    mk("bootstrap", undefined, true), // never synced
  ];
  assertEquals(parentsAwaitingWaves(apps), ["addons", "applications"]);
  assertEquals(parentsAwaitingWaves([mk("gitops", "Succeeded", true)]), []);
});

// ----------------------------------------------------------------------------
// diagnose: namespaces, resource lines, describe targets
// ----------------------------------------------------------------------------

// PR #280's CI run: `applications` and `gitops` Progressing on their child
// Applications (destination argocd), `paperclip` Progressing/Succeeded on its
// single resource, an Instance whose per-resource health ArgoCD omitted.
function unhealthyApps(): Application[] {
  const applications = app({ name: "applications", health: "Progressing" });
  applications.status!.resources = [
    { group: "argoproj.io", kind: "Application", name: "paperclip" },
    {
      group: "argoproj.io",
      kind: "Application",
      name: "sonarr",
      health: { status: "Healthy" },
    },
  ];
  const gitops = app({ name: "gitops", health: "Progressing" });
  gitops.status!.resources = [
    {
      group: "argoproj.io",
      kind: "Application",
      name: "applications",
      health: { status: "Progressing" },
    },
  ];
  const paperclip = app({
    name: "paperclip",
    health: "Progressing",
    phase: "Succeeded",
  });
  paperclip.spec!.destination = { namespace: "paperclip" };
  paperclip.status!.resources = [
    {
      group: "paperclip.inc",
      kind: "Instance",
      namespace: "paperclip",
      name: "paperclip",
    },
  ];
  return [applications, gitops, paperclip];
}

Deno.test("diagnoseNamespaces: every unhealthy app's destination namespace, workload namespaces before argocd", () => {
  assertEquals(diagnoseNamespaces(unhealthyApps()), ["paperclip", "argocd"]);
});

Deno.test("diagnoseNamespaces: unhealthy resource namespaces are added, Healthy ones and child Applications are not", () => {
  const a = app({ name: "media", health: "Degraded" });
  a.spec!.destination = { namespace: "media" };
  a.status!.resources = [
    { kind: "Secret", namespace: "shared", name: "s" }, // no health → included
    {
      kind: "Deployment",
      group: "apps",
      namespace: "media-dl",
      name: "d",
      health: { status: "Degraded" },
    },
    {
      kind: "Service",
      namespace: "healthy-ns",
      name: "svc",
      health: { status: "Healthy" },
    },
    {
      group: "argoproj.io",
      kind: "Application",
      namespace: "child-ns",
      name: "child",
      health: { status: "Progressing" },
    },
  ];
  assertEquals(diagnoseNamespaces([a]), ["media", "media-dl", "shared"]);
  assertEquals(diagnoseNamespaces([a, a]), ["media", "media-dl", "shared"]);
  assertEquals(diagnoseNamespaces([]), []);
});

Deno.test("describeTargets: custom resources only — Applications and core kinds excluded, missing health included", () => {
  const apps = unhealthyApps();
  apps[2].status!.resources!.push(
    { kind: "ConfigMap", namespace: "paperclip", name: "cm" },
    {
      group: "postgresql.cnpg.io",
      kind: "Cluster",
      namespace: "paperclip",
      name: "db",
      health: { status: "Healthy" },
    },
    {
      group: "apps",
      kind: "StatefulSet",
      namespace: "paperclip",
      name: "operator",
      health: { status: "Progressing", message: "0/1" },
    },
  );
  assertEquals(describeTargets(apps), [
    {
      group: "paperclip.inc",
      kind: "Instance",
      ns: "paperclip",
      name: "paperclip",
    },
    { group: "apps", kind: "StatefulSet", ns: "paperclip", name: "operator" },
  ]);
  assertEquals(describeTargets([apps[2], apps[2]]).length, 2);
  assertEquals(describeTargets([]), []);
});

Deno.test("describeTargets: a resource without its own namespace falls back to the destination", () => {
  const a = app({ name: "x", health: "Progressing" });
  a.spec!.destination = { namespace: "x-ns" };
  a.status!.resources = [{ group: "g.io", kind: "Thing", name: "t" }];
  assertEquals(describeTargets([a]), [
    { group: "g.io", kind: "Thing", ns: "x-ns", name: "t" },
  ]);
});

Deno.test("describeArgs: kind.group singular form, namespaced or not", () => {
  assertEquals(
    describeArgs({
      group: "paperclip.inc",
      kind: "Instance",
      ns: "paperclip",
      name: "paperclip",
    }),
    ["describe", "instance.paperclip.inc", "paperclip", "-n", "paperclip"],
  );
  assertEquals(
    describeArgs({ group: "", kind: "Node", ns: "", name: "worker-1" }),
    ["describe", "Node", "worker-1"],
  );
});

Deno.test("resourceLines: a not-Healthy app lists every resource, health or not", () => {
  const [, , paperclip] = unhealthyApps();
  assertEquals(resourceLines(paperclip), [
    "paperclip.inc/Instance paperclip/paperclip: -",
  ]);
  paperclip.status!.resources!.push({
    group: "apps",
    kind: "StatefulSet",
    namespace: "paperclip",
    name: "operator",
    health: { status: "Progressing", message: "Waiting for 1 pods" },
  });
  assertEquals(resourceLines(paperclip), [
    "paperclip.inc/Instance paperclip/paperclip: -",
    "apps/StatefulSet paperclip/operator: Progressing — Waiting for 1 pods",
  ]);
});

Deno.test("resourceLines: a Healthy app (failed operation) lists only resources that are not Healthy", () => {
  const a = app({ name: "h", health: "Healthy", phase: "Failed" });
  a.status!.resources = [
    { kind: "ConfigMap", name: "ok", health: { status: "Healthy" } },
    {
      kind: "Job",
      group: "batch",
      name: "smoke",
      health: { status: "Degraded" },
    },
    { kind: "Secret", name: "nohealth" },
  ];
  assertEquals(resourceLines(a), [
    "batch/Job argocd/smoke: Degraded",
    "Secret argocd/nohealth: -",
  ]);
  assertEquals(resourceLines(app({ name: "bare", health: "Progressing" })), []);
});

Deno.test("podNeedsDiagnosis: Running pods with a crash-looping, restarted or not-ready container are diagnosed", () => {
  const running = (
    statuses: Array<
      { ready?: boolean; restartCount?: number; waiting?: string }
    >,
  ): PodSummary => ({
    metadata: { name: "p" },
    status: {
      phase: "Running",
      containerStatuses: statuses.map((s) => ({
        name: "c",
        ready: s.ready,
        restartCount: s.restartCount,
        state: s.waiting ? { waiting: { reason: s.waiting } } : {},
      })),
    },
  });
  assertEquals(
    podNeedsDiagnosis(running([{ ready: true, restartCount: 0 }])),
    false,
  );
  assertEquals(
    podNeedsDiagnosis(running([{ ready: false, restartCount: 0 }])),
    true,
  );
  assertEquals(
    podNeedsDiagnosis(running([{ ready: true, restartCount: 3 }])),
    true,
  );
  assertEquals(
    podNeedsDiagnosis(
      running([{ ready: false, restartCount: 0, waiting: "CrashLoopBackOff" }]),
    ),
    true,
  );
  assertEquals(
    podNeedsDiagnosis({
      metadata: { name: "p" },
      status: { phase: "Pending" },
    }),
    true,
  );
  assertEquals(
    podNeedsDiagnosis({
      metadata: { name: "p" },
      status: { phase: "Succeeded" },
    }),
    false,
  );
  assertEquals(
    podHasRestarted(running([{ ready: true, restartCount: 2 }])),
    true,
  );
  assertEquals(
    podHasRestarted(running([{ ready: true, restartCount: 0 }])),
    false,
  );
});
