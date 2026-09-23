#!/usr/bin/env bun

/**
 * localdev-kind.ts
 *
 * Bootstraps the Kind cluster behind the localdev ArgoCD loop (issue #261,
 * Section B). Everything it creates lives in Docker on the workstation; it
 * never touches the homelab cluster (ADR-009).
 *
 * Subcommands:
 *   up                  Create the cluster if missing (node image from
 *                       configuration/versions.yaml images.kind-node), start
 *                       the registry pull-through caches, write containerd
 *                       hosts.toml into every node, install Cilium (chart pin
 *                       charts.cilium, values from
 *                       charts/addons/values-localdev.yaml cilium.values),
 *                       wait for Ready nodes, remove Kind's bundled
 *                       local-path-provisioner (the addon Application owns
 *                       it), apply localdev/fakes. Idempotent.
 *   down [--purge-cache]
 *                       Delete the cluster; --purge-cache also removes the
 *                       registry containers and the cache directory.
 *   fakes               (Re)apply localdev/fakes with server-side apply.
 *   registry up|down|status
 *                       Manage the pull-through caches (one registry:2 per
 *                       upstream on the `kind` Docker network, cache under
 *                       $HOMELAB_KIND_CACHE_DIR or ~/.cache/homelab-kind-registry).
 *   cilium              Install/upgrade Cilium only.
 *
 * Registry proxies are best-effort: containerd's hosts.toml lists the proxy
 * first and the upstream as the fallback, so a proxy that failed to start only
 * costs cache hits, never a pull. Their failures are WARN, never fatal.
 *
 * Usage:
 *   task localdev:kind                  (= up)
 *   task localdev:fakes                 (= fakes)
 *   task localdev:registry -- status
 *   bun scripts/localdev-kind.ts --help
 *   bun scripts/localdev-kind.ts up --dry-run
 *
 * Exit codes: 0 = success; 1 = a step failed; 2 = argument error.
 */

import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNotFound } from "./lib/errors.ts";
import {
  parseAll as parseAllYaml,
  parse as parseYaml,
  stringify as stringifyYaml,
} from "./lib/yaml.ts";

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
  dry: (msg: string) => console.log(`${yellow("DRY")}   ${msg}`),
};

// ============================================================================
// Constants
// ============================================================================
export const DEFAULT_CLUSTER = "homelab-localdev";
const KIND_CONFIG = "localdev/kind-config.yaml";
const VERSIONS_YAML = "configuration/versions.yaml";
const ADDONS_LOCALDEV_VALUES = "charts/addons/values-localdev.yaml";
const FAKES_DIR = "localdev/fakes";
const CILIUM_REPO = "https://helm.cilium.io/";
const CILIUM_NAMESPACE = "kube-system";
const KIND_NETWORK = "kind";
// The IPv6 subnet kind itself uses when it creates the network; mirrored so a
// network created here (registry up before any cluster) is what kind expects.
const KIND_NETWORK_IPV6_SUBNET = "fc00:f853:ccd:e793::/64";
export const REGISTRY_IMAGE = "registry:2";
export const REGISTRY_PORT = 5000;
export const CERTS_D = "/etc/containerd/certs.d";
export const CACHE_DIR_NAME = "homelab-kind-registry";
const ARGOCD_URL = "http://localhost:8080";

/**
 * Kind values for Cilium, used only when charts/addons/values-localdev.yaml has
 * no `cilium.values` map yet. Must stay identical to what helm-addons.tmpl
 * renders for localdev so the `cilium` Application adopts the release as a
 * no-op.
 */
export const DEFAULT_CILIUM_KIND_VALUES = `ipam:
  mode: kubernetes
kubeProxyReplacement: false
operator:
  replicas: 1
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 1000m
    memory: 1Gi
hubble:
  enabled: false
image:
  pullPolicy: IfNotPresent
`;

// ============================================================================
// Registry pull-through caches
// ============================================================================
export interface RegistryUpstream {
  /** Short name: container is kind-registry-<name>, cache dir <cacheDir>/<name>. */
  name: string;
  /** Registry host as it appears in image references (containerd certs.d key). */
  host: string;
  /** Upstream URL for REGISTRY_PROXY_REMOTEURL and the hosts.toml `server`. */
  upstream: string;
}

/**
 * One pull-through cache per upstream: the distribution registry proxies a
 * single remote, so docker.io (whose API host is registry-1.docker.io) and the
 * others each get their own container.
 */
export const registryUpstreams: readonly RegistryUpstream[] = [
  {
    name: "docker",
    host: "docker.io",
    upstream: "https://registry-1.docker.io",
  },
  { name: "ghcr", host: "ghcr.io", upstream: "https://ghcr.io" },
  { name: "quay", host: "quay.io", upstream: "https://quay.io" },
  { name: "k8s", host: "registry.k8s.io", upstream: "https://registry.k8s.io" },
  { name: "lscr", host: "lscr.io", upstream: "https://lscr.io" },
];

