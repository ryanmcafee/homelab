#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env --allow-read --allow-write

/**
 * crd-schemas-vendor.ts
 *
 * Vendors Kubernetes CustomResourceDefinition JSON schemas from the pinned operator
 * Helm charts (and, where a chart doesn't ship the real schema, directly from the
 * upstream project's GitHub repo) into tests/schemas/, so `kubeconform -strict` can
 * validate every custom resource this repo renders completely offline, with no
 * `-skip` list.
 *
 * Source of truth for chart versions is ALWAYS configuration/versions.yaml
 * (`charts.<versionKey>`) — never hard-code a version here or in sources.yaml.
 *
 * Usage:
 *   task schemas:vendor
 *   deno run --allow-net --allow-run --allow-env --allow-read --allow-write \
 *     scripts/crd-schemas-vendor.ts [flags]
 *
 * Flags:
 *   --help            Show this help and exit 0
 *   --dry-run         List the files that would be written, without writing them
 *   --only <name>     Only process the named source (repeatable)
 *   --check           Regenerate into a temp dir and diff against tests/schemas/;
 *                      exit 1 if anything would change (used by CI to catch a
 *                      Renovate chart bump that wasn't re-vendored)
 *   --sources <path>  Path to sources.yaml (default: tests/schemas/sources.yaml)
 *   --out <dir>       Output directory (default: tests/schemas)
 *
 * Exit codes: 0 = success (or --check found no drift); 1 = failure / drift found;
 * 2 = argument error.
 */

import { parse as parseYaml, parseAll } from "jsr:@std/yaml@^1";

// ============================================================================
// Logging
// ============================================================================
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const log = {
  info: (msg: string) => console.log(`${cyan("INFO")}  ${msg}`),
  ok: (msg: string) => console.log(`${green("OK")}    ${msg}`),
  warn: (msg: string) => console.log(`${yellow("WARN")}  ${msg}`),
  error: (msg: string) => console.error(`${red("ERROR")} ${msg}`),
};

// ============================================================================
// Constants
// ============================================================================
const VERSIONS_PATH = "configuration/versions.yaml";
const DEFAULT_SOURCES_PATH = "tests/schemas/sources.yaml";
const DEFAULT_OUT_DIR = "tests/schemas";
const DRAFT07_SCHEMA = "http://json-schema.org/draft-07/schema#";

// Schema-composition keywords whose values are themselves (nested) schemas and
// therefore need the same strip/convert treatment recursively.
const SCHEMA_KEYWORD_KEYS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf"]);

// ============================================================================
// CLI args
// ============================================================================
interface Args {
  help: boolean;
  dryRun: boolean;
  check: boolean;
  only: string[];
  sourcesPath: string;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    dryRun: false,
    check: false,
    only: [],
    sourcesPath: DEFAULT_SOURCES_PATH,
    outDir: DEFAULT_OUT_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--check") args.check = true;
    else if (a === "--only") {
      const v = argv[++i];
      if (!v) {
        log.error("--only requires a value");
        Deno.exit(2);
      }
      args.only.push(v);
    } else if (a.startsWith("--only=")) {
      args.only.push(a.slice("--only=".length));
    } else if (a === "--sources") {
      const v = argv[++i];
      if (!v) {
        log.error("--sources requires a value");
        Deno.exit(2);
      }
      args.sourcesPath = v;
    } else if (a.startsWith("--sources=")) {
      args.sourcesPath = a.slice("--sources=".length);
    } else if (a === "--out") {
      const v = argv[++i];
      if (!v) {
        log.error("--out requires a value");
        Deno.exit(2);
      }
      args.outDir = v;
    } else if (a.startsWith("--out=")) {
      args.outDir = a.slice("--out=".length);
    } else {
      log.error(`Unknown argument: ${a}`);
      Deno.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    `crd-schemas-vendor.ts — vendor CRD JSON schemas for offline kubeconform

Usage:
  task schemas:vendor
  deno run --allow-net --allow-run --allow-env --allow-read --allow-write \\
    scripts/crd-schemas-vendor.ts [flags]

Flags:
  --help, -h         Show this help and exit 0
  --dry-run          List files that would be written; do not write them
  --only <name>      Only process the named source (repeatable)
  --check            Regenerate into a temp dir, diff against the output dir,
                     and exit 1 if anything is missing or different (combined
                     with --only, "removed" detection is scoped to just the
                     CRD group directories the selected source(s) touch)
  --sources <path>   Path to sources.yaml (default: ${DEFAULT_SOURCES_PATH})
  --out <dir>        Output directory (default: ${DEFAULT_OUT_DIR})

Exit codes:
  0  Success (or --check found no drift)
  1  Failure, or --check found drift
  2  Argument error
`,
  );
}

