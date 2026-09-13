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

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  type Application,
  appState,
  candidatePorts,
  compareTierKey,
  countManifests,
  DEFAULT_LOCAL_PORT,
  degradedChildHint,
  discoverable,
  emptyRenderDecision,
  escapeHelmKey,
  finalPassDecision,
  findFreePort,
  hasComparisonError,
  indexApps,
  isAppComplete,
  isAutomated,
  isOperationInProgress,
  isParentApp,
  isReady,
  isTierComplete,
  manifestsArgs,
  nextTier,
  parentOf,
  parentResyncDecision,
  parseArgs,
  parsePort,
  parseWave,
  pendingChildren,
  portForwardCmd,
  selectApps,
  serverFlags,
  setFileArgs,
  sourceKind,
  syncArgs,
  tierKey,
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