export function registryContainerName(name: string): string {
  return `kind-registry-${name}`;
}

/** The proxy URL as seen from inside the `kind` Docker network. */
export function registryProxyUrl(name: string): string {
  return `http://${registryContainerName(name)}:${REGISTRY_PORT}`;
}

/**
 * Renders a containerd hosts.toml for one registry host: the proxy first, the
 * upstream (`server`) as the fallback containerd uses when the proxy is down.
 * `server` defaults to https://<host>; docker.io passes its real API host.
 */
export function renderHostsToml(
  host: string,
  proxy: string,
  server: string = `https://${host}`,
): string {
  return [
    `# Written by scripts/localdev-kind.ts for ${host}.`,
    `# Pulls try the pull-through cache first and fall back to the upstream.`,
    `server = "${server}"`,
    ``,
    `[host."${proxy}"]`,
    `  capabilities = ["pull", "resolve"]`,
    ``,
  ].join("\n");
}

/** Path of the hosts.toml for a registry host inside a Kind node. */
export function hostsTomlPath(host: string): string {
  return `${CERTS_D}/${host}/hosts.toml`;
}

/**
 * Resolves the registry cache directory: $HOMELAB_KIND_CACHE_DIR wins,
 * otherwise $XDG_CACHE_HOME (or ~/.cache) + /homelab-kind-registry.
 */
export function resolveCacheDir(
  env: Record<string, string | undefined>,
  home: string,
): string {
  const explicit = env.HOMELAB_KIND_CACHE_DIR?.trim();
  if (explicit) return explicit;
  const base = env.XDG_CACHE_HOME?.trim() || `${home}/.cache`;
  return `${base}/${CACHE_DIR_NAME}`;
}

// ============================================================================
// versions.yaml + Cilium values
// ============================================================================
export interface Versions {
  kindNode: string;
  cilium: string;
  onepasswordConnect: string;
}

// biome-ignore lint/suspicious/noExplicitAny: walks an untyped parsed YAML document
function dig(obj: any, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function requireString(obj: unknown, path: string[], file: string): string {
  const v = dig(obj, path);
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`${file}: missing or empty ${path.join(".")}`);
  }
  return v.trim();
}

/** Reads the pins this script needs from a versions.yaml document. */
export function parseVersions(
  yamlText: string,
  file = VERSIONS_YAML,
): Versions {
  const doc = parseYaml(yamlText);
  return {
    kindNode: requireString(doc, ["images", "kind-node"], file),
    cilium: requireString(doc, ["charts", "cilium"], file),
    onepasswordConnect: requireString(
      doc,
      ["charts", "onepassword-connect"],
      file,
    ),
  };
}

/** kindest/node image for a Kubernetes version (`v` prefix normalised). */
export function kindNodeImage(version: string): string {
  const v = version.trim();
  const tag = v.startsWith("v") ? v : `v${v}`;
  return `kindest/node:${tag}`;
}

/**
 * Extracts `cilium.values` from an addons values document as a YAML string, or
 * null when the key is absent or not a non-empty mapping.
 */
export function extractCiliumValues(yamlText: string): string | null {
  const doc = parseYaml(yamlText);
  const values = dig(doc, ["cilium", "values"]);
  if (
    values === null ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values as object).length === 0
  ) {
    return null;
  }
  return stringifyYaml(values as Record<string, unknown>);
}

// ============================================================================
// CLI args
// ============================================================================
export type Command = "up" | "down" | "fakes" | "registry" | "cilium";
export type RegistryAction = "up" | "down" | "status";

export interface Args {
  help: boolean;
  dryRun: boolean;
  cluster: string;
  context: string;
  noRegistry: boolean;
  purgeCache: boolean;
  command: Command | null;
  registryAction: RegistryAction;
}

export class UsageError extends Error {}