// ============================================================================
// Types
// ============================================================================
interface ChartSource {
  repo: string;
  name: string;
}

interface GithubSource {
  repo: string; // e.g. "cilium/cilium"
  ref: string; // e.g. "v{version}" or "argo-workflows-{version}"
  paths: string[]; // directories containing one CRD manifest per file
}

interface Source {
  name: string;
  versionKey: string;
  chart?: ChartSource;
  github?: GithubSource;
  helmArgs?: string[];
  kinds: string[];
}

interface SourcesFile {
  sources: Source[];
}

interface Versions {
  charts: Record<string, string>;
  tools?: Record<string, string>;
}

// A single `apiextensions.k8s.io/v1 CustomResourceDefinition` document.
// deno-lint-ignore no-explicit-any
type CRD = any;

interface PlannedFile {
  path: string;
  content: string;
}

// ============================================================================
// Shell helper
// ============================================================================
async function run(
  cmd: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await p.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

// ============================================================================
// Load configuration
// ============================================================================
async function loadVersions(path: string): Promise<Versions> {
  const text = await Deno.readTextFile(path);
  return parseYaml(text) as Versions;
}

async function loadSources(path: string): Promise<SourcesFile> {
  const text = await Deno.readTextFile(path);
  return parseYaml(text) as SourcesFile;
}

function resolveKubeVersion(versions: Versions): string {
  const raw = versions.tools?.kubernetes;
  if (!raw) {
    throw new Error(
      `tools.kubernetes not found in ${VERSIONS_PATH}; needed for helm template --kube-version`,
    );
  }
  return raw.replace(/^v/, "");
}

function resolveChartVersion(versions: Versions, versionKey: string): string {
  const v = versions.charts[versionKey];
  if (!v) {
    throw new Error(
      `charts.${versionKey} not found in ${VERSIONS_PATH} (sources.yaml versionKey mismatch)`,
    );
  }
  return v;
}

// ============================================================================
// CRD document helpers
// ============================================================================
function isCRDDoc(doc: unknown): doc is CRD {
  return (
    !!doc &&
    typeof doc === "object" &&
    (doc as Record<string, unknown>).kind === "CustomResourceDefinition"
  );
}

function crdKind(doc: CRD): string | undefined {
  return doc?.spec?.names?.kind;
}

function crdGroup(doc: CRD): string | undefined {
  return doc?.spec?.group;
}

// ============================================================================
// Fetch: Helm chart sources
// ============================================================================
async function fetchChartCRDs(
  source: Source,
  version: string,
  kubeVersion: string,
): Promise<CRD[]> {
  const chart = source.chart!;
  const tmpDir = await Deno.makeTempDir({ prefix: "crd-vendor-chart-" });
  try {
    log.info(
      `[${source.name}] helm pull --repo ${chart.repo} ${chart.name} --version ${version}`,
    );
    const pull = await run([
      "helm",
      "pull",
      "--repo",
      chart.repo,
      chart.name,
      "--version",
      version,
      "--untar",
      "-d",
      tmpDir,
    ]);
    if (pull.code !== 0) {
      throw new Error(
        `helm pull failed for source "${source.name}" (${chart.repo} ${chart.name}@${version}):\n${pull.stderr}`,
      );
    }
    const chartDir = `${tmpDir}/${chart.name}`;

    const pool = new Map<string, CRD>(); // keyed by metadata.name, de-duped

    // Step 1: the cheap path — the special crds/ chart directory.
    const showCrds = await run(["helm", "show", "crds", chartDir]);
    if (showCrds.code === 0 && showCrds.stdout.trim().length > 0) {
      for (const doc of parseAll(showCrds.stdout) as unknown[]) {
        if (isCRDDoc(doc)) pool.set(doc.metadata.name, doc);
      }
    }

    // Step 2: if any requested kind is still missing, fall back to a full
    // render (--include-crds also renders CRDs templated under templates/,
    // which `helm show crds` never sees).
    const haveKinds = new Set(
      [...pool.values()].map((d) => crdKind(d)).filter(Boolean),
    );
    const missing = source.kinds.filter((k) => !haveKinds.has(k));
    if (missing.length > 0) {
      const helmArgs = source.helmArgs ?? [];
      log.info(
        `[${source.name}] helm show crds missing ${
          missing.join(", ")
        }; falling back to helm template --include-crds`,
      );
      const tmpl = await run([
        "helm",
        "template",
        "crd-vendor",
        chartDir,
        "--include-crds",
        "--kube-version",
        kubeVersion,
        ...helmArgs,
      ]);
      if (tmpl.code !== 0) {
        throw new Error(
          `helm template --include-crds failed for source "${source.name}":\n${tmpl.stderr}`,
        );
      }
      for (const doc of parseAll(tmpl.stdout) as unknown[]) {
        if (isCRDDoc(doc)) pool.set(doc.metadata.name, doc);
      }
    }

    return [...pool.values()];
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ============================================================================
// Fetch: raw GitHub sources
// ============================================================================
interface GithubContentEntry {
  name: string;
  type: string;
  download_url: string | null;
}

async function fetchGithubCRDs(
  source: Source,
  version: string,
): Promise<CRD[]> {
  const gh = source.github!;
  const ref = gh.ref.replace("{version}", version);
  const pool = new Map<string, CRD>();

  for (const path of gh.paths) {
    const apiUrl =
      `https://api.github.com/repos/${gh.repo}/contents/${path}?ref=${
        encodeURIComponent(ref)
      }`;
    log.info(`[${source.name}] GET ${apiUrl}`);
    const res = await fetch(apiUrl, {
      headers: { "User-Agent": "homelab-crd-schemas-vendor" },
    });
    if (!res.ok) {
      throw new Error(
        `GitHub contents API failed for source "${source.name}" (${apiUrl}): ${res.status} ${res.statusText}`,
      );
    }
    const entries = (await res.json()) as GithubContentEntry[];
    const yamlFiles = entries.filter(
      (e) => e.type === "file" && e.name.endsWith(".yaml"),
    );
    for (const entry of yamlFiles) {
      if (!entry.download_url) continue;
      const raw = await fetch(entry.download_url);
      if (!raw.ok) {
        throw new Error(
          `Failed to download ${entry.download_url} for source "${source.name}": ${raw.status}`,
        );
      }
      const text = await raw.text();
      for (const doc of parseAll(text) as unknown[]) {
        if (isCRDDoc(doc)) pool.set(doc.metadata.name, doc);
      }
    }
  }

  return [...pool.values()];
}

// ============================================================================
// Schema conversion
// ============================================================================
// deno-lint-ignore no-explicit-any
function convertNode(node: any): any {
  if (Array.isArray(node)) {
    return node.map((n) => convertNode(n));
  }
  if (node === null || typeof node !== "object") {
    return node;
  }

  const preserveUnknown = node["x-kubernetes-preserve-unknown-fields"] === true;
  const intOrString = node["x-kubernetes-int-or-string"] === true;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("x-kubernetes-")) continue;

    if (SCHEMA_KEYWORD_KEYS.has(key) && value && typeof value === "object") {
      // Map of name -> schema (properties, patternProperties, definitions, $defs)
      const converted: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        converted[k] = convertNode(v);
      }
      result[key] = converted;
    } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      result[key] = value.map((v) => convertNode(v));
    } else if (key === "additionalProperties") {
      // Either a boolean or a nested schema object.
      result[key] = typeof value === "boolean" ? value : convertNode(value);
    } else if (key === "items" || key === "not") {
      result[key] = convertNode(value);
    } else {
      result[key] = value;
    }
  }

  // additionalProperties left as-is per kubeconform -strict semantics, EXCEPT
  // where the original CRD explicitly opted into an open/unknown-fields map:
  // without this, kubeconform -strict rejects any object whose schema has no
  // `properties` and no explicit `additionalProperties` (treats it as closed).
  if (preserveUnknown && !("additionalProperties" in result)) {
    result.additionalProperties = true;
  }

  // int-or-string fields normally already carry an `anyOf: [integer, string]`
  // (the Kubernetes structural-schema convention) alongside the marker; only
  // synthesize one if it's genuinely missing.
  if (
    intOrString && !("oneOf" in result) && !("anyOf" in result)
  ) {
    result.oneOf = [{ type: "integer" }, { type: "string" }];
  }

  return result;
}

