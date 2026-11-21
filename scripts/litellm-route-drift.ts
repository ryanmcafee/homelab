#!/usr/bin/env bun

/**
 * litellm-route-drift.ts
 *
 * charts/litellm-config publishes the LiteLLM proxy as Envoy Gateway
 * HTTPRoutes, and its route.* path lists are a hand-copied mirror of the
 * upstream chart's templates/ingress.yaml ($uiPaths and $gatewayPrefixes),
 * which itself mirrors the proxy's gateway/routes/allowlist.py. Upstream moves
 * a path between the gateway and the backend and our HTTPRoutes keep sending
 * it to the old Service, which answers 404. Nothing in the repository notices:
 * this repo sets ingress.enabled: false, so `verify upgrade` renders the
 * upstream chart with that template switched off and diffs an empty string.
 *
 * This gate renders the pinned upstream chart with ingress.enabled=true, reads
 * the paths back out of the rendered Ingress grouped by the Service each one
 * targets, and fails when that set differs from route.* in
 * charts/litellm-config/values.yaml. The failure names the added and removed
 * paths, so a chart bump says which routes to move rather than that something
 * changed.
 *
 * Rendered with ingress.controller=alb, the chart's default. The nginx variant
 * rewrites the pathType of any path containing a dot to
 * ImplementationSpecific, which would report /favicon.ico and /eu.assemblyai
 * as drift against lists that are correct.
 *
 * Two upstream gateway paths are dropped from our HTTPRoutes on purpose and
 * are exempt here (EXEMPT_GATEWAY_PATHS): /metrics, which Prometheus scrapes
 * in-cluster through the ServiceMonitor and which is unauthenticated on the
 * gateway's metrics port, and /debug/memory/summary, an upstream e2e memory
 * gate that reports a worker's RSS. Listing either one in values.yaml is
 * reported too -- the exemption records a decision, so re-adding the path
 * should be a visible change and not silently absorbed.
 *
 * /*.txt is an ImplementationSpecific UI path the chart renders for alb only.
 * It is not a route.ui*Paths entry; charts/litellm-config expresses it as
 * route.ui.rscPayloads, so the gate asserts that flag instead of a list.
 *
 * Usage:
 *   task verify:litellm-routes
 *   bun scripts/litellm-route-drift.ts
 *   bun scripts/litellm-route-drift.ts --ingress-file <rendered.yaml>   # skip helm
 *
 * Exit codes: 0 = the route lists match upstream; 1 = drift; 2 = usage error
 * or the upstream chart could not be rendered.
 */

import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "./lib/yaml.ts";

const VERSIONS_PATH = "configuration/versions.yaml";
const APPS_VALUES_PATH = "charts/applications/values.yaml";
const ROUTE_VALUES_PATH = "charts/litellm-config/values.yaml";

/**
 * Upstream gateway paths charts/litellm-config leaves out on purpose. Applied
 * to both gateway buckets so moving one between Exact and Prefix upstream does
 * not surface as drift.
 */
export const EXEMPT_GATEWAY_PATHS = new Set([
  "/metrics",
  "/debug/memory/summary",
]);

// ============================================================================
// Logging (stderr; stdout carries machine-readable output only)
// ============================================================================
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const log = {
  info: (msg: string) => console.error(`${cyan("INFO")}  ${msg}`),
  ok: (msg: string) => console.error(`${green("OK")}    ${msg}`),
  fail: (msg: string) => console.error(`${red("FAIL")}  ${msg}`),
};

// ============================================================================
// Types
// ============================================================================

/** One Service the rendered Ingress routes to. */
export interface RouteTarget {
  service: string;
  port: number;
}

/** The three Services charts/litellm-config addresses, from its own values. */
export interface ConfiguredRoutes {
  ui: RouteTarget;
  backend: RouteTarget;
  gateway: RouteTarget;
  uiExactPaths: string[];
  uiPathPrefixes: string[];
  gatewayExactPaths: string[];
  gatewayPathPrefixes: string[];
  rscPayloads: boolean;
}

/** Paths read back out of the rendered upstream Ingress. */
export interface RenderedRoutes {
  uiExactPaths: string[];
  uiPathPrefixes: string[];
  gatewayExactPaths: string[];
  gatewayPathPrefixes: string[];
  /** ImplementationSpecific UI paths, e.g. /*.txt on alb. */
  uiWildcardPaths: string[];
  /** Backends the Ingress names, keyed by Service name. */
  targets: Map<string, Set<number>>;
}