const COMMANDS: readonly Command[] = [
  "up",
  "down",
  "fakes",
  "registry",
  "cilium",
];
const REGISTRY_ACTIONS: readonly RegistryAction[] = ["up", "down", "status"];

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    dryRun: false,
    cluster: DEFAULT_CLUSTER,
    context: "",
    noRegistry: false,
    purgeCache: false,
    command: null,
    registryAction: "up",
  };
  const positional: string[] = [];

  const value = (
    flag: string,
    inline: string | undefined,
    next: string | undefined,
  ) => {
    if (inline !== undefined) return { v: inline, skip: 0 };
    if (next === undefined || next.startsWith("-")) {
      throw new UsageError(`${flag} requires a value`);
    }
    return { v: next, skip: 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;

    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--no-registry") args.noRegistry = true;
    else if (flag === "--purge-cache") args.purgeCache = true;
    else if (flag === "--cluster") {
      const r = value(flag, inline, argv[i + 1]);
      args.cluster = r.v;
      i += r.skip;
    } else if (flag === "--context") {
      const r = value(flag, inline, argv[i + 1]);
      args.context = r.v;
      i += r.skip;
    } else if (a.startsWith("-")) {
      throw new UsageError(`Unknown flag: ${a}`);
    } else positional.push(a);
  }

  if (!args.context) args.context = `kind-${args.cluster}`;
  if (args.help) return args;

  const [cmd, sub, ...rest] = positional;
  if (!cmd) {
    throw new UsageError("missing subcommand (up|down|fakes|registry|cilium)");
  }
  if (!COMMANDS.includes(cmd as Command)) {
    throw new UsageError(`Unknown subcommand: ${cmd}`);
  }
  args.command = cmd as Command;

  if (cmd === "registry") {
    if (sub !== undefined) {
      if (!REGISTRY_ACTIONS.includes(sub as RegistryAction)) {
        throw new UsageError(
          `Unknown registry action: ${sub} (up|down|status)`,
        );
      }
      args.registryAction = sub as RegistryAction;
    }
    if (rest.length) throw new UsageError(`Unexpected argument: ${rest[0]}`);
  } else if (sub !== undefined) {
    throw new UsageError(`Unexpected argument: ${sub}`);
  }
  if (args.purgeCache && cmd !== "down") {
    throw new UsageError("--purge-cache is only valid with `down`");
  }
  return args;
}

function printHelp(): void {
  console.log(`localdev-kind.ts — Kind bootstrap for the localdev ArgoCD loop

Creates the Kind cluster with Cilium as CNI, registry pull-through caches and
the localdev fakes. Nothing here touches the homelab cluster.

Usage:
  bun scripts/localdev-kind.ts <command> [flags]

Commands:
  up                     Create cluster (if missing), registry caches, hosts.toml,
                         Cilium, wait for Ready nodes, remove Kind's bundled
                         local-path-provisioner, apply fakes. Idempotent.
  down [--purge-cache]   Delete the cluster; --purge-cache also removes the
                         registry containers and the cache directory.
  fakes                  kubectl apply --server-side -f ${FAKES_DIR}/
  registry up|down|status
                         Start / remove / list the pull-through caches
                         (default action: up)
  cilium                 Install or upgrade Cilium only

Flags:
  --help, -h             Show this help and exit 0
  --dry-run              Print every mutating command instead of running it
                         (read-only probes such as \`kind get clusters\` still run)
  --cluster <name>       Kind cluster name (default: ${DEFAULT_CLUSTER})
  --context <name>       kube context (default: kind-<cluster>)
  --no-registry          Skip the registry caches and hosts.toml (up only)
  --purge-cache          With down: also remove registry containers + cache dir

Environment:
  HOMELAB_KIND_CACHE_DIR Registry cache directory
                         (default: $XDG_CACHE_HOME|~/.cache/${CACHE_DIR_NAME})

Inputs (read-only):
  ${VERSIONS_YAML}   images.kind-node, charts.cilium
  ${ADDONS_LOCALDEV_VALUES}  cilium.values (fallback: inline Kind defaults)
  ${KIND_CONFIG}          cluster topology, port mappings, containerd config_path

Exit codes: 0 = success; 1 = a step failed; 2 = argument error.
`);
}

// ============================================================================
// Shell helpers
// ============================================================================
interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunOpts {
  /** Mutates Docker/Kind/the cluster: printed and skipped under --dry-run. */
  mutating?: boolean;
  stdin?: string;
  cwd?: string;
  /** Stream stdout/stderr to the terminal (long-running installs). */
  inherit?: boolean;
}

/** Shell-quotes a command for display only (never used to execute). */
export function formatCommand(cmd: string[]): string {
  return cmd
    .map((a) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`,
    )
    .join(" ");
}

class Exec {
  constructor(readonly dryRun: boolean) {}

  async run(cmd: string[], opts: RunOpts = {}): Promise<RunResult> {
    if (this.dryRun && opts.mutating) {
      log.dry(formatCommand(cmd));
      if (opts.stdin !== undefined) {
        for (const line of opts.stdin.trimEnd().split("\n")) {
          console.log(`        ${line}`);
        }
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    let child: Bun.Subprocess<
      "pipe" | "ignore",
      "pipe" | "inherit",
      "pipe" | "inherit"
    >;
    try {
      child = Bun.spawn(cmd, {
        cwd: opts.cwd,
        stdin: opts.stdin !== undefined ? "pipe" : "ignore",
        stdout: opts.inherit ? "inherit" : "pipe",
        stderr: opts.inherit ? "inherit" : "pipe",
      });
    } catch (err) {
      if (isNotFound(err)) {
        return {
          stdout: "",
          stderr: `${cmd[0]}: command not found`,
          code: 127,
        };
      }
      throw err;
    }
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.write(opts.stdin);
      await child.stdin.end();
    }
    const [stdout, stderr, code] = await Promise.all([
      child.stdout ? new Response(child.stdout).text() : "",
      child.stderr ? new Response(child.stderr).text() : "",
      child.exited,
    ]);
    return {
      stdout: opts.inherit ? "" : stdout,
      stderr: opts.inherit ? "" : stderr,
      code,
    };
  }

  /** Runs a mutating command and throws on failure. */
  async must(cmd: string[], opts: RunOpts = {}): Promise<RunResult> {
    // Under --dry-run, run() prints the command itself as a DRY line.
    if (!this.dryRun) log.info(formatCommand(cmd));
    const r = await this.run(cmd, { ...opts, mutating: true });
    if (r.code !== 0) {
      throw new Error(
        `${formatCommand(cmd)} failed (exit ${r.code})${
          r.stderr.trim() ? `:\n${r.stderr.trim()}` : ""
        }`,
      );
    }
    return r;
  }
}

async function findRepoRoot(): Promise<string> {
  const p = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git rev-parse --show-toplevel failed:\n${stderr}`);
  }
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

