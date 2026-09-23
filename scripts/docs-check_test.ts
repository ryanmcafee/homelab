#!/usr/bin/env -S bun test
/**
 * Unit tests for the pure helpers in docs-check.ts: facts from snapshot
 * documents, table/badge rendering, region replacement and the in-memory
 * check that decides what is drift and what --fix can repair.
 *
 *   bun test scripts/docs-check_test.ts
 */

import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "./lib/assert.ts";
import {
  applicationRows,
  check,
  countApplications,
  docName,
  expectedLiterals,
  type Facts,
  ingressInventory,
  parseArgs,
  parseVersions,
  readRegion,
  renderBadges,
  renderIngressTable,
  replaceRegion,
  smokeJobs,
  splitDocs,
} from "./docs-check.ts";

const SNAPSHOT = `---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: plex
  namespace: argocd
spec:
  source:
    chart: plex-media-server
    targetRevision: 1.6.0
    helm:
      valuesObject:
        ingress:
          annotations:
            external-dns.alpha.kubernetes.io/hostname: plex.REPLACEME-domain.com
            external-dns.alpha.kubernetes.io/target: REPLACEME-subdomain.duckdns.org
          ingressClassName: external
          url: https://plex.REPLACEME-domain.com
          hosts:
            - plex.REPLACEME-domain.com
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: sonarr
spec:
  source:
    path: charts/sonarr
    targetRevision: main
    helm:
      valuesObject:
        ingress:
          main:
            hosts:
              - host: sonarr.REPLACEME-domain.com
            ingressClassName: internal
        nfs:
          server: truenas.REPLACEME-domain.com
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: argo-workflows-config
spec:
  source:
    path: charts/argo-workflows-config
    targetRevision: main
    helm:
      valuesObject:
        links:
          - url: https://grafana.REPLACEME-domain.com
---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: traefik-internal-dashboard-redirect
  namespace: traefik
spec:
  routes:
    - match: Host(\`traefik-internal.REPLACEME-domain.com\`) && Path(\`/dashboard\`)
---
apiVersion: batch/v1
kind: Job
metadata:
  name: smoke-plex
  annotations:
    argocd.argoproj.io/hook: PostSync
`;

test("splitDocs and docName", () => {
  const docs = splitDocs(SNAPSHOT);
  assertEquals(docs.length, 5);
  assertEquals(docName(docs[0]), "plex");
  assertEquals(docName(docs[3]), "traefik-internal-dashboard-redirect");
});

test("countApplications counts only kind: Application", () => {
  assertEquals(countApplications(splitDocs(SNAPSHOT)), 3);
});

test("ingressInventory: classed hosts from host lines, links and NFS servers ignored", () => {
  const rows = ingressInventory(splitDocs(SNAPSHOT));
  assertEquals(rows, [
    { app: "plex", host: "plex", class: "external", kind: "Ingress" },
    { app: "sonarr", host: "sonarr", class: "internal", kind: "Ingress" },
    {
      app: "traefik-internal-dashboard-redirect",
      host: "traefik-internal",
      class: "internal",
      kind: "IngressRoute",
    },
  ]);
});

test("smokeJobs lists PostSync smoke Job names", () => {
  assertEquals(smokeJobs(splitDocs(SNAPSHOT)), ["smoke-plex"]);
});

test("applicationRows: chart version vs git, ingress, e2e and smoke columns", () => {
  const docs = splitDocs(SNAPSHOT);
  const rows = applicationRows(
    docs,
    ingressInventory(docs),
    ["plex", "sonarr", "argocd-apps"],
    ["smoke-plex"],
  );
  assertEquals(
    rows.map((r) => r.name),
    ["argo-workflows-config", "plex", "sonarr"],
  );
  const plex = rows[1];
  assertEquals(plex.source, "plex-media-server");
  assertEquals(plex.version, "1.6.0");
  assertEquals(plex.ingress, "external: plex");
  assertEquals(plex.e2e, "plex");
  assertEquals(plex.smoke, "smoke-plex");
  const sonarr = rows[2];
  assertEquals(sonarr.version, "git");
  assertEquals(sonarr.ingress, "internal: sonarr");
  assertEquals(sonarr.smoke, "—");
  assertEquals(rows[0].ingress, "—");
  assertEquals(rows[0].e2e, "—");
});

test("parseVersions flattens sections", () => {
  const v = parseVersions(
    `tools:\n  # renovate: x\n  talos: "v1.14.0"\ncharts:\n  cilium: "1.19.5"\n`,
  );
  assertEquals(v["tools.talos"], "v1.14.0");
  assertEquals(v["charts.cilium"], "1.19.5");
});

test("renderBadges uses versions.yaml and fails on a missing key", () => {
  const ok = renderBadges({
    "tools.talos": "v1.14.0",
    "tools.kubernetes": "v1.37.0",
    "tools.argocd": "v3.5.3",
    "charts.cilium": "1.19.5",
    "tools.terraform": "1.16.2",
    "tools.helm": "4.3.0",
  });
  assertStringIncludes(ok, "badge/Talos-v1.14.0-");
  assertStringIncludes(ok, "badge/Cilium-1.19.5-");
  assertEquals(ok.split("\n").length, 6);
  assertThrows(
    () => renderBadges({ "tools.talos": "v1" }),
    Error,
    "tools.kubernetes",
  );
});

test("renderIngressTable is a Markdown table with placeholders", () => {
  const t = renderIngressTable([
    {
      app: "plex",
      host: "plex",
      class: "external",
      kind: "Ingress",
    },
  ]);
  assertStringIncludes(t, "| `plex.<DOMAIN>` | external | Ingress | `plex` |");
  assert(t.startsWith("| Host | Class | Kind | Application |\n| --- |"));
});