export interface Finding {
  /** The route.* field or Service the finding is about. */
  subject: string;
  detail: string;
}

// ============================================================================
// Loading
// ============================================================================

function asStringList(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${where}: expected a list`);
  return v.map((e) => {
    if (typeof e !== "string") throw new Error(`${where}: expected strings`);
    return e;
  });
}

function requireTarget(v: unknown, where: string): RouteTarget {
  if (typeof v !== "object" || v === null) {
    throw new Error(`${where}: expected a mapping with service and port`);
  }
  const m = v as Record<string, unknown>;
  const service = m.service;
  const port = m.port;
  if (typeof service !== "string" || service === "") {
    throw new Error(`${where}.service: expected a non-empty string`);
  }
  if (typeof port !== "number") {
    throw new Error(`${where}.port: expected a number`);
  }
  return { service, port };
}

/** Reads the route contract out of charts/litellm-config/values.yaml. */
export function parseConfiguredRoutes(valuesYaml: string): ConfiguredRoutes {
  const doc = parseYaml(valuesYaml);
  if (typeof doc !== "object" || doc === null) {
    throw new Error(`${ROUTE_VALUES_PATH}: not a YAML mapping`);
  }
  const route = (doc as Record<string, unknown>).route;
  if (typeof route !== "object" || route === null) {
    throw new Error(`${ROUTE_VALUES_PATH}: route: is missing`);
  }
  const r = route as Record<string, unknown>;
  const ui = requireTarget(r.ui, "route.ui");
  const uiMap = r.ui as Record<string, unknown>;
  return {
    ui,
    backend: requireTarget(r.backend, "route.backend"),
    gateway: requireTarget(r.gatewayService, "route.gatewayService"),
    uiExactPaths: asStringList(r.uiExactPaths, "route.uiExactPaths"),
    uiPathPrefixes: asStringList(r.uiPathPrefixes, "route.uiPathPrefixes"),
    gatewayExactPaths: asStringList(
      r.gatewayExactPaths,
      "route.gatewayExactPaths",
    ),
    gatewayPathPrefixes: asStringList(
      r.gatewayPathPrefixes,
      "route.gatewayPathPrefixes",
    ),
    rscPayloads: uiMap.rscPayloads === true,
  };
}

interface IngressPath {
  path: string;
  pathType: string;
  service: string;
  port: number;
}

function ingressPaths(ingressYaml: string): IngressPath[] {
  const doc = parseYaml(ingressYaml);
  if (typeof doc !== "object" || doc === null) {
    throw new Error("rendered Ingress: not a YAML mapping");
  }
  const d = doc as Record<string, unknown>;
  if (d.kind !== "Ingress") {
    throw new Error(
      `rendered Ingress: expected kind Ingress, got ${String(d.kind)}. ` +
        "The upstream chart renders the path allowlist in templates/ingress.yaml; " +
        "if that template moved, this gate needs updating.",
    );
  }
  const spec = (d.spec ?? {}) as Record<string, unknown>;
  const rules = spec.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("rendered Ingress: spec.rules is empty");
  }
  const out: IngressPath[] = [];
  for (const rule of rules) {
    const http = ((rule as Record<string, unknown>).http ?? {}) as Record<
      string,
      unknown
    >;
    const paths = http.paths;
    if (!Array.isArray(paths)) continue;
    for (const p of paths) {
      const e = p as Record<string, unknown>;
      const backend = (e.backend ?? {}) as Record<string, unknown>;
      const svc = (backend.service ?? {}) as Record<string, unknown>;
      const portObj = (svc.port ?? {}) as Record<string, unknown>;
      if (
        typeof e.path !== "string" ||
        typeof e.pathType !== "string" ||
        typeof svc.name !== "string" ||
        typeof portObj.number !== "number"
      ) {
        throw new Error(
          `rendered Ingress: unreadable path entry ${JSON.stringify(p)}`,
        );
      }
      out.push({
        path: e.path,
        pathType: e.pathType,
        service: svc.name,
        port: portObj.number,
      });
    }
  }
  if (out.length === 0) throw new Error("rendered Ingress: no paths");
  return out;
}

/**
 * Groups the rendered Ingress paths by the Service they target. The Service
 * names come from the configured routes, so an upstream rename lands as an
 * unknown target rather than as a silently empty bucket.
 */
export function extractRenderedRoutes(
  ingressYaml: string,
  cfg: ConfiguredRoutes,
): RenderedRoutes {
  const out: RenderedRoutes = {
    uiExactPaths: [],
    uiPathPrefixes: [],
    gatewayExactPaths: [],
    gatewayPathPrefixes: [],
    uiWildcardPaths: [],
    targets: new Map(),
  };
  for (const p of ingressPaths(ingressYaml)) {
    const ports = out.targets.get(p.service) ?? new Set<number>();
    ports.add(p.port);
    out.targets.set(p.service, ports);

    if (p.service === cfg.ui.service) {
      if (p.pathType === "Exact") out.uiExactPaths.push(p.path);
      else if (p.pathType === "Prefix") out.uiPathPrefixes.push(p.path);
      else out.uiWildcardPaths.push(p.path);
    } else if (p.service === cfg.gateway.service) {
      if (p.pathType === "Exact") out.gatewayExactPaths.push(p.path);
      else out.gatewayPathPrefixes.push(p.path);
    }
    // The backend is the catch-all (/ Prefix); charts/litellm-config derives
    // it rather than listing it, so there is nothing to compare.
  }
  return out;
}

// ============================================================================
// Comparison
// ============================================================================

function sorted(xs: Iterable<string>): string[] {
  return [...xs].sort();
}

/**
 * Compares one route list against the matching rendered set. `exempt` holds
 * upstream paths this repo drops on purpose; they are removed from the
 * upstream side and reported separately if they appear in values.yaml.
 */
function diffList(
  field: string,
  upstream: string[],
  configured: string[],
  exempt: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  const up = new Set(upstream);
  const cfg = new Set(configured);

  const droppedOnPurpose = sorted([...up].filter((p) => exempt.has(p)));
  for (const p of droppedOnPurpose) up.delete(p);

  const reAdded = droppedOnPurpose.filter((p) => cfg.has(p));
  if (reAdded.length > 0) {
    findings.push({
      subject: field,
      detail:
        `lists ${reAdded.join(", ")}, which this repo drops on purpose ` +
        "(see EXEMPT_GATEWAY_PATHS in scripts/litellm-route-drift.ts). " +
        "Remove the entry, or drop it from the exemption set and say why in values.yaml.",
    });
    for (const p of reAdded) cfg.delete(p);
  }

  const added = sorted([...up].filter((p) => !cfg.has(p)));
  const removed = sorted([...cfg].filter((p) => !up.has(p)));

  if (added.length > 0) {
    findings.push({
      subject: field,
      detail:
        `upstream serves ${added.length} path(s) this list is missing: ${added.join(", ")}. ` +
        "Requests for them fall to the backend catch-all and 404.",
    });
  }
  if (removed.length > 0) {
    findings.push({
      subject: field,
      detail:
        `lists ${removed.length} path(s) upstream no longer serves here: ${removed.join(", ")}. ` +
        "Upstream moved them to another Service, so our HTTPRoute sends them to the wrong one.",
    });
  }
  if (upstream.length !== new Set(upstream).size) {
    findings.push({
      subject: field,
      detail: "the rendered Ingress repeats a path; the extraction is wrong",
    });
  }
  return findings;
}

/** Every route-drift finding between the pinned upstream chart and our values. */
export function diffRoutes(
  rendered: RenderedRoutes,
  cfg: ConfiguredRoutes,
): Finding[] {
  const findings: Finding[] = [];
  const none = new Set<string>();

  findings.push(
    ...diffList(
      "route.uiExactPaths",
      rendered.uiExactPaths,
      cfg.uiExactPaths,
      none,
    ),
    ...diffList(
      "route.uiPathPrefixes",
      rendered.uiPathPrefixes,
      cfg.uiPathPrefixes,
      none,
    ),
    ...diffList(
      "route.gatewayExactPaths",
      rendered.gatewayExactPaths,
      cfg.gatewayExactPaths,
      EXEMPT_GATEWAY_PATHS,
    ),
    ...diffList(
      "route.gatewayPathPrefixes",
      rendered.gatewayPathPrefixes,
      cfg.gatewayPathPrefixes,
      EXEMPT_GATEWAY_PATHS,
    ),
  );

  // Services. An upstream rename or a port move breaks the HTTPRoute the same
  // way a moved path does, and the rendered Ingress is the evidence for both.
  const known = new Map<string, RouteTarget>([
    ["ui", cfg.ui],
    ["backend", cfg.backend],
    ["gateway", cfg.gateway],
  ]);
  const byName = new Map(
    [...known.values()].map((t) => [t.service, t] as const),
  );
  for (const [service, ports] of sorted(rendered.targets.keys()).map(
    (s) => [s, rendered.targets.get(s) as Set<number>] as const,
  )) {
    const target = byName.get(service);
    if (!target) {
      findings.push({
        subject: "route services",
        detail:
          `the rendered Ingress routes to Service ${service}, which charts/litellm-config does not name ` +
          `(it knows ${sorted(byName.keys()).join(", ")}). Upstream renamed a component Service.`,
      });
      continue;
    }
    const wrong = sorted(
      [...ports].filter((p) => p !== target.port).map(String),
    );
    if (wrong.length > 0) {
      findings.push({
        subject: "route services",
        detail: `upstream serves ${service} on port ${wrong.join(", ")}, but charts/litellm-config routes to ${target.port}.`,
      });
    }
  }
  for (const [role, target] of known) {
    if (!rendered.targets.has(target.service)) {
      findings.push({
        subject: "route services",
        detail:
          `charts/litellm-config routes to ${target.service} for the ${role}, ` +
          "but the rendered upstream Ingress never names it.",
      });
    }
  }

  // /*.txt is expressed as a flag, not a list.
  const wildcard = sorted(rendered.uiWildcardPaths);
  if (wildcard.length > 0 && !cfg.rscPayloads) {
    findings.push({
      subject: "route.ui.rscPayloads",
      detail:
        `upstream serves ${wildcard.join(", ")} from the UI, but rscPayloads is not true, ` +
        "so the RSC payloads fall to the backend catch-all and the login flow never settles.",
    });
  }
  if (wildcard.length === 0 && cfg.rscPayloads) {
    findings.push({
      subject: "route.ui.rscPayloads",
      detail:
        "rscPayloads is true, but the rendered upstream Ingress serves no ImplementationSpecific UI path. " +
        "Upstream dropped the root-level <route>.txt payloads.",
    });
  }

  return findings;
}

/** Human-readable drift report. */
export function renderFindings(findings: Finding[]): string {
  const lines = [
    "LiteLLM route drift: charts/litellm-config/values.yaml no longer matches the pinned upstream chart.",
    "",
  ];
  const bySubject = new Map<string, string[]>();
  for (const f of findings) {
    const list = bySubject.get(f.subject) ?? [];
    list.push(f.detail);
    bySubject.set(f.subject, list);
  }
  for (const subject of sorted(bySubject.keys())) {
    lines.push(`${subject}:`);
    for (const detail of bySubject.get(subject) as string[]) {
      lines.push(`  - ${detail}`);
    }
    lines.push("");
  }
  lines.push(
    "The upstream list lives in templates/ingress.yaml ($uiPaths, $gatewayPrefixes) and mirrors",
    "the proxy's gateway/routes/allowlist.py. Update route.* in charts/litellm-config/values.yaml",
    "to match, then re-run: task verify:litellm-routes",
  );
  return lines.join("\n");
}

// ============================================================================
// Rendering the upstream chart
// ============================================================================

interface ChartPin {
  repo: string;
  name: string;
  version: string;
}

/** Resolves the pinned chart from versions.yaml and the Application values. */
export function resolveChartPin(
  versionsYaml: string,
  appsValuesYaml: string,
): ChartPin {
  const versions = parseYaml(versionsYaml) as {
    charts?: Record<string, unknown>;
  };
  const version = versions.charts?.litellm;
  if (typeof version !== "string" || version === "") {
    throw new Error(`charts.litellm not found in ${VERSIONS_PATH}`);
  }
  const apps = parseYaml(appsValuesYaml) as Record<string, unknown>;
  const litellm = (apps.litellm ?? {}) as Record<string, unknown>;
  const proxy = (litellm.proxy ?? {}) as Record<string, unknown>;
  const chart = (proxy.chart ?? {}) as Record<string, unknown>;
  const repo = chart.repo;
  const name = chart.name;
  if (typeof repo !== "string" || typeof name !== "string") {
    throw new Error(
      `litellm.proxy.chart.repo / .name not found in ${APPS_VALUES_PATH}`,
    );
  }
  if (chart.version !== version) {
    throw new Error(
      `chart version disagreement: ${VERSIONS_PATH} charts.litellm is ${version} but ` +
        `${APPS_VALUES_PATH} litellm.proxy.chart.version is ${String(chart.version)}`,
    );
  }
  return { repo, name, version };
}

async function run(
  cmd: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const p = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { stdout, stderr, code };
}

/**
 * The minimum values that let the whole chart render. The Ingress reads only
 * ingress.*, the three service ports and the fullnames, but `helm template`
 * evaluates every template, and the gateway Deployment requires a database
 * host and a master key. fullnameOverride matches the Application
 * (charts/applications/templates/litellm.yaml) so the rendered Service names
 * are the ones charts/litellm-config addresses.
 */
const RENDER_SETS = [
  "ingress.enabled=true",
  "ingress.controller=alb",
  "fullnameOverride=litellm",
  "masterKey.secretName=route-drift-gate",
  "masterKey.secretKey=master-key",
  "database.writer.host=route-drift-gate",
  "database.writer.dbname=litellm",
  "database.writer.passwordSecret.name=route-drift-gate",
  "database.writer.passwordSecret.usernameKey=username",
  "database.writer.passwordSecret.passwordKey=password",
];

async function renderUpstreamIngress(pin: ChartPin): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "litellm-route-drift-"));
  try {
    const repo = pin.repo.replace(/\/+$/, "");
    const chartRef = repo.startsWith("oci://")
      ? [`${repo}/${pin.name}`]
      : [`oci://${repo}/${pin.name}`];
    log.info(`helm pull ${chartRef[0]} --version ${pin.version}`);
    const pull = await run([
      "helm",
      "pull",
      ...chartRef,
      "--version",
      pin.version,
      "--untar",
      "-d",
      dir,
    ]);
    if (pull.code !== 0) {
      throw new Error(
        `helm pull failed for ${chartRef[0]}@${pin.version}:\n${pull.stderr}`,
      );
    }
    const args = ["helm", "template", "litellm", join(dir, pin.name)];
    args.push("--show-only", "templates/ingress.yaml");
    for (const s of RENDER_SETS) args.push("--set", s);
    const tmpl = await run(args);
    if (tmpl.code !== 0) {
      throw new Error(
        `helm template failed for ${pin.name}@${pin.version}:\n${tmpl.stderr}\n` +
          "If the chart gained a new required value, add it to RENDER_SETS.",
      );
    }
    return tmpl.stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// Main
// ============================================================================

function usage(): never {
  console.error(
    "usage: bun scripts/litellm-route-drift.ts [--ingress-file <path>] [--values-file <path>]",
  );
  process.exit(2);
}

async function main(argv: string[]): Promise<number> {
  let ingressFile: string | undefined;
  let valuesFile = ROUTE_VALUES_PATH;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ingress-file") {
      const v = argv[++i];
      if (!v) usage();
      ingressFile = v;
    } else if (a === "--values-file") {
      const v = argv[++i];
      if (!v) usage();
      valuesFile = v;
    } else {
      usage();
    }
  }

  const cfg = parseConfiguredRoutes(await readFile(valuesFile, "utf8"));

  let ingressYaml: string;
  if (ingressFile) {
    log.info(`reading the rendered Ingress from ${ingressFile}`);
    ingressYaml = await readFile(ingressFile, "utf8");
  } else {
    const pin = resolveChartPin(
      await readFile(VERSIONS_PATH, "utf8"),
      await readFile(APPS_VALUES_PATH, "utf8"),
    );
    ingressYaml = await renderUpstreamIngress(pin);
  }

  const rendered = extractRenderedRoutes(ingressYaml, cfg);
  const findings = diffRoutes(rendered, cfg);

  if (findings.length > 0) {
    log.fail(renderFindings(findings));
    return 1;
  }
  log.ok(
    `route.* matches the upstream Ingress: ` +
      `${rendered.gatewayPathPrefixes.length} gateway prefixes and ` +
      `${rendered.gatewayExactPaths.length} exact paths rendered ` +
      `(${EXEMPT_GATEWAY_PATHS.size} dropped on purpose), ` +
      `${rendered.uiExactPaths.length} UI exact and ${rendered.uiPathPrefixes.length} UI prefixes`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    log.fail(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