// ============================================================================
// Context shared by the subcommands
// ============================================================================
interface Ctx {
  args: Args;
  exec: Exec;
  repoRoot: string;
  cacheDir: string;
}

async function dockerAvailable(ctx: Ctx): Promise<boolean> {
  const r = await ctx.exec.run(["docker", "info"]);
  return r.code === 0;
}

async function requireDocker(ctx: Ctx): Promise<void> {
  if (await dockerAvailable(ctx)) return;
  if (ctx.args.dryRun) {
    log.warn(
      "Docker daemon not reachable; dry-run continues as if nothing exists",
    );
    return;
  }
  throw new Error(
    "Docker daemon is not reachable (`docker info` failed). Start Docker Desktop and retry.",
  );
}

// ============================================================================
// Kind cluster
// ============================================================================
async function clusterExists(ctx: Ctx): Promise<boolean> {
  const r = await ctx.exec.run(["kind", "get", "clusters"]);
  if (r.code !== 0) {
    if (ctx.args.dryRun) return false;
    throw new Error(`kind get clusters failed:\n${r.stderr.trim()}`);
  }
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .includes(ctx.args.cluster);
}

async function clusterNodes(ctx: Ctx): Promise<string[]> {
  const r = await ctx.exec.run([
    "kind",
    "get",
    "nodes",
    "--name",
    ctx.args.cluster,
  ]);
  // kind exits 0 with no output (and a stderr note) when the cluster is absent.
  const nodes =
    r.code === 0
      ? r.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  if (nodes.length === 0) {
    if (ctx.args.dryRun) {
      // The cluster is not created under --dry-run; show the topology that
      // localdev/kind-config.yaml produces (1 control-plane + 2 workers).
      return [
        `${ctx.args.cluster}-control-plane`,
        `${ctx.args.cluster}-worker`,
        `${ctx.args.cluster}-worker2`,
      ];
    }
    throw new Error(
      `kind get nodes --name ${ctx.args.cluster} returned no nodes:\n${r.stderr.trim()}`,
    );
  }
  return nodes;
}

async function ensureCluster(ctx: Ctx, versions: Versions): Promise<void> {
  if (await clusterExists(ctx)) {
    log.ok(`Kind cluster ${ctx.args.cluster} already exists`);
    return;
  }
  log.info(
    `Creating Kind cluster ${ctx.args.cluster} (${kindNodeImage(
      versions.kindNode,
    )})`,
  );
  await ctx.exec.must(
    [
      "kind",
      "create",
      "cluster",
      "--name",
      ctx.args.cluster,
      "--config",
      `${ctx.repoRoot}/${KIND_CONFIG}`,
      "--image",
      kindNodeImage(versions.kindNode),
      "--wait",
      "0s",
    ],
    { inherit: true },
  );
  log.ok(
    `Kind cluster ${ctx.args.cluster} created (context ${ctx.args.context})`,
  );
}

// ============================================================================
// Registry caches
// ============================================================================
async function containerState(ctx: Ctx, name: string): Promise<string> {
  const r = await ctx.exec.run([
    "docker",
    "container",
    "inspect",
    "-f",
    "{{.State.Status}}",
    name,
  ]);
  return r.code === 0 ? r.stdout.trim() : "absent";
}

async function ensureKindNetwork(ctx: Ctx): Promise<void> {
  const r = await ctx.exec.run(["docker", "network", "inspect", KIND_NETWORK]);
  if (r.code === 0) return;
  await ctx.exec.must([
    "docker",
    "network",
    "create",
    "-d",
    "bridge",
    "--ipv6",
    "--subnet",
    KIND_NETWORK_IPV6_SUBNET,
    "-o",
    "com.docker.network.bridge.enable_ip_masquerade=true",
    KIND_NETWORK,
  ]);
}

