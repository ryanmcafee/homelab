#!/usr/bin/env bun

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNotFound } from "./lib/errors.ts";
import { parse, parseAll } from "./lib/yaml.ts";

/**
 * upstream-values-check.ts
 *
 * Fail when an Application passes `spec.source.helm` values the upstream chart
 * does not declare.
 *
 * A chart without a `values.schema.json` — which is nearly all of them —
 * silently ignores keys it does not know. Helm renders, kubeconform validates,
 * the snapshot records the dead key as expected output and ArgoCD reports
 * Synced. Nothing in this repository's level-0 contract can see it, because
 * every one of those steps is working as designed. Measured on
 * charts/addons/values.yaml in MCAA-396: `spegel.registries` (the chart calls
 * it `mirroredRegistries`), `spegel.resolveLatestTag` (`registryFilters`) and
 * `spegel.appendMirrors` (`prependExisting`) had been inert for the whole life
 * of the pin, and ten registry entries never reached the DaemonSet.
 *
 * The check pulls each pinned chart, collects the key paths the chart and its
 * vendored dependencies declare, and reports every path an Application sets
 * that is not among them.
 *
 *   task upstream:values                  check every environment
 *   task upstream:values -- --env homelab one environment
 *   task upstream:values -- --json        machine-readable result
 *
 * NOT LEVEL 0. `helm pull` reaches the network, and level 0 is network-free by
 * contract. This runs in .github/workflows/upgrade.yml, which is also where a
 * Renovate bump lands — a chart that renames a key in a minor version is the
 * case this exists for, and pr-contract.yml skips `renovate/*` heads.
 *
 * WHAT COUNTS AS DECLARED. Three rules, each measured against real charts
 * rather than assumed:
 *
 *   Dependencies. `helm show values` prints the parent's values.yaml only, so
 *   every key of a vendored subchart reads as undeclared. Dependencies are
 *   merged under their `alias` (else `name`), except `type: library` charts,
 *   which merge at the root — that is where TrueCharts' `common` declares
 *   `TZ`, `workload` and `persistence` for every app that depends on it.
 *
 *   Wrapped defaults. A values.yaml whose only top-level key is underscore-
 *   prefixed is a defaults wrapper, not a real key: istio 1.31 ships
 *   `_internal_defaults_do_not_set` and merges it itself. Unwrapping keeps the
 *   istio charts checked instead of allowlisted whole.
 *
 *   Unconstrained defaults. An upstream default of `{}` or null declares the
 *   key as free-form, so anything below it is accepted: `resources: {}` is an
 *   invitation to set `resources.limits.cpu`. A key whose default is a
 *   populated map is not free-form, which is why the spegel keys are reported:
 *   `spegel` has real children, so `spegel.registries` has no open ancestor.
 *
 * Whatever those rules cannot settle goes in the allowlist with a reason, one
 * entry per chart and path prefix. An entry that no longer matches anything is
 * a failure, so a key upstream has since declared cannot sit there forever.
 */

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const log = {
  ok: (m: string) => console.log(`${green("PASS")} ${m}`),
  fail: (m: string) => console.error(`${red("FAIL")} ${m}`),
  info: (m: string) => console.log(`${cyan("INFO")} ${m}`),
  warn: (m: string) => console.log(`${yellow("WARN")} ${m}`),
};

export const SNAPSHOT_ROOT = "tests/snapshots";
export const ALLOWLIST_PATH = "tests/gitops/upstream-values-allowlist.yaml";
export const DEFAULT_ENVS = ["homelab", "localdev"];

/** Concurrent `helm pull` invocations. */
const PULL_PARALLEL = 6;

/** One Application Helm source pinned to an upstream chart. */
export interface ChartSource {
  env: string;
  app: string;
  repoURL: string;
  chart: string;
  targetRevision: string;
  values: unknown;
}

/** A key path an Application sets that the chart does not declare. */
export interface Finding {
  env: string;
  app: string;
  chart: string;
  targetRevision: string;
  path: string;
}

/** One hole in the rule, argued for in `reason`. */
export interface AllowEntry {
  chart: string;
  path: string;
  reason: string;
}

/**
 * How a chart declares a key. "open" is an empty map or null — free-form, so
 * anything below it is declared too. "set" is anything else.
 */
export type Declaration = "open" | "set";

/** The chart argument and `--repo` URL helm needs for an ArgoCD source.
 *
 * ArgoCD writes OCI repositories without a scheme (`ghcr.io/renovatebot/charts`);
 * helm needs `oci://<repo>/<chart>`. An http(s) repository is passed with
 * `--repo`. Mirrors chartRef in internal/verify/upgrade.go. */