test("regions: read, replace, missing", () => {
  const text =
    "intro\n<!-- docs-check:begin t -->\nold\n<!-- docs-check:end t -->\noutro";
  assertEquals(readRegion(text, "t"), "old");
  assertEquals(
    replaceRegion(text, "t", "new\nlines"),
    "intro\n<!-- docs-check:begin t -->\nnew\nlines\n<!-- docs-check:end t -->\noutro",
  );
  assertEquals(readRegion(text, "nope"), undefined);
  assertThrows(() => replaceRegion(text, "nope", "x"), Error, "not found");
});

function facts(): Facts {
  return {
    versions: {
      "tools.talos": "v1.14.0",
      "tools.kubernetes": "v1.37.0",
      "tools.argocd": "v3.5.3",
      "charts.cilium": "1.19.5",
      "tools.terraform": "1.16.2",
      "tools.helm": "4.3.0",
    },
    addons: 29,
    applications: 15,
    argoApplications: 68,
    e2eSuites: ["plex", "grafana"],
    smokeJobs: ["smoke-plex"],
    ingress: [
      { app: "plex", host: "plex", class: "external", kind: "Ingress" },
      { app: "grafana", host: "grafana", class: "internal", kind: "Ingress" },
      {
        app: "traefik-internal-dashboard-redirect",
        host: "traefik-internal",
        class: "internal",
        kind: "IngressRoute",
      },
    ],
    addonApps: [],
    applicationApps: [],
  };
}

test("expectedLiterals: internal hosts except the traefik-internal dashboard", () => {
  const lits = expectedLiterals(facts());
  const svg = lits
    .filter((l) => l.file === ".github/homelab.svg")
    .map((l) => l.expect);
  assert(svg.includes("grafana.&lt;DOMAIN&gt;"));
  assert(!svg.includes("traefik-internal.&lt;DOMAIN&gt;"));
  assert(svg.includes("2/2 suites"));
  assert(svg.includes("68 apps synced"));
});

test("check: reports stale regions and literals, --fix rewrites what it can", () => {
  const f = facts();
  const files = new Map<string, string>([
    [
      "readme.md",
      "<!-- docs-check:begin badges -->\nstale\n<!-- docs-check:end badges -->\n32 addons, 15 applications, 73 Applications, 2 chainsaw suites, 73 ArgoCD Applications in all",
    ],
    ["docs/networking.md", "no region here"],
    [
      "docs/applications.md",
      "<!-- docs-check:begin addons-table -->\nx\n<!-- docs-check:end addons-table -->\n<!-- docs-check:begin applications-table -->\ny\n<!-- docs-check:end applications-table -->",
    ],
    [
      ".github/homelab.svg",
      "addons · 32 applications · 15 68 apps synced 2/2 suites grafana.&lt;DOMAIN&gt;",
    ],
  ]);
  const { drift, fixed } = check(files, f);
  const whats = drift.map((d) => `${d.file}: ${d.what}`);
  assert(whats.includes("readme.md: region badges is stale"));
  assert(whats.includes("docs/networking.md: region ingress-table missing"));
  assert(whats.includes('readme.md: expected "29 addons"'));
  assert(whats.includes('readme.md: expected "68 Applications"'));
  assert(whats.includes('readme.md: expected "68 ArgoCD Applications"'));
  assert(whats.includes('.github/homelab.svg: expected "addons · 29"'));
  assertEquals(
    drift.filter((d) => !d.fixable).map((d) => d.what),
    ["region ingress-table missing"],
  );
  const readme = fixed.get("readme.md")!;
  assertStringIncludes(readme, "badge/Talos-v1.14.0-");
  assertStringIncludes(
    readme,
    "29 addons, 15 applications, 68 Applications, 2 chainsaw suites, 68 ArgoCD Applications in all",
  );
  assertStringIncludes(fixed.get(".github/homelab.svg")!, "addons · 29");
  // the applications.md tables were empty rows -> header only, still rewritten
  assertStringIncludes(
    fixed.get("docs/applications.md")!,
    "| Application | Source | Version |",
  );
});

test("check: in-sync input yields no drift", () => {
  const f = facts();
  const first = check(
    new Map([
      [
        "readme.md",
        "<!-- docs-check:begin badges -->\n\n<!-- docs-check:end badges -->\n29 addons 15 applications 68 Applications 2 chainsaw suites 68 ArgoCD Applications in all",
      ],
      [
        "docs/networking.md",
        "<!-- docs-check:begin ingress-table -->\n\n<!-- docs-check:end ingress-table -->",
      ],
      [
        "docs/applications.md",
        "<!-- docs-check:begin addons-table -->\n\n<!-- docs-check:end addons-table -->\n<!-- docs-check:begin applications-table -->\n\n<!-- docs-check:end applications-table -->",
      ],
      [
        ".github/homelab.svg",
        "addons · 29 applications · 15 68 apps synced 2/2 suites grafana.&lt;DOMAIN&gt;",
      ],
    ]),
    f,
  );
  const second = check(first.fixed, f);
  assertEquals(second.drift, []);
});

test("parseArgs", () => {
  assertEquals(parseArgs([]), {
    fix: false,
    json: false,
    root: ".",
    help: false,
  });
  assertEquals(parseArgs(["--fix", "--root", "/x", "--json"]).root, "/x");
  assertEquals(parseArgs(["--root=/y"]).root, "/y");
  assertThrows(() => parseArgs(["--nope"]), Error, "unknown argument");
});