async function connectedToKind(ctx: Ctx, name: string): Promise<boolean> {
  const r = await ctx.exec.run([
    "docker",
    "container",
    "inspect",
    "-f",
    "{{json .NetworkSettings.Networks}}",
    name,
  ]);
  if (r.code !== 0) return false;
  try {
    return Object.keys(JSON.parse(r.stdout)).includes(KIND_NETWORK);
  } catch {
    return false;
  }
}

async function registryUp(ctx: Ctx): Promise<void> {
  log.info(`Registry cache dir: ${ctx.cacheDir}`);
  try {
    await ensureKindNetwork(ctx);
  } catch (err) {
    log.warn(
      `could not ensure the ${KIND_NETWORK} network: ${msg(
        err,
      )}; skipping registry caches`,
    );
    return;
  }
  for (const u of registryUpstreams) {
    const name = registryContainerName(u.name);
    try {
      const state = await containerState(ctx, name);
      if (state === "running") {
        log.ok(`${name} running (${u.host} → ${u.upstream})`);
      } else if (state === "absent") {
        const dir = `${ctx.cacheDir}/${u.name}`;
        if (ctx.args.dryRun) log.dry(`mkdir -p ${dir}`);
        else await mkdir(dir, { recursive: true });
        await ctx.exec.must([
          "docker",
          "run",
          "-d",
          "--restart",
          "unless-stopped",
          "--name",
          name,
          "--network",
          KIND_NETWORK,
          "-e",
          `REGISTRY_PROXY_REMOTEURL=${u.upstream}`,
          "-v",
          `${dir}:/var/lib/registry`,
          REGISTRY_IMAGE,
        ]);
        log.ok(`${name} started (${u.host} → ${u.upstream})`);
      } else {
        await ctx.exec.must(["docker", "start", name]);
        log.ok(`${name} started (was ${state})`);
      }
      if (state !== "absent" && !(await connectedToKind(ctx, name))) {
        await ctx.exec.must([
          "docker",
          "network",
          "connect",
          KIND_NETWORK,
          name,
        ]);
      }
    } catch (err) {
      log.warn(
        `${name}: ${msg(
          err,
        )} — pulls from ${u.host} go straight to the upstream`,
      );
    }
  }
}

async function registryDown(ctx: Ctx): Promise<void> {
  for (const u of registryUpstreams) {
    const name = registryContainerName(u.name);
    const state = await containerState(ctx, name);
    if (state === "absent") {
      log.info(`${name} absent`);
      continue;
    }
    try {
      await ctx.exec.must(["docker", "rm", "-f", name]);
      log.ok(`${name} removed (cache kept in ${ctx.cacheDir}/${u.name})`);
    } catch (err) {
      log.warn(`${name}: ${msg(err)}`);
    }
  }
}

async function cacheSize(ctx: Ctx, dir: string): Promise<string> {
  if (!(await pathExists(dir))) return "-";
  const r = await ctx.exec.run(["du", "-sh", dir]);
  if (r.code !== 0) return "?";
  return r.stdout.trim().split(/\s+/)[0] ?? "?";
}

export interface RegistryStatusRow {
  name: string;
  upstream: string;
  state: string;
  size: string;
}

export function formatStatusTable(rows: RegistryStatusRow[]): string {
  const header = {
    name: "NAME",
    upstream: "UPSTREAM",
    state: "STATE",
    size: "CACHE",
  };
  const all = [header, ...rows];
  const w = (k: keyof RegistryStatusRow) =>
    Math.max(...all.map((r) => r[k].length));
  return all
    .map(
      (r) =>
        `${r.name.padEnd(w("name"))}  ${r.upstream.padEnd(w("upstream"))}  ${r.state.padEnd(
          w("state"),
        )}  ${r.size}`,
    )
    .join("\n");
}

async function registryStatus(ctx: Ctx): Promise<void> {
  const rows: RegistryStatusRow[] = [];
  for (const u of registryUpstreams) {
    const name = registryContainerName(u.name);
    rows.push({
      name,
      upstream: u.upstream,
      state: await containerState(ctx, name),
      size: await cacheSize(ctx, `${ctx.cacheDir}/${u.name}`),
    });
  }
  console.log(formatStatusTable(rows));
  console.log(`\nCache dir: ${ctx.cacheDir}`);
}

async function writeHostsToml(ctx: Ctx): Promise<void> {
  const nodes = await clusterNodes(ctx);
  for (const node of nodes) {
    for (const u of registryUpstreams) {
      const path = hostsTomlPath(u.host);
      const dir = path.slice(0, path.lastIndexOf("/"));
      const content = renderHostsToml(
        u.host,
        registryProxyUrl(u.name),
        u.upstream,
      );
      try {
        await ctx.exec.must(
          [
            "docker",
            "exec",
            "-i",
            node,
            "sh",
            "-c",
            `mkdir -p ${dir} && cat > ${path}`,
          ],
          { stdin: content },
        );
      } catch (err) {
        log.warn(`${node}: could not write ${path}: ${msg(err)}`);
      }
    }
  }
  log.ok(
    `hosts.toml written for ${registryUpstreams.length} registries on ${nodes.length} node(s)`,
  );
}