export function chartRef(
  repoURL: string,
  chart: string,
): { ref: string; repo: string } {
  const u = repoURL.trim().replace(/\/+$/, "");
  if (u.startsWith("oci://")) return { ref: `${u}/${chart}`, repo: "" };
  if (u.includes("://")) return { ref: chart, repo: u };
  return { ref: `oci://${u}/${chart}`, repo: "" };
}

/**
 * Unwrap a values document whose only top-level key is underscore-prefixed.
 *
 * istio 1.31 ships every default under `_internal_defaults_do_not_set` and
 * merges it in `templates/_helpers.tpl`, so the real key surface is one level
 * down. A document with any other top-level key is returned unchanged.
 */
export function unwrapDefaults(values: unknown): unknown {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return values;
  }
  const keys = Object.keys(values as Record<string, unknown>);
  if (keys.length !== 1 || !keys[0].startsWith("_")) return values;
  return (values as Record<string, unknown>)[keys[0]];
}

/**
 * Flatten a values document to dotted key paths.
 *
 * Arrays are leaves: helm replaces a list wholesale rather than merging it, so
 * an index carries no declaration.
 */
export function declaredPaths(
  values: unknown,
  prefix = "",
  into = new Map<string, Declaration>(),
): Map<string, Declaration> {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return into;
  }
  for (const [key, child] of Object.entries(values as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    into.set(path, isOpen(child) ? "open" : "set");
    declaredPaths(child, path, into);
  }
  return into;
}

/** An empty map or null: the chart declares the key without constraining it. */
function isOpen(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).length === 0;
}

/** Every ancestor of a dotted path, nearest first. */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  for (let i = path.lastIndexOf("."); i > 0; i = path.lastIndexOf(".", i - 1)) {
    out.push(path.slice(0, i));
  }
  return out;
}

/**
 * Key paths set here that the chart does not declare, shallowest first.
 *
 * Recursion stops at the first undeclared path: once `spegel.registries` is
 * reported there is nothing to learn from its children, and the shallowest
 * path is the one somebody has to fix.
 */
export function undeclaredPaths(
  ours: unknown,
  declared: Map<string, Declaration>,
  prefix = "",
  into: string[] = [],
): string[] {
  if (ours === null || typeof ours !== "object" || Array.isArray(ours)) {
    return into;
  }
  for (const [key, child] of Object.entries(ours as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (declared.has(path)) {
      undeclaredPaths(child, declared, path, into);
    } else if (!ancestorsOf(path).some((a) => declared.get(a) === "open")) {
      into.push(path);
    }
  }
  return into;
}

/** A chart's own values plus every dependency's, keyed as helm merges them. */
export interface ChartTree {
  values: unknown;
  /** Dependencies in `charts/`, already resolved recursively. */
  dependencies: { key: string; library: boolean; tree: ChartTree }[];
}

/**
 * The full declared key surface of a chart tree.
 *
 * A `type: library` dependency merges at the root: its values are the parent's
 * defaults, which is how every TrueCharts app inherits `TZ` and `workload`
 * from `common`. Any other dependency merges under its alias or name.
 */
export function treePaths(
  tree: ChartTree,
  prefix = "",
  into = new Map<string, Declaration>(),
): Map<string, Declaration> {
  for (const [path, kind] of declaredPaths(unwrapDefaults(tree.values))) {
    into.set(prefix ? `${prefix}.${path}` : path, kind);
  }
  for (const dep of tree.dependencies) {
    const depPrefix = dep.library
      ? prefix
      : prefix
        ? `${prefix}.${dep.key}`
        : dep.key;
    treePaths(dep.tree, depPrefix, into);
  }
  return into;
}

/** True when the allowlist covers this chart and path (or a prefix of it). */
export function isAllowed(finding: Finding, allow: AllowEntry[]): boolean {
  return allow.some(
    (e) =>
      e.chart === finding.chart &&
      (finding.path === e.path || finding.path.startsWith(`${e.path}.`)),
  );
}

/** Allowlist entries that matched nothing: upstream declares the key now. */
export function unusedEntries(
  findings: Finding[],
  allow: AllowEntry[],
): AllowEntry[] {
  return allow.filter(
    (e) => !findings.some((f) => isAllowed(f, [e])),
  );
}

/** Parse the allowlist document. Every field is required. */
export function parseAllowlist(content: string): AllowEntry[] {
  const doc = parse(content);
  const raw = (doc as { allow?: unknown } | null)?.allow;
  if (!Array.isArray(raw)) {
    throw new Error(`${ALLOWLIST_PATH}: expected a top-level "allow" list`);
  }
  return raw.map((item, i) => {
    const e = item as Partial<AllowEntry> | null;
    for (const field of ["chart", "path", "reason"] as const) {
      if (typeof e?.[field] !== "string" || e[field].trim() === "") {
        throw new Error(
          `${ALLOWLIST_PATH}: allow[${i}] is missing a non-empty "${field}"`,
        );
      }
    }
    const entry = e as AllowEntry;
    return {
      chart: entry.chart,
      path: entry.path,
      reason: entry.reason.trim(),
    };
  });
}

/**
 * Every Application in a rendered snapshot that points at an upstream chart
 * and passes values. `helm.values` is a YAML string; `helm.valuesObject` is
 * already parsed. Both may be present, and helm merges values under
 * valuesObject, so the union is what reaches the chart.
 */
export function sourcesInDocuments(
  documents: unknown[],
  env: string,
): ChartSource[] {
  const out: ChartSource[] = [];
  for (const doc of documents) {
    const d = doc as {
      kind?: unknown;
      metadata?: { name?: unknown };
      spec?: {
        source?: {
          repoURL?: unknown;
          chart?: unknown;
          targetRevision?: unknown;
          helm?: { values?: unknown; valuesObject?: unknown };
        };
      };
    } | null;
    if (d?.kind !== "Application") continue;
    const src = d.spec?.source;
    if (
      typeof src?.chart !== "string" ||
      typeof src.targetRevision !== "string" ||
      typeof src.repoURL !== "string"
    ) {
      continue;
    }
    const values = mergeValues(
      typeof src.helm?.values === "string" ? parse(src.helm.values) : null,
      src.helm?.valuesObject ?? null,
    );
    if (values === null) continue;
    out.push({
      env,
      app: typeof d.metadata?.name === "string" ? d.metadata.name : "<unnamed>",
      repoURL: src.repoURL,
      chart: src.chart,
      targetRevision: src.targetRevision,
      values,
    });
  }
  return out;
}

/** Deep-merge two values documents the way helm merges values sources. */
export function mergeValues(lower: unknown, upper: unknown): unknown {
  if (upper === null || upper === undefined) return lower ?? null;
  if (lower === null || lower === undefined) return upper;
  if (
    typeof lower !== "object" ||
    Array.isArray(lower) ||
    typeof upper !== "object" ||
    Array.isArray(upper)
  ) {
    return upper;
  }
  const out: Record<string, unknown> = { ...(lower as Record<string, unknown>) };
  for (const [k, v] of Object.entries(upper as Record<string, unknown>)) {
    out[k] = k in out ? mergeValues(out[k], v) : v;
  }
  return out;
}

/** Read every Application chart source out of one environment's snapshot. */
export function collectSources(repoRoot: string, env: string): ChartSource[] {
  const dir = join(repoRoot, SNAPSHOT_ROOT, env);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(`no rendered snapshot for environment "${env}" (${dir})`);
    }
    throw err;
  }
  const out: ChartSource[] = [];
  for (const file of entries.sort()) {
    if (!file.endsWith(".yaml")) continue;
    const content = readFileSync(join(dir, file), "utf8");
    out.push(...sourcesInDocuments(parseAll(content), env));
  }
  return out;
}