function ensureEnvelopeProperties(schema: Record<string, unknown>): void {
  if (schema.type === undefined) schema.type = "object";
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  if (!properties.apiVersion) properties.apiVersion = { type: "string" };
  if (!properties.kind) properties.kind = { type: "string" };
  if (!properties.metadata) properties.metadata = { type: "object" };
  schema.properties = properties;
}

function convertSchema(openAPIV3Schema: unknown): Record<string, unknown> {
  const base = (openAPIV3Schema ?? { type: "object" }) as Record<
    string,
    unknown
  >;
  const converted = convertNode(base) as Record<string, unknown>;
  ensureEnvelopeProperties(converted);
  return { $schema: DRAFT07_SCHEMA, ...converted };
}

// ============================================================================
// Deterministic JSON serialization (sorted keys, 2-space indent, trailing \n)
// ============================================================================
// deno-lint-ignore no-explicit-any
function sortKeysDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

function toDeterministicJSON(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + "\n";
}

// ============================================================================
// Plan: turn fetched CRDs into the files this run would produce
// ============================================================================
function planFilesForSource(
  source: Source,
  crds: CRD[],
  outDir: string,
): { files: PlannedFile[]; foundKinds: Set<string> } {
  const files: PlannedFile[] = [];
  const foundKinds = new Set<string>();
  const wantedKinds = new Set(source.kinds);

  for (const crd of crds) {
    const kind = crdKind(crd);
    const group = crdGroup(crd);
    if (!kind || !group || !wantedKinds.has(kind)) continue;
    foundKinds.add(kind);

    const versions = crd.spec?.versions ?? [];
    for (const v of versions) {
      const schema = convertSchema(v?.schema?.openAPIV3Schema);
      const path = `${outDir}/${group}/${kind.toLowerCase()}_${v.name}.json`;
      files.push({ path, content: toDeterministicJSON(schema) });
    }
  }

  return { files, foundKinds };
}