// ============================================================================
// Cilium
// ============================================================================
async function ciliumValues(ctx: Ctx): Promise<string> {
  const file = `${ctx.repoRoot}/${ADDONS_LOCALDEV_VALUES}`;
  if (await pathExists(file)) {
    const extracted = extractCiliumValues(await readFile(file, "utf8"));
    if (extracted !== null) {
      log.info(`Cilium values: ${ADDONS_LOCALDEV_VALUES} cilium.values`);
      return extracted;
    }
    log.warn(
      `${ADDONS_LOCALDEV_VALUES} has no cilium.values map; using the inline Kind defaults`,
    );
  } else {
    log.warn(
      `${ADDONS_LOCALDEV_VALUES} not found (run task config:export:localdev); using the inline Kind defaults`,
    );
  }
  return DEFAULT_CILIUM_KIND_VALUES;
}

async function installCilium(ctx: Ctx, versions: Versions): Promise<void> {
  const values = await ciliumValues(ctx);
  const valuesDir = await mkdtemp(join(tmpdir(), "cilium-kind-"));
  const valuesFile = join(valuesDir, "values.yaml");
  try {
    await writeFile(valuesFile, values, { mode: 0o600 });
    if (ctx.args.dryRun) {
      log.dry(`values file ${valuesFile}:`);
      for (const line of values.trimEnd().split("\n")) {
        console.log(`        ${line}`);
      }
    }
    log.info(`Installing Cilium ${versions.cilium} into ${CILIUM_NAMESPACE}`);
    await ctx.exec.must(
      [
        "helm",
        "--kube-context",
        ctx.args.context,
        "upgrade",
        "--install",
        "cilium",
        "cilium",
        "--repo",
        CILIUM_REPO,
        "--version",
        versions.cilium,
        "--namespace",
        CILIUM_NAMESPACE,
        "--values",
        valuesFile,
        "--wait",
        "--timeout",
        "10m",
      ],
      { inherit: true },
    );
    log.ok(`Cilium ${versions.cilium} ready`);
  } finally {
    try {
      await rm(valuesDir, { recursive: true });
    } catch {
      // temp file already gone
    }
  }
}

async function waitForNodes(ctx: Ctx): Promise<void> {
  await ctx.exec.must(
    [
      "kubectl",
      "--context",
      ctx.args.context,
      "wait",
      "--for=condition=Ready",
      "nodes",
      "--all",
      "--timeout=5m",
    ],
    { inherit: true },
  );
  log.ok("All nodes Ready");
}

// ============================================================================
// Kind's bundled local-path-provisioner
// ============================================================================
export interface ClusterObject {
  kind: string;
  name: string;
  /** Absent for cluster-scoped objects. */
  namespace?: string;
}

/**
 * Objects of the local-path-provisioner that Kind bundles into every cluster
 * (kind v0.33.0 pkg/build/nodeimage/const_storage.go) which the
 * `local-path-provisioner` addon Application (chart from versions.yaml,
 * release local-path-provisioner, namespace local-path-storage) does NOT
 * re-create under the same name. Same-name objects (Namespace
 * local-path-storage, ConfigMap local-path-config) are adopted by ArgoCD's
 * server-side apply and are not listed. The Deployment shares its name but its
 * selector differs and that field is immutable, so it is deleted too; the
 * `standard` default StorageClass is replaced by the chart's `local-path`.
 */
export const kindBundledStorageObjects: readonly ClusterObject[] = [
  {
    kind: "deployment",
    name: "local-path-provisioner",
    namespace: "local-path-storage",
  },
  {
    kind: "serviceaccount",
    name: "local-path-provisioner-service-account",
    namespace: "local-path-storage",
  },
  {
    kind: "role",
    name: "local-path-provisioner-role",
    namespace: "local-path-storage",
  },
  {
    kind: "rolebinding",
    name: "local-path-provisioner-bind",
    namespace: "local-path-storage",
  },
  { kind: "clusterrole", name: "local-path-provisioner-role" },
  { kind: "clusterrolebinding", name: "local-path-provisioner-bind" },
  { kind: "storageclass", name: "standard" },
];

/**
 * Groups objects into `kubectl delete` invocations: one per namespace plus one
 * for cluster-scoped objects, each with --ignore-not-found so re-runs are
 * no-ops. Returns the argument lists after `kubectl --context <ctx>`.
 */