/** Read an untarred chart directory and its vendored dependencies. */
export function readChartTree(dir: string): ChartTree {
  const values = readYamlIfPresent(join(dir, "values.yaml"));
  const chart = readYamlIfPresent(join(dir, "Chart.yaml")) as {
    dependencies?: { name?: unknown; alias?: unknown }[];
  } | null;
  const aliases = new Map<string, string>();
  for (const dep of chart?.dependencies ?? []) {
    if (typeof dep?.name === "string" && typeof dep.alias === "string") {
      aliases.set(dep.name, dep.alias);
    }
  }
  const dependencies: ChartTree["dependencies"] = [];
  for (const name of listDirectories(join(dir, "charts"))) {
    const subdir = join(dir, "charts", name);
    const subChart = readYamlIfPresent(join(subdir, "Chart.yaml")) as {
      type?: unknown;
    } | null;
    dependencies.push({
      key: aliases.get(name) ?? name,
      library: subChart?.type === "library",
      tree: readChartTree(subdir),
    });
  }
  return { values, dependencies };
}

function readYamlIfPresent(path: string): unknown {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function listDirectories(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return entries
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/** A chart pinned to one version, as the cache keys it. */
export function cacheKey(source: ChartSource): string {
  const { ref, repo } = chartRef(source.repoURL, source.chart);
  return `${repo ? `${repo}/` : ""}${ref}@${source.targetRevision}`;
}

/** `helm pull` arguments for one source. */
export function pullArgs(source: ChartSource, untardir: string): string[] {
  const { ref, repo } = chartRef(source.repoURL, source.chart);
  const args = ["pull", ref, "--version", source.targetRevision];
  if (repo) args.push("--repo", repo);
  return [...args, "--untar", "--untardir", untardir];
}

async function pullChart(
  source: ChartSource,
  untardir: string,
): Promise<{ dir: string } | { error: string }> {
  const proc = Bun.spawn(["helm", ...pullArgs(source, untardir)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    return { error: stderr.trim().split("\n").slice(-3).join(" ") };
  }
  return { dir: join(untardir, source.chart) };
}

/** Resolve the declared key surface of every distinct pinned chart. */
async function resolveCharts(
  sources: ChartSource[],
  workdir: string,
): Promise<{
  declared: Map<string, Map<string, Declaration>>;
  errors: { key: string; error: string }[];
}> {
  const unique = new Map<string, ChartSource>();
  for (const s of sources) if (!unique.has(cacheKey(s))) unique.set(cacheKey(s), s);

  const declared = new Map<string, Map<string, Declaration>>();
  const errors: { key: string; error: string }[] = [];
  const queue = [...unique.entries()];

  const worker = async (slot: number) => {
    for (let i = slot; i < queue.length; i += PULL_PARALLEL) {
      const [key, source] = queue[i];
      const untardir = join(workdir, String(i));
      const result = await pullChart(source, untardir);
      if ("error" in result) {
        errors.push({ key, error: result.error });
        continue;
      }
      declared.set(key, treePaths(readChartTree(result.dir)));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PULL_PARALLEL, queue.length) }, (_, i) =>
      worker(i),
    ),
  );
  return { declared, errors };
}

/** Compare every source against its chart. Sources with no chart are skipped. */
export function findingsFor(
  sources: ChartSource[],
  declared: Map<string, Map<string, Declaration>>,
): Finding[] {
  const out: Finding[] = [];
  for (const source of sources) {
    const paths = declared.get(cacheKey(source));
    if (!paths) continue;
    for (const path of undeclaredPaths(source.values, paths)) {
      out.push({
        env: source.env,
        app: source.app,
        chart: source.chart,
        targetRevision: source.targetRevision,
        path,
      });
    }
  }
  return out;
}

export function renderFindings(findings: Finding[]): string {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(
      `  ${f.env}/${f.app} [${f.chart}@${f.targetRevision}] sets ${red(f.path)}, which the chart does not declare`,
    );
  }
  return lines.join("\n");
}