// ============================================================================
// Process one source end-to-end
// ============================================================================
async function processSource(
  source: Source,
  versions: Versions,
  kubeVersion: string,
  outDir: string,
): Promise<PlannedFile[]> {
  const version = resolveChartVersion(versions, source.versionKey);
  log.info(`[${source.name}] versionKey=${source.versionKey} -> ${version}`);

  let crds: CRD[];
  if (source.chart) {
    crds = await fetchChartCRDs(source, version, kubeVersion);
  } else if (source.github) {
    crds = await fetchGithubCRDs(source, version);
  } else {
    throw new Error(
      `source "${source.name}" has neither "chart" nor "github" configured`,
    );
  }

  const { files, foundKinds } = planFilesForSource(source, crds, outDir);
  const missing = source.kinds.filter((k) => !foundKinds.has(k));
  if (missing.length > 0) {
    const available = [...new Set(crds.map((c) => crdKind(c)).filter(Boolean))]
      .sort();
    throw new Error(
      `source "${source.name}": kind(s) ${
        missing.join(", ")
      } not found. Available kinds in this source: ${
        available.length > 0 ? available.join(", ") : "(none)"
      }`,
    );
  }

  log.ok(
    `[${source.name}] ${files.length} schema file(s) from ${foundKinds.size} kind(s)`,
  );
  return files;
}

// ============================================================================
// Diffing for --check
// ============================================================================
async function readExistingSchemaFiles(
  outDir: string,
): Promise<Map<string, string>> {
  const existing = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(full);
      } else if (entry.isFile && entry.name.endsWith(".json")) {
        existing.set(full, await Deno.readTextFile(full));
      }
    }
  }
  await walk(outDir);
  return existing;
}