export function kubectlDeleteArgs(
  objects: readonly ClusterObject[],
): string[][] {
  const groups = new Map<string, string[]>();
  for (const o of objects) {
    const key = o.namespace ?? "";
    const refs = groups.get(key) ?? [];
    refs.push(`${o.kind}/${o.name}`);
    groups.set(key, refs);
  }
  return [...groups.entries()].map(([ns, refs]) => [
    "delete",
    ...(ns ? ["-n", ns] : []),
    "--ignore-not-found",
    ...refs,
  ]);
}

async function removeKindBundledStorage(ctx: Ctx): Promise<void> {
  log.info(
    "Removing Kind's bundled local-path-provisioner so the local-path-provisioner addon Application owns it " +
      "(same Deployment name with an immutable selector; the chart's RBAC and StorageClass names differ)",
  );
  for (const args of kubectlDeleteArgs(kindBundledStorageObjects)) {
    await ctx.exec.must(["kubectl", "--context", ctx.args.context, ...args], {
      inherit: true,
    });
  }
  log.ok(
    "Kind's bundled local-path-provisioner removed (ConfigMap local-path-config and the namespace are adopted)",
  );
}

// ============================================================================
// Fakes
// ============================================================================
const GENERATED_KEY = "homelab.local/generated-key";
const GENERATED_GROUP = "homelab.local/generated-group";

/** A fake Secret whose one key gets a random value in the cluster, never in git. */
export interface GeneratedSecretStub {
  namespace: string;
  name: string;
  key: string;
  /** Stubs sharing a group get the same value (one credential, several namespaces). */
  group: string;
}

/**
 * Returns the Secrets in a fakes file annotated with homelab.local/generated-key
 * (and -group, default the Secret name). Throws on a group without a key.
 */
export function generatedSecretStubs(content: string): GeneratedSecretStub[] {
  const stubs: GeneratedSecretStub[] = [];
  for (const doc of parseAllYaml(content)) {
    const obj = doc as {
      kind?: string;
      metadata?: {
        name?: string;
        namespace?: string;
        annotations?: Record<string, string>;
      };
    } | null;
    const ann = obj?.metadata?.annotations ?? {};
    if (
      obj?.kind !== "Secret" ||
      !(GENERATED_KEY in ann || GENERATED_GROUP in ann)
    ) {
      continue;
    }
    const name = obj.metadata?.name ?? "";
    const namespace = obj.metadata?.namespace ?? "";
    const key = ann[GENERATED_KEY];
    if (!key) {
      throw new Error(
        `Secret ${namespace}/${name}: ${GENERATED_GROUP} without ${GENERATED_KEY}`,
      );
    }
    stubs.push({ namespace, name, key, group: ann[GENERATED_GROUP] || name });
  }
  return stubs;
}

/**
 * Picks the value for every stub (keyed "<namespace>/<name>"): a value already
 * in the cluster wins for its whole group, otherwise one fresh value per group.
 */
export function assignGeneratedValues(
  stubs: GeneratedSecretStub[],
  existing: Record<string, string>,
  fresh: () => string,
): Record<string, string> {
  const byGroup = new Map<string, string>();
  for (const s of stubs) {
    const v = existing[`${s.namespace}/${s.name}`];
    if (v && !byGroup.has(s.group)) byGroup.set(s.group, v);
  }
  const values: Record<string, string> = {};
  for (const s of stubs) {
    if (!byGroup.has(s.group)) byGroup.set(s.group, fresh());
    values[`${s.namespace}/${s.name}`] = byGroup.get(s.group) as string;
  }
  return values;
}

/** Fills the generated keys of the fake Secret stubs that do not have them yet. */
async function fillGeneratedSecrets(ctx: Ctx, dir: string): Promise<void> {
  const stubs: GeneratedSecretStub[] = [];
  for (const file of (await readdir(dir))
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    stubs.push(
      ...generatedSecretStubs(await readFile(join(dir, file), "utf8")),
    );
  }
  const existing: Record<string, string> = {};
  for (const s of stubs) {
    const r = await ctx.exec.run([
      "kubectl",
      "--context",
      ctx.args.context,
      "-n",
      s.namespace,
      "get",
      "secret",
      s.name,
      "-o",
      `jsonpath={.data.${s.key}}`,
    ]);
    if (r.code === 0 && r.stdout.trim()) {
      existing[`${s.namespace}/${s.name}`] = Buffer.from(
        r.stdout.trim(),
        "base64",
      ).toString();
    }
  }
  const values = assignGeneratedValues(stubs, existing, () =>
    randomBytes(24).toString("hex"),
  );
  for (const s of stubs) {
    const id = `${s.namespace}/${s.name}`;
    if (existing[id]) continue;
    const patch = JSON.stringify({ stringData: { [s.key]: values[id] } });
    await ctx.exec.must([
      "kubectl",
      "--context",
      ctx.args.context,
      "-n",
      s.namespace,
      "patch",
      "secret",
      s.name,
      "--type",
      "merge",
      "--field-manager",
      "localdev-kind-generated",
      "-p",
      patch,
    ]);
  }
  if (stubs.length > 0)
    log.ok(`Generated values for ${stubs.length} fake Secret key(s)`);
}

