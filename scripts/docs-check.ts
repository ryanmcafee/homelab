#!/usr/bin/env bun

/**
 * docs-check.ts
 *
 * Keeps the numbers in the README, the docs and the animated header true.
 * Every count and version they show is computed from the repository and
 * compared against what is committed; a mismatch fails the check with a
 * one-line diff, and `--fix` rewrites the generated regions.
 *
 * Sources of truth:
 *   configuration/versions.yaml            tool and chart versions (badge row)
 *   charts/addons/templates/*.yaml         addon count (one template = one addon)
 *   charts/applications/templates/*.yaml   application count
 *   tests/snapshots/homelab/*.yaml         ArgoCD Applications, route inventory
 *                                          (Gateway + host per Application), chart
 *                                          versions, PostSync smoke Jobs
 *   tests/e2e/<suite>/chainsaw-test.yaml   chainsaw suite count and names
 *
 * Generated regions are fenced in Markdown with
 *   <!-- docs-check:begin <key> -->  ...  <!-- docs-check:end <key> -->
 * and replaced whole. Keys: readme `badges`; docs/networking.md `route-table`;
 * docs/applications.md `addons-table`, `applications-table`.
 *
 * Literal checks (no region, the sentence around them is hand-written):
 *   readme.md            "<N> addons", "<N> applications", "<N> Applications",
 *                        "<N> chainsaw suites"
 *   .github/homelab.svg  "addons · <N>", "applications · <N>",
 *                        "<N> apps synced", "<N>/<N> suites", and one
 *                        "<host>.&lt;DOMAIN&gt;" per envoy-internal route host
 *                        (the echo comparison route is deliberately not
 *                        drawn). Counter steps in the SVG cannot be regenerated
 *                        by --fix; the check says so when the suite count moves.
 *
 * Usage:
 *   task docs:check              report drift, exit 1 on any
 *   task docs:check -- --fix     rewrite generated regions and SVG literals
 *   task docs:check -- --json    machine-readable report
 *
 * Exit codes: 0 = in sync; 1 = drift (or unfixable drift after --fix); 2 = usage.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "./lib/yaml.ts";

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface RouteRow {
  app: string;
  host: string;
  gateway: string;
  kind: "HTTPRoute" | "Chart";
}

export interface AppRow {
  name: string;
  source: string; // chart name or git path
  version: string; // chart version, or "git" for path sources
  route: string; // "envoy-external: a, b" / "envoy-internal: c" / "—"
  e2e: string; // suite name(s) or "—"
  smoke: string; // Job name(s) or "—"
}

export interface Facts {
  versions: Record<string, string>; // "tools.talos" -> "v1.14.0"
  addons: number;
  applications: number;
  argoApplications: number;
  e2eSuites: string[];
  smokeJobs: string[];
  routes: RouteRow[];
  addonApps: AppRow[];
  applicationApps: AppRow[];
}

/** Flattens versions.yaml into "section.key" -> version. */
export function parseVersions(text: string): Record<string, string> {
  const doc = parseYaml(text) as Record<string, Record<string, string>>;
  const out: Record<string, string> = {};
  for (const [section, entries] of Object.entries(doc ?? {})) {
    if (!entries || typeof entries !== "object") continue;
    for (const [k, v] of Object.entries(entries)) {
      out[`${section}.${k}`] = String(v);
    }
  }
  return out;
}