// ============================================================================
// Write plan to disk
// ============================================================================
async function writeFiles(files: PlannedFile[]): Promise<void> {
  for (const file of files) {
    const idx = file.path.lastIndexOf("/");
    const dir = idx >= 0 ? file.path.substring(0, idx) : ".";
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(file.path, file.content);
  }
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<number> {
  const args = parseArgs(Deno.args);

  if (args.help) {
    printHelp();
    return 0;
  }

  const versions = await loadVersions(VERSIONS_PATH);
  const kubeVersion = resolveKubeVersion(versions);
  const sourcesFile = await loadSources(args.sourcesPath);

  let sources = sourcesFile.sources;
  if (args.only.length > 0) {
    const wanted = new Set(args.only);
    sources = sources.filter((s) => wanted.has(s.name));
    const foundNames = new Set(sources.map((s) => s.name));
    for (const name of wanted) {
      if (!foundNames.has(name)) {
        log.error(`--only "${name}" does not match any source name`);
        return 2;
      }
    }
  }

  if (sources.length === 0) {
    log.warn("No sources selected; nothing to do.");
    return 0;
  }

  // --check regenerates into an isolated temp dir so the working tree's
  // tests/schemas/ is never touched while diffing.
  const targetOutDir = args.check
    ? await Deno.makeTempDir({ prefix: "crd-vendor-check-" })
    : args.outDir;

  const allFiles: PlannedFile[] = [];
  const errors: string[] = [];
  for (const source of sources) {
    try {
      const files = await processSource(
        source,
        versions,
        kubeVersion,
        targetOutDir,
      );
      allFiles.push(...files);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (errors.length > 0) {
    for (const e of errors) log.error(e);
    if (args.check) {
      await Deno.remove(targetOutDir, { recursive: true }).catch(() => {});
    }
    return 1;
  }

  if (args.dryRun) {
    log.info(`Dry run — ${allFiles.length} file(s) would be written:`);
    for (const f of allFiles.sort((a, b) => a.path.localeCompare(b.path))) {
      console.log(`  ${f.path}`);
    }
    return 0;
  }

  if (args.check) {
    await writeFiles(allFiles);
    const generated = new Map(allFiles.map((f) => [f.path, f.content]));
    const existing = await readExistingSchemaFiles(args.outDir);

    const generatedRelPaths = new Set(
      [...generated.keys()].map((p) => p.slice(targetOutDir.length + 1)),
    );
    const existingRelPaths = new Set(
      [...existing.keys()].map((p) => p.slice(args.outDir.length + 1)),
    );

    // Scope "removed" detection to only the CRD group directories this run
    // actually touched, so `--check --only <name>` doesn't report every other
    // source's files as spuriously "removed".
    const touchedGroups = new Set(
      [...generatedRelPaths].map((p) => p.split("/")[0]),
    );

    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];

    for (const relPath of generatedRelPaths) {
      const genContent = generated.get(`${targetOutDir}/${relPath}`)!;
      const existingContent = existing.get(`${args.outDir}/${relPath}`);
      if (existingContent === undefined) added.push(relPath);
      else if (existingContent !== genContent) changed.push(relPath);
    }
    for (const relPath of existingRelPaths) {
      const group = relPath.split("/")[0];
      if (!generatedRelPaths.has(relPath) && touchedGroups.has(group)) {
        removed.push(relPath);
      }
    }

    await Deno.remove(targetOutDir, { recursive: true }).catch(() => {});

    if (added.length === 0 && changed.length === 0 && removed.length === 0) {
      log.ok(
        `${args.outDir} is up to date with ${args.sourcesPath} (${generated.size} files)`,
      );
      return 0;
    }

    log.error(
      `${args.outDir} is out of date with ${args.sourcesPath} — run \`task schemas:vendor\` and commit the result.`,
    );
    for (const f of added.sort()) console.log(`  ${green("added")}    ${f}`);
    for (const f of changed.sort()) console.log(`  ${yellow("changed")}  ${f}`);
    for (const f of removed.sort()) console.log(`  ${red("removed")}  ${f}`);
    return 1;
  }

  await writeFiles(allFiles);
  log.ok(`Wrote ${allFiles.length} schema file(s) to ${args.outDir}`);
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