async function applyFakes(ctx: Ctx): Promise<void> {
  const dir = `${ctx.repoRoot}/${FAKES_DIR}`;
  if (!(await pathExists(dir))) {
    throw new Error(`${FAKES_DIR} not found in ${ctx.repoRoot}`);
  }
  await ctx.exec.must(
    [
      "kubectl",
      "--context",
      ctx.args.context,
      "apply",
      "--server-side",
      "--field-manager",
      "localdev-kind",
      "-f",
      dir,
    ],
    { inherit: true },
  );
  log.ok(`Fakes applied from ${FAKES_DIR}`);
  await fillGeneratedSecrets(ctx, dir);
}

// ============================================================================
// Subcommands
// ============================================================================
async function readVersions(ctx: Ctx): Promise<Versions> {
  return parseVersions(
    await readFile(`${ctx.repoRoot}/${VERSIONS_YAML}`, "utf8"),
  );
}

function printSummary(ctx: Ctx): void {
  console.log(`
${green("Kind localdev ready")}
  cluster:   ${ctx.args.cluster}
  context:   ${ctx.args.context}
  ArgoCD:    ${ARGOCD_URL} (after task localdev:argocd)
  Traefik:   http://localhost:9080  https://localhost:9443
  registry:  ${
    ctx.args.noRegistry
      ? "disabled (--no-registry)"
      : `cache dir ${ctx.cacheDir}`
  }
  fakes:     ${FAKES_DIR}
`);
}

async function cmdUp(ctx: Ctx): Promise<void> {
  await requireDocker(ctx);
  const versions = await readVersions(ctx);
  await ensureCluster(ctx, versions);
  if (ctx.args.noRegistry) {
    log.info("--no-registry: skipping pull-through caches and hosts.toml");
  } else {
    await registryUp(ctx);
    await writeHostsToml(ctx);
  }
  await installCilium(ctx, versions);
  await waitForNodes(ctx);
  await removeKindBundledStorage(ctx);
  await applyFakes(ctx);
  printSummary(ctx);
}

async function cmdDown(ctx: Ctx): Promise<void> {
  await requireDocker(ctx);
  if (await clusterExists(ctx)) {
    await ctx.exec.must(
      ["kind", "delete", "cluster", "--name", ctx.args.cluster],
      { inherit: true },
    );
    log.ok(`Kind cluster ${ctx.args.cluster} deleted`);
  } else {
    log.info(`Kind cluster ${ctx.args.cluster} does not exist`);
  }
  if (!ctx.args.purgeCache) {
    log.info(
      `Registry caches kept (task localdev:registry -- down removes the containers, down --purge-cache also the cache dir)`,
    );
    return;
  }
  await registryDown(ctx);
  if (await pathExists(ctx.cacheDir)) {
    log.info(`Removing cache dir ${ctx.cacheDir}`);
    if (ctx.args.dryRun) log.dry(`rm -rf ${ctx.cacheDir}`);
    else await rm(ctx.cacheDir, { recursive: true });
    log.ok(`Removed ${ctx.cacheDir}`);
  } else {
    log.info(`Cache dir ${ctx.cacheDir} does not exist`);
  }
}

async function cmdRegistry(ctx: Ctx): Promise<void> {
  await requireDocker(ctx);
  switch (ctx.args.registryAction) {
    case "up": {
      await registryUp(ctx);
      if (await clusterExists(ctx)) await writeHostsToml(ctx);
      else {
        log.info(
          `cluster ${ctx.args.cluster} absent; hosts.toml is written by \`up\``,
        );
      }
      break;
    }
    case "down":
      await registryDown(ctx);
      break;
    case "status":
      await registryStatus(ctx);
      break;
  }
}

async function cmdCilium(ctx: Ctx): Promise<void> {
  const versions = await readVersions(ctx);
  await installCilium(ctx, versions);
  await waitForNodes(ctx);
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      log.error(err.message);
      console.error("Run with --help for usage.");
      return 2;
    }
    throw err;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  const ctx: Ctx = {
    args,
    exec: new Exec(args.dryRun),
    repoRoot: await findRepoRoot(),
    cacheDir: resolveCacheDir({ ...process.env }, process.env.HOME ?? "."),
  };
  if (args.dryRun) {
    log.info("Dry-run: mutating commands are printed, not executed");
  }

  switch (args.command) {
    case "up":
      await cmdUp(ctx);
      break;
    case "down":
      await cmdDown(ctx);
      break;
    case "fakes":
      await applyFakes(ctx);
      break;
    case "registry":
      await cmdRegistry(ctx);
      break;
    case "cilium":
      await cmdCilium(ctx);
      break;
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (err) {
    log.error(msg(err));
    process.exit(1);
  }
}