interface Options {
  envs: string[];
  json: boolean;
  repoRoot: string;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    envs: [...DEFAULT_ENVS],
    json: false,
    repoRoot: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--env") opts.envs = splitEnvs(argv[++i]);
    else if (arg.startsWith("--env=")) opts.envs = splitEnvs(arg.slice(6));
    else if (arg === "--repo-root") opts.repoRoot = argv[++i] ?? opts.repoRoot;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function splitEnvs(value: string | undefined): string[] {
  const envs = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (envs.length === 0) throw new Error("--env needs at least one environment");
  return envs;
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const allow = parseAllowlist(
    readFileSync(join(opts.repoRoot, ALLOWLIST_PATH), "utf8"),
  );
  const sources = opts.envs.flatMap((env) => collectSources(opts.repoRoot, env));
  if (sources.length === 0) {
    log.fail(
      `no Application chart source with helm values in ${opts.envs.join(", ")}; the check inspected nothing`,
    );
    return 1;
  }

  const workdir = mkdtempSync(join(tmpdir(), "upstream-values-"));
  let declared: Map<string, Map<string, Declaration>>;
  let errors: { key: string; error: string }[];
  try {
    ({ declared, errors } = await resolveCharts(sources, workdir));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }

  const all = findingsFor(sources, declared);
  const reported = all.filter((f) => !isAllowed(f, allow));
  const unused = unusedEntries(all, allow);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          pass: reported.length === 0 && errors.length === 0 && unused.length === 0,
          inspected: { sources: sources.length, charts: declared.size },
          findings: reported,
          allowed: all.length - reported.length,
          unusedAllowEntries: unused,
          pullErrors: errors,
        },
        null,
        2,
      ),
    );
  }

  let failed = false;
  if (errors.length > 0) {
    failed = true;
    log.fail(
      `${errors.length} chart(s) could not be pulled, so their Applications were not checked at all`,
    );
    for (const e of errors) console.error(`  ${e.key}: ${e.error}`);
  }
  if (reported.length > 0) {
    failed = true;
    log.fail(
      `${reported.length} helm value(s) the upstream chart does not declare`,
    );
    console.error(renderFindings(reported));
    console.error(
      `\nEach one is inert: helm ignores it and the rendered manifest is unaffected. Fix the key,\nor add an entry with a reason to ${ALLOWLIST_PATH}.`,
    );
  }
  if (unused.length > 0) {
    failed = true;
    log.fail(
      `${unused.length} allowlist entr(ies) matched nothing; the chart declares the key now, so remove them`,
    );
    for (const e of unused) console.error(`  ${e.chart}: ${e.path}`);
  }
  if (failed) return 1;

  log.ok(
    `${sources.length} Application chart source(s) across ${declared.size} pinned chart(s) in ${opts.envs.join(", ")}: every helm value is declared upstream (${all.length} allowlisted)`,
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