/** Splits a multi-document YAML file on its `---` separators. */
export function splitDocs(text: string): string[] {
  return text
    .split(/^---\s*$/m)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

function field(doc: string, key: string): string | undefined {
  const m = doc.match(new RegExp(`^${key}:\\s*(\\S+)`, "m"));
  return m?.[1];
}

/** metadata.name of a document (first `  name:` under `metadata:`). */
export function docName(doc: string): string | undefined {
  const m = doc.match(/^metadata:\n(?: {2}.*\n)*? {2}name:\s*(\S+)/m);
  return m?.[1];
}

export function countApplications(docs: string[]): number {
  return docs.filter((d) => /^kind: Application$/m.test(d)).length;
}

const HOST_RE = /\b([a-z0-9][a-z0-9-]*)\.replaceme-domain\.com\b/gi;
const GATEWAY_RE =
  /^\s*-?\s*(?:name|gateway):\s*"?(envoy-(?:internal|external))"?\s*$/m;
// Lines that name a host for routing (not links, not e-mail, not NFS servers).
const HOST_LINE_RE =
  /(hostname:|^\s*-?\s*host:|^\s*-\s+"?[a-z0-9-]+\.replaceme)/i;
const HOST_LINE_SKIP_RE = /(url:|server:|email|@)/;

/**
 * Route inventory from rendered snapshot documents. An Application whose
 * values name an Envoy Gateway contributes every host named on a host line
 * (its chart renders the HTTPRoute); a standalone HTTPRoute contributes its
 * hostnames, attached to the first Envoy Gateway among its parentRefs.
 */
export function routeInventory(docs: string[]): RouteRow[] {
  const rows: RouteRow[] = [];
  const seen = new Set<string>();
  const push = (r: RouteRow) => {
    const k = `${r.host}|${r.gateway}`;
    if (seen.has(k)) return;
    seen.add(k);
    rows.push(r);
  };
  for (const doc of docs) {
    const kind = field(doc, "kind");
    if (kind !== "Application" && kind !== "HTTPRoute") continue;
    const gateway = doc.match(GATEWAY_RE)?.[1];
    if (!gateway) continue;
    const name = docName(doc) ?? "?";
    for (const line of doc.split("\n")) {
      if (!HOST_LINE_RE.test(line) || HOST_LINE_SKIP_RE.test(line)) continue;
      for (const m of line.matchAll(HOST_RE)) {
        push({
          app: name,
          host: m[1],
          gateway,
          kind: kind === "HTTPRoute" ? "HTTPRoute" : "Chart",
        });
      }
    }
  }
  return rows.sort(
    (a, b) =>
      a.gateway.localeCompare(b.gateway) || a.host.localeCompare(b.host),
  );
}

export function smokeJobs(docs: string[]): string[] {
  const out = new Set<string>();
  for (const doc of docs) {
    if (field(doc, "kind") !== "Job") continue;
    const n = docName(doc);
    if (n?.startsWith("smoke-")) out.add(n);
  }
  return [...out].sort();
}

const SEMVER_RE = /^v?\d+\.\d+\.\d+/;

// Smoke Jobs and e2e suites that belong to an Application under another name.
const SMOKE_ALIASES: Record<string, string[]> = {
  "kube-prometheus-stack": ["smoke-grafana", "smoke-prometheus"],
};
const E2E_ALIASES: Record<string, string[]> = {
  argocd: ["argocd-apps"],
  cilium: ["cilium-netpol"],
  "envoy-gateway-config": ["envoy-gateway"],
  "kube-prometheus-stack": ["grafana"],
  "agent-readonly": ["agent-readonly"],
};

function matches(
  name: string,
  candidates: string[],
  aliases: Record<string, string[]>,
  prefix: string,
): string[] {
  const hits = new Set<string>();
  for (const c of candidates) {
    const bare = c.startsWith(prefix) ? c.slice(prefix.length) : c;
    if (bare === name) hits.add(c);
  }
  for (const a of aliases[name] ?? []) {
    const full = prefix && !a.startsWith(prefix) ? prefix + a : a;
    if (candidates.includes(full)) hits.add(full);
  }
  return [...hits].sort();
}

/** One row per ArgoCD Application in the given documents. */
export function applicationRows(
  docs: string[],
  routes: RouteRow[],
  e2eSuites: string[],
  smoke: string[],
): AppRow[] {
  const rows: AppRow[] = [];
  for (const doc of docs) {
    if (field(doc, "kind") !== "Application") continue;
    const name = docName(doc) ?? "?";
    const chart = doc.match(/^\s+chart:\s*(\S+)/m)?.[1];
    const path = doc.match(/^\s+path:\s*(\S+)/m)?.[1];
    const rev =
      doc.match(/^\s+targetRevision:\s*"?([^"\n]+)"?/m)?.[1]?.trim() ?? "";
    const byGateway = new Map<string, string[]>();
    for (const r of routes.filter((r) => r.app === name)) {
      byGateway.set(r.gateway, [...(byGateway.get(r.gateway) ?? []), r.host]);
    }
    const routeText =
      byGateway.size === 0
        ? "—"
        : [...byGateway.entries()]
            .map(([c, hosts]) => `${c}: ${hosts.join(", ")}`)
            .join("; ");
    const e2e = matches(name, e2eSuites, E2E_ALIASES, "");
    const sm = matches(name, smoke, SMOKE_ALIASES, "smoke-");
    rows.push({
      name,
      source: chart ?? path ?? "?",
      version: chart ? (SEMVER_RE.test(rev) ? rev : rev || "?") : "git",
      route: routeText,
      e2e: e2e.length ? e2e.join(", ") : "—",
      smoke: sm.length ? sm.join(", ") : "—",
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderTable(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join(
    "\n",
  );
}

export function renderRouteTable(rows: RouteRow[]): string {
  return renderTable(
    ["Host", "Gateway", "Kind", "Application"],
    rows.map((r) => [
      `\`${r.host}.<DOMAIN>\``,
      r.gateway,
      r.kind,
      `\`${r.app}\``,
    ]),
  );
}

export function renderAppTable(rows: AppRow[]): string {
  return renderTable(
    ["Application", "Source", "Version", "Route", "chainsaw e2e", "Smoke Job"],
    rows.map((r) => [
      `\`${r.name}\``,
      `\`${r.source}\``,
      r.version,
      r.route,
      r.e2e,
      r.smoke,
    ]),
  );
}

const BADGES: Array<
  [label: string, key: string, color: string, logo: string, url: string]
> = [
  ["Talos", "tools.talos", "FF6C2C", "talos", "https://www.talos.dev/"],
  [
    "Kubernetes",
    "tools.kubernetes",
    "326CE5",
    "kubernetes",
    "https://kubernetes.io/",
  ],
  [
    "ArgoCD",
    "tools.argocd",
    "EF7B4D",
    "argo",
    "https://argoproj.github.io/cd/",
  ],
  ["Cilium", "charts.cilium", "F8C517", "cilium", "https://cilium.io/"],
  [
    "Terraform",
    "tools.terraform",
    "7B42BC",
    "terraform",
    "https://developer.hashicorp.com/terraform",
  ],
  ["Helm", "tools.helm", "0F1689", "helm", "https://helm.sh/"],
];

export function renderBadges(versions: Record<string, string>): string {
  return BADGES.map(([label, key, color, logo, url]) => {
    const v = versions[key];
    if (!v) throw new Error(`versions.yaml has no ${key}`);
    const msg = v.replace(/-/g, "--").replace(/_/g, "__");
    return `[![${label}](https://img.shields.io/badge/${label}-${msg}-${color}?logo=${logo}&logoColor=white)](${url})`;
  }).join("\n");
}

// ---------------------------------------------------------------------------
// Regions and literals
// ---------------------------------------------------------------------------

export function regionRe(key: string): RegExp {
  return new RegExp(
    `(<!-- docs-check:begin ${key} -->\\n)([\\s\\S]*?)(\\n<!-- docs-check:end ${key} -->)`,
  );
}

/** Returns the current body of a region, or undefined when the markers are missing. */
export function readRegion(text: string, key: string): string | undefined {
  return text.match(regionRe(key))?.[2];
}

export function replaceRegion(text: string, key: string, body: string): string {
  if (!regionRe(key).test(text)) throw new Error(`region ${key} not found`);
  return text.replace(
    regionRe(key),
    (_m, open, _old, close) => `${open}${body}${close}`,
  );
}

export interface Literal {
  file: string;
  expect: string;
  fix?: [pattern: RegExp, replacement: string];
}

/** The hand-written sentences that must carry the computed numbers. */
export function expectedLiterals(f: Facts): Literal[] {
  const n = f.e2eSuites.length;
  const internalHosts = f.routes
    .filter((r) => r.gateway === "envoy-internal" && r.host !== "echo")
    .map((r) => r.host);
  return [
    {
      file: "readme.md",
      expect: `${f.addons} addons`,
      fix: [/\b\d+ addons\b/g, `${f.addons} addons`],
    },
    {
      file: "readme.md",
      expect: `${f.applications} applications`,
      fix: [/\b\d+ applications\b/g, `${f.applications} applications`],
    },
    {
      file: "readme.md",
      expect: `${f.argoApplications} Applications`,
      fix: [/\b\d+ Applications\b/g, `${f.argoApplications} Applications`],
    },
    {
      // "<N> ArgoCD Applications in all" is a separate phrase: the generic
      // pattern above needs the digits right before "Applications".
      file: "readme.md",
      expect: `${f.argoApplications} ArgoCD Applications`,
      fix: [
        /\b\d+ ArgoCD Applications\b/g,
        `${f.argoApplications} ArgoCD Applications`,
      ],
    },
    {
      file: "readme.md",
      expect: `${n} chainsaw suites`,
      fix: [/\b\d+ chainsaw suites\b/g, `${n} chainsaw suites`],
    },
    {
      file: ".github/homelab.svg",
      expect: `addons · ${f.addons}`,
      fix: [/addons · \d+/g, `addons · ${f.addons}`],
    },
    {
      file: ".github/homelab.svg",
      expect: `applications · ${f.applications}`,
      fix: [/applications · \d+/g, `applications · ${f.applications}`],
    },
    {
      file: ".github/homelab.svg",
      expect: `${f.argoApplications} apps synced`,
      fix: [/\d+ apps synced/g, `${f.argoApplications} apps synced`],
    },
    { file: ".github/homelab.svg", expect: `${n}/${n} suites` },
    ...internalHosts.map((h) => ({
      file: ".github/homelab.svg",
      expect: `${h}.&lt;DOMAIN&gt;`,
    })),
  ];
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

async function listFiles(
  dir: string,
  pred: (name: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isFile() && pred(e.name)) out.push(`${dir}/${e.name}`);
  }
  return out.sort();
}

async function listDirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(e.name);
  }
  return out.sort();
}

export async function collectFacts(root: string): Promise<Facts> {
  const isTemplate = (n: string) => n.endsWith(".yaml") && !n.startsWith("_");
  const addons = (
    await listFiles(`${root}/charts/addons/templates`, isTemplate)
  ).length;
  const applications = (
    await listFiles(`${root}/charts/applications/templates`, isTemplate)
  ).length;

  const snapshotFiles = await listFiles(
    `${root}/tests/snapshots/homelab`,
    (n) => n.endsWith(".yaml"),
  );
  const byFile = new Map<string, string[]>();
  for (const f of snapshotFiles) {
    byFile.set(f, splitDocs(await readFile(f, "utf8")));
  }
  const allDocs = [...byFile.values()].flat();

  const e2eSuites: string[] = [];
  for (const d of await listDirs(`${root}/tests/e2e`)) {
    try {
      await stat(`${root}/tests/e2e/${d}/chainsaw-test.yaml`);
      e2eSuites.push(d);
    } catch {
      /* not a suite */
    }
  }

  const routes = routeInventory(allDocs);
  const smoke = smokeJobs(allDocs);
  const addonDocs =
    byFile.get(`${root}/tests/snapshots/homelab/addons.yaml`) ?? [];
  const appDocs =
    byFile.get(`${root}/tests/snapshots/homelab/applications.yaml`) ?? [];

  return {
    versions: parseVersions(
      await readFile(`${root}/configuration/versions.yaml`, "utf8"),
    ),
    addons,
    applications,
    argoApplications: countApplications(allDocs),
    e2eSuites,
    smokeJobs: smoke,
    routes,
    addonApps: applicationRows(addonDocs, routes, e2eSuites, smoke),
    applicationApps: applicationRows(appDocs, routes, e2eSuites, smoke),
  };
}

export interface Drift {
  file: string;
  what: string;
  fixable: boolean;
}

interface RegionSpec {
  file: string;
  key: string;
  body: string;
}

export function regionSpecs(f: Facts): RegionSpec[] {
  return [
    { file: "readme.md", key: "badges", body: renderBadges(f.versions) },
    {
      file: "docs/networking.md",
      key: "route-table",
      body: renderRouteTable(f.routes),
    },
    {
      file: "docs/applications.md",
      key: "addons-table",
      body: renderAppTable(f.addonApps),
    },
    {
      file: "docs/applications.md",
      key: "applications-table",
      body: renderAppTable(f.applicationApps),
    },
  ];
}

/** Pure check over in-memory file contents; returns drift and the fixed contents. */
export function check(
  files: Map<string, string>,
  facts: Facts,
): { drift: Drift[]; fixed: Map<string, string> } {
  const drift: Drift[] = [];
  const fixed = new Map(files);
  for (const r of regionSpecs(facts)) {
    const text = fixed.get(r.file);
    if (text === undefined) {
      drift.push({
        file: r.file,
        what: `file missing (region ${r.key})`,
        fixable: false,
      });
      continue;
    }
    const current = readRegion(text, r.key);
    if (current === undefined) {
      drift.push({
        file: r.file,
        what: `region ${r.key} missing`,
        fixable: false,
      });
      continue;
    }
    if (current !== r.body) {
      drift.push({
        file: r.file,
        what: `region ${r.key} is stale`,
        fixable: true,
      });
      fixed.set(r.file, replaceRegion(text, r.key, r.body));
    }
  }
  for (const l of expectedLiterals(facts)) {
    const text = fixed.get(l.file);
    if (text === undefined) {
      drift.push({
        file: l.file,
        what: `file missing (expects "${l.expect}")`,
        fixable: false,
      });
      continue;
    }
    if (text.includes(l.expect)) continue;
    if (l.fix) {
      const next = text.replace(l.fix[0], l.fix[1]);
      const ok = next.includes(l.expect);
      drift.push({ file: l.file, what: `expected "${l.expect}"`, fixable: ok });
      if (ok) fixed.set(l.file, next);
    } else {
      drift.push({
        file: l.file,
        what: `expected "${l.expect}" (regenerate by hand)`,
        fixable: false,
      });
    }
  }
  return { drift, fixed };
}

export interface Args {
  fix: boolean;
  json: boolean;
  root: string;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { fix: false, json: false, root: ".", help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--fix") a.fix = true;
    else if (x === "--json") a.json = true;
    else if (x === "--help" || x === "-h") a.help = true;
    else if (x === "--root") a.root = argv[++i] ?? ".";
    else if (x.startsWith("--root=")) a.root = x.slice("--root=".length);
    else throw new Error(`unknown argument: ${x}`);
  }
  return a;
}

const FILES = [
  "readme.md",
  "docs/networking.md",
  "docs/applications.md",
  ".github/homelab.svg",
];

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`docs-check: ${(e as Error).message}`);
    return 2;
  }
  if (args.help) {
    console.log("usage: docs-check.ts [--fix] [--json] [--root DIR]");
    return 0;
  }
  const facts = await collectFacts(args.root);
  const files = new Map<string, string>();
  for (const f of FILES) {
    try {
      files.set(f, await readFile(`${args.root}/${f}`, "utf8"));
    } catch {
      /* reported as missing */
    }
  }
  const { drift, fixed } = check(files, facts);
  if (args.fix) {
    for (const [f, text] of fixed) {
      if (files.get(f) !== text) {
        await writeFile(`${args.root}/${f}`, text);
        console.log(`fixed ${f}`);
      }
    }
  }
  const remaining = args.fix ? drift.filter((d) => !d.fixable) : drift;
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          facts: { ...facts, addonApps: undefined, applicationApps: undefined },
          drift: remaining,
        },
        null,
        2,
      ),
    );
  } else if (remaining.length === 0) {
    console.log(
      `docs-check: in sync (${facts.addons} addons, ${facts.applications} applications, ${facts.argoApplications} Applications, ${facts.e2eSuites.length} suites, ${facts.routes.length} route hosts)`,
    );
  } else {
    for (const d of remaining) {
      console.error(
        `docs-check: ${d.file}: ${d.what}${d.fixable ? " (run --fix)" : ""}`,
      );
    }
  }
  return remaining.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
