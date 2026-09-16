#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

/**
 * apiserver-stress.ts
 *
 * Read-only availability probe and load ramp for the Kubernetes API server,
 * for diagnosing sporadic API connectivity loss on the homelab cluster (Talos,
 * three control planes behind a layer-2 VIP). Every request this script makes
 * is a GET built in exactly one function (getOnce); nothing here can change
 * the cluster.
 *
 * Subcommands:
 *   probe   Low-rate continuous probe. Every --interval (1s) it fires one GET
 *           per endpoint per path and prints every failure and every slow
 *           (> --slow, 1s) request immediately with an ISO timestamp, the
 *           endpoint, path, status or error kind and the latency. At the end
 *           it prints a per-endpoint per-path table: count, ok, errors grouped
 *           by kind (http <status>, timeout, refused, reset, tls, other),
 *           p50/p95/p99/max latency of the successful requests, and the
 *           longest outage (consecutive failures) with its start and end.
 *           Endpoints: the server URL of the kubeconfig context plus every
 *           --endpoint https://host:6443 (repeatable), so the VIP and each
 *           control plane can be probed side by side. The server certificate
 *           is verified with the kubeconfig CA (the SANs include the node IPs).
 *           Paths: /readyz and the kube-scheduler Lease (a linearizable etcd
 *           read). If the Lease returns 403 the run continues with /version.
 *   stress  Read-only load ramp: for each --concurrency step (8,32) that many
 *           workers loop over endpoints x paths (the probe paths plus
 *           /api/v1/namespaces/kube-system/pods?limit=50 and /api/v1/nodes)
 *           for --step-duration (30s), while a concurrent 1/s probe (the same
 *           machinery as `probe`) shows how the baseline latency and failures
 *           change under load. Per step: achieved req/s, errors by kind,
 *           p50/p95/p99/max, and the probe table. Steps above
 *           --max-concurrency (128) are refused unless --i-know is passed.
 *
 * Auth: the kubeconfig (--kubeconfig, else the first path in $KUBECONFIG,
 * else ~/.kube/config) and --context (default: current-context). Supported
 * user entries: client-certificate(-data) + client-key(-data), token,
 * tokenFile. insecure-skip-tls-verify is honoured by not pinning the CA; Deno
 * has no per-client switch for it, so also run with
 * `deno run --unsafely-ignore-certificate-errors=<host> ...`. exec plugins
 * are not supported. Tokens are never printed.
 *
 * --dry-run prints the resolved endpoints, paths, identity type and plan and
 * exits 0 without any network call. --json <file> also writes the summary.
 *
 * Usage:
 *   task apiserver:probe  [-- --endpoint https://<cp-ip>:6443 --duration 5m]
 *   task apiserver:stress [-- --concurrency 8,32,64 --step-duration 30s]
 *   deno run ... scripts/apiserver-stress.ts --help
 *
 * Exit codes: 0 = run completed with no probe failures; 1 = the probe saw
 * failures or the run itself failed; 2 = argument error.
 */

import { parse as parseYaml } from "jsr:@std/yaml@^1";
import { dirname, join, resolve } from "jsr:@std/path@^1";
import { decodeBase64 } from "jsr:@std/encoding@^1/base64";
import { delay } from "jsr:@std/async@^1/delay";

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
export const LEASE_PATH =
  "/apis/coordination.k8s.io/v1/namespaces/kube-system/leases/kube-scheduler";
/** Used instead of LEASE_PATH for the rest of the run after a 403. */
export const FALLBACK_PATH = "/version";
export const PROBE_PATHS: readonly string[] = ["/readyz", LEASE_PATH];
export const STRESS_PATHS: readonly string[] = [
  ...PROBE_PATHS,
  "/api/v1/namespaces/kube-system/pods?limit=50",
  "/api/v1/nodes",
];
export const DEFAULT_INTERVAL = "1s";
export const DEFAULT_TIMEOUT = "5s";
export const DEFAULT_DURATION = "60s";
export const DEFAULT_SLOW = "1s";
export const DEFAULT_CONCURRENCY = "8,32";
export const DEFAULT_STEP_DURATION = "30s";
export const DEFAULT_MAX_CONCURRENCY = 128;
/** The stress probe runs at this interval regardless of --interval. */
export const STRESS_PROBE_INTERVAL_MS = 1000;
/** Load-request failures printed per step before they are counted silently. */
export const LOAD_EVENT_LIMIT = 20;
/** The only HTTP method this script ever uses. */
export const METHOD = "GET";
const USER_AGENT = "homelab-apiserver-stress";

// ============================================================================
// Pure helpers (unit-tested in apiserver-stress_test.ts)
// ============================================================================

/** Raised for invalid invocations; main maps it to exit code 2. */
export class UsageError extends Error {}

const DURATION = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/;
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** "30s", "5m", "250ms", "1h" or plain seconds ("90") -> milliseconds. */
export function parseDuration(raw: string, flag = "duration"): number {
  const m = DURATION.exec(raw);
  if (!m) {
    throw new UsageError(
      `--${flag} must look like 30s, 5m or 90 (seconds), got ${
        JSON.stringify(raw)
      }`,
    );
  }
  const ms = Math.round(Number(m[1]) * UNIT_MS[m[2] ?? "s"]);
  if (!(ms > 0)) throw new UsageError(`--${flag} must be positive, got ${raw}`);
  return ms;
}

/** Milliseconds -> the shortest of "2m", "90s", "250ms". */
export function formatDuration(ms: number): string {
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms > 0 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/**
 * "8,32,64" -> [8, 32, 64]. Steps above max are refused unless iKnow is set:
 * the guard keeps an unattended run from turning into a denial of service.
 */
export function parseConcurrency(
  raw: string,
  max: number,
  iKnow: boolean,
): number[] {
  const steps = raw.split(",").map((s) => s.trim()).filter((s) => s !== "")
    .map((s) => {
      if (!/^\d+$/.test(s) || Number(s) < 1) {
        throw new UsageError(
          `--concurrency must be a list of positive integers like 8,32, got ${
            JSON.stringify(raw)
          }`,
        );
      }
      return Number(s);
    });
  if (steps.length === 0) {
    throw new UsageError("--concurrency needs at least one step");
  }
  const over = steps.filter((n) => n > max);
  if (over.length > 0 && !iKnow) {
    throw new UsageError(
      `--concurrency ${
        over.join(",")
      } exceeds --max-concurrency ${max}; pass --i-know to run it anyway`,
    );
  }
  return steps;
}

/** Nearest-rank percentile (p in 0..100); null for an empty sample. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil((p / 100) * sorted.length)),
  );
  return sorted[rank - 1];
}

export interface LatencyStats {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function latencyStats(values: number[]): LatencyStats {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

export type TransportKind = "timeout" | "refused" | "reset" | "tls" | "other";
export type ResultKind = "ok" | TransportKind | `http ${number}`;

/** Buckets a fetch/AbortSignal error by what the network did. */
export function classifyError(err: unknown): TransportKind {
  const name = err instanceof Error ? err.name : "";
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    name === "TimeoutError" || name === "AbortError" || /timed? ?out/.test(msg)
  ) {
    return "timeout";
  }
  if (/refused/.test(msg)) return "refused";
  if (/\btls\b|certificate|handshake|\bssl\b/.test(msg)) return "tls";
  if (
    /reset|broken pipe|closed before|unexpected eof|\beof\b|http2 error|stream error|goaway|connection closed/
      .test(msg)
  ) {
    return "reset";
  }
  return "other";
}

/** 2xx is ok; anything else is "http <status>". */
export function classifyStatus(status: number): ResultKind {
  return status >= 200 && status < 300 ? "ok" : `http ${status}`;
}

export interface RequestResult {
  /** Epoch milliseconds when the request was sent. */
  at: number;
  endpoint: string;
  path: string;
  status: number | null;
  kind: ResultKind;
  latencyMs: number;
  /** Short error text (never a credential). */
  error?: string;
}

export interface Outage {
  /** Epoch ms of the first failed request. */
  start: number;
  /** Epoch ms when the last failed request finished. */
  end: number;
  failures: number;
}

/**
 * The longest run of consecutive failures in a sequence of results (sorted by
 * send time). Ties go to the longer wall-clock window.
 */
export function longestOutage(results: RequestResult[]): Outage | null {
  const sorted = [...results].sort((a, b) => a.at - b.at);
  let best: Outage | null = null;
  let current: Outage | null = null;
  const consider = (o: Outage | null) => {
    if (!o) return;
    if (
      !best || o.failures > best.failures ||
      (o.failures === best.failures && o.end - o.start > best.end - best.start)
    ) {
      best = o;
    }
  };
  for (const r of sorted) {
    if (r.kind === "ok") {
      consider(current);
      current = null;
      continue;
    }
    const end = r.at + r.latencyMs;
    if (current) {
      current.failures++;
      current.end = Math.max(current.end, end);
    } else {
      current = { start: r.at, end, failures: 1 };
    }
  }
  consider(current);
  return best;
}

/** Error counts by kind, most frequent first. */
export function countErrors(results: RequestResult[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const r of results) {
    if (r.kind !== "ok") counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) =>
      b[1] - a[1] || a[0].localeCompare(b[0])
    ),
  );
}

export interface CellSummary {
  endpoint: string;
  path: string;
  count: number;
  ok: number;
  errors: Record<string, number>;
  /** Latency of the successful requests. */
  latency: LatencyStats;
  longestOutage: Outage | null;
}

/** One summary per endpoint x path, in first-seen order. */
export function summarize(results: RequestResult[]): CellSummary[] {
  const groups = new Map<string, RequestResult[]>();
  for (const r of results) {
    const key = `${r.endpoint}\0${r.path}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.values()].map((rs) => ({
    endpoint: rs[0].endpoint,
    path: rs[0].path,
    count: rs.length,
    ok: rs.filter((r) => r.kind === "ok").length,
    errors: countErrors(rs),
    latency: latencyStats(
      rs.filter((r) => r.kind === "ok").map((r) => r.latencyMs),
    ),
    longestOutage: longestOutage(rs),
  }));
}

/** Swaps LEASE_PATH for FALLBACK_PATH after a 403 on the Lease. */
export function applyLeaseFallback(
  paths: readonly string[],
  r: RequestResult,
): string[] {
  if (r.path === LEASE_PATH && r.status === 403) {
    return paths.map((p) => (p === LEASE_PATH ? FALLBACK_PATH : p));
  }
  return [...paths];
}

/** "https://host:6443/" -> "https://host:6443"; rejects anything else. */
export function normalizeEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UsageError(`invalid endpoint ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(
      `endpoint ${JSON.stringify(raw)} must be an https:// (or http://) URL`,
    );
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new UsageError(
      `endpoint ${
        JSON.stringify(raw)
      } must not carry a path; use --path for paths`,
    );
  }
  if (url.username || url.password) {
    throw new UsageError(
      `endpoint ${JSON.stringify(raw)} must not embed credentials`,
    );
  }
  return url.origin;
}

export function normalizePath(raw: string): string {
  const p = raw.trim();
  if (!p.startsWith("/") || /\s/.test(p)) {
    throw new UsageError(`--path ${JSON.stringify(raw)} must start with /`);
  }
  return p;
}

// ----------------------------------------------------------------------------
// kubeconfig
// ----------------------------------------------------------------------------

/**
 * The kubeconfig to use: --kubeconfig, else the first entry of $KUBECONFIG,
 * else ~/.kube/config.
 */
export function kubeconfigPath(
  flag: string | undefined,
  envKubeconfig: string | undefined,
  home: string,
): string {
  if (flag) return flag;
  const first = (envKubeconfig ?? "").split(":").map((s) => s.trim()).find(
    (s) => s !== "",
  );
  if (first) return first;
  return join(home, ".kube", "config");
}

/** Where a PEM/token comes from: inline (base64) data or a file path. */
export interface Source {
  kind: "data" | "file";
  value: string;
}

export type Identity =
  | { type: "cert"; cert: Source; key: Source }
  | { type: "token"; token: Source }
  | { type: "none" };

export interface ResolvedContext {
  context: string;
  cluster: string;
  user: string;
  server: string;
  ca: Source | null;
  insecureSkipTlsVerify: boolean;
  identity: Identity;
}

// deno-lint-ignore no-explicit-any
type Json = any;

function named(list: Json, name: string, what: string): Json {
  const items: Json[] = Array.isArray(list) ? list : [];
  const hit = items.find((i) => i?.name === name);
  if (!hit) {
    throw new UsageError(
      `${what} ${JSON.stringify(name)} not found in the kubeconfig`,
    );
  }
  return hit;
}

function source(
  obj: Json,
  dataKey: string,
  fileKey: string,
): Source | null {
  if (typeof obj?.[dataKey] === "string" && obj[dataKey] !== "") {
    return { kind: "data", value: obj[dataKey] };
  }
  if (typeof obj?.[fileKey] === "string" && obj[fileKey] !== "") {
    return { kind: "file", value: obj[fileKey] };
  }
  return null;
}

/**
 * Resolves context -> cluster + user from a parsed kubeconfig. Pure: nothing
 * is read from disk or decoded here (see loadCredentials).
 */
export function resolveContext(
  doc: unknown,
  contextName?: string,
): ResolvedContext {
  const kc = doc as Json;
  if (!kc || typeof kc !== "object") {
    throw new UsageError("the kubeconfig is not a YAML mapping");
  }
  const name = contextName ?? kc["current-context"];
  if (typeof name !== "string" || name === "") {
    throw new UsageError(
      "the kubeconfig has no current-context; pass --context <name>",
    );
  }
  const ctx = named(kc.contexts, name, "context").context ?? {};
  const cluster = named(kc.clusters, ctx.cluster, "cluster").cluster ?? {};
  const user = named(kc.users, ctx.user, "user").user ?? {};

  const server = cluster.server;
  if (typeof server !== "string" || server === "") {
    throw new UsageError(
      `cluster ${JSON.stringify(ctx.cluster)} has no server`,
    );
  }

  let identity: Identity = { type: "none" };
  const cert = source(user, "client-certificate-data", "client-certificate");
  const key = source(user, "client-key-data", "client-key");
  if (cert && key) {
    identity = { type: "cert", cert, key };
  } else if (cert || key) {
    throw new UsageError(
      `user ${
        JSON.stringify(ctx.user)
      } has a client certificate without a key (or vice versa)`,
    );
  } else if (typeof user.token === "string" && user.token !== "") {
    identity = { type: "token", token: { kind: "data", value: user.token } };
  } else if (typeof user.tokenFile === "string" && user.tokenFile !== "") {
    identity = {
      type: "token",
      token: { kind: "file", value: user.tokenFile },
    };
  } else if (user.exec || user["auth-provider"]) {
    throw new UsageError(
      `user ${
        JSON.stringify(ctx.user)
      } uses an exec/auth-provider credential plugin, which this script does not support; ` +
        "use a context with a client certificate or a token",
    );
  }

  return {
    context: name,
    cluster: String(ctx.cluster),
    user: String(ctx.user),
    server,
    ca: source(cluster, "certificate-authority-data", "certificate-authority"),
    insecureSkipTlsVerify: cluster["insecure-skip-tls-verify"] === true,
    identity,
  };
}

export interface Credentials {
  caPem?: string;
  certPem?: string;
  keyPem?: string;
  token?: string;
}

/**
 * Materialises the sources: inline *-data fields are base64-decoded, file
 * paths are read relative to the kubeconfig directory (kubectl semantics).
 * Inline tokens are used as-is. readFile is injected so tests need no disk.
 */
export async function loadCredentials(
  rc: ResolvedContext,
  baseDir: string,
  readFile: (path: string) => Promise<string>,
): Promise<Credentials> {
  const dec = new TextDecoder();
  const materialize = async (s: Source, what: string): Promise<string> => {
    if (s.kind === "file") {
      const path = resolve(baseDir, s.value);
      try {
        return await readFile(path);
      } catch (err) {
        throw new Error(
          `cannot read ${what} file ${path}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    try {
      return dec.decode(decodeBase64(s.value.replace(/\s+/g, "")));
    } catch {
      throw new Error(`${what}-data in the kubeconfig is not valid base64`);
    }
  };

  const creds: Credentials = {};
  if (rc.ca && !rc.insecureSkipTlsVerify) {
    creds.caPem = await materialize(rc.ca, "certificate-authority");
  }
  if (rc.identity.type === "cert") {
    creds.certPem = await materialize(rc.identity.cert, "client-certificate");
    creds.keyPem = await materialize(rc.identity.key, "client-key");
  } else if (rc.identity.type === "token") {
    const t = rc.identity.token;
    creds.token = (t.kind === "data" ? t.value : await materialize(t, "token"))
      .trim();
    if (!creds.token) throw new Error("the token in the kubeconfig is empty");
  }
  return creds;
}

/** Human description of the identity; never includes the credential. */
export function describeIdentity(rc: ResolvedContext): string {
  switch (rc.identity.type) {
    case "cert":
      return `client certificate (${rc.identity.cert.kind}) + key (${rc.identity.key.kind})`;
    case "token":
      return `bearer token (${
        rc.identity.token.kind === "file" ? "tokenFile" : "inline"
      })`;
    case "none":
      return "none (anonymous)";
  }
}

// ----------------------------------------------------------------------------
// argv and plan
// ----------------------------------------------------------------------------

export type Command = "probe" | "stress" | "help";

export interface Args {
  command: Command;
  dryRun: boolean;
  kubeconfig?: string;
  context?: string;
  endpoints: string[];
  paths?: string[];
  interval: string;
  timeout: string;
  duration: string;
  slow: string;
  json?: string;
  concurrency: string;
  stepDuration: string;
  maxConcurrency: string;
  iKnow: boolean;
  http1: boolean;
}

const VALUE_FLAGS = new Set([
  "--kubeconfig",
  "--context",
  "--endpoint",
  "--path",
  "--interval",
  "--timeout",
  "--duration",
  "--slow",
  "--json",
  "--concurrency",
  "--step-duration",
  "--max-concurrency",
]);

/** Parses argv. Throws UsageError on anything invalid. */
export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "help",
    dryRun: false,
    endpoints: [],
    interval: DEFAULT_INTERVAL,
    timeout: DEFAULT_TIMEOUT,
    duration: DEFAULT_DURATION,
    slow: DEFAULT_SLOW,
    concurrency: DEFAULT_CONCURRENCY,
    stepDuration: DEFAULT_STEP_DURATION,
    maxConcurrency: String(DEFAULT_MAX_CONCURRENCY),
    iKnow: false,
    http1: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") return { ...args, command: "help" };
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--i-know") {
      args.iKnow = true;
      continue;
    }
    if (arg === "--http1") {
      args.http1 = true;
      continue;
    }
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (VALUE_FLAGS.has(arg)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined || value.startsWith("--")) {
          throw new UsageError(`${arg} needs a value`);
        }
      }
      switch (arg) {
        case "--kubeconfig":
          args.kubeconfig = value;
          break;
        case "--context":
          args.context = value;
          break;
        case "--endpoint":
          args.endpoints.push(value);
          break;
        case "--path":
          (args.paths ??= []).push(value);
          break;
        case "--interval":
          args.interval = value;
          break;
        case "--timeout":
          args.timeout = value;
          break;
        case "--duration":
          args.duration = value;
          break;
        case "--slow":
          args.slow = value;
          break;
        case "--json":
          args.json = value;
          break;
        case "--concurrency":
          args.concurrency = value;
          break;
        case "--step-duration":
          args.stepDuration = value;
          break;
        case "--max-concurrency":
          args.maxConcurrency = value;
          break;
      }
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`unknown flag ${arg}`);
    positional.push(arg);
  }

  const [command, ...rest] = positional;
  if (command === undefined) return args;
  if (command !== "probe" && command !== "stress") {
    throw new UsageError(
      `unknown subcommand ${JSON.stringify(command)} (probe, stress)`,
    );
  }
  if (rest.length > 0) {
    throw new UsageError(`unexpected argument ${JSON.stringify(rest[0])}`);
  }
  args.command = command;
  return args;
}

export interface Plan {
  command: Command;
  /** --endpoint values, normalised (the kubeconfig server is added in main). */
  extraEndpoints: string[];
  probePaths: string[];
  stressPaths: string[];
  intervalMs: number;
  timeoutMs: number;
  durationMs: number;
  slowMs: number;
  steps: number[];
  stepDurationMs: number;
  http1: boolean;
  json?: string;
}

/** Validates and converts the parsed flags. Pure. */
export function buildPlan(args: Args): Plan {
  if (!/^\d+$/.test(args.maxConcurrency) || Number(args.maxConcurrency) < 1) {
    throw new UsageError(
      `--max-concurrency must be a positive integer, got ${args.maxConcurrency}`,
    );
  }
  const custom = args.paths?.map(normalizePath);
  return {
    command: args.command,
    extraEndpoints: args.endpoints.map(normalizeEndpoint),
    probePaths: custom ?? [...PROBE_PATHS],
    stressPaths: custom ?? [...STRESS_PATHS],
    intervalMs: parseDuration(args.interval, "interval"),
    timeoutMs: parseDuration(args.timeout, "timeout"),
    durationMs: parseDuration(args.duration, "duration"),
    slowMs: parseDuration(args.slow, "slow"),
    steps: parseConcurrency(
      args.concurrency,
      Number(args.maxConcurrency),
      args.iKnow,
    ),
    stepDurationMs: parseDuration(args.stepDuration, "step-duration"),
    http1: args.http1,
    json: args.json,
  };
}

/** Plain aligned table. */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

const iso = (epochMs: number) => new Date(epochMs).toISOString();
const msText = (v: number | null) => v === null ? "-" : `${Math.round(v)}`;
const errorsText = (e: Record<string, number>) =>
  Object.entries(e).map(([k, n]) => `${k}=${n}`).join(",") || "-";
const outageText = (o: Outage | null) =>
  o
    ? `${o.failures} (${iso(o.start).slice(11, 23)}..${
      iso(o.end).slice(11, 23)
    } UTC)`
    : "-";

/** The per-endpoint per-path summary table. */
export function summaryTable(cells: CellSummary[]): string {
  return formatTable(
    [
      "ENDPOINT",
      "PATH",
      "COUNT",
      "OK",
      "ERRORS",
      "P50",
      "P95",
      "P99",
      "MAX",
      "LONGEST OUTAGE",
    ],
    cells.map((c) => [
      c.endpoint,
      c.path,
      String(c.count),
      String(c.ok),
      errorsText(c.errors),
      msText(c.latency.p50),
      msText(c.latency.p95),
      msText(c.latency.p99),
      msText(c.latency.max),
      outageText(c.longestOutage),
    ]),
  );
}

// ============================================================================
// Side effects
// ============================================================================

interface RunContext {
  client: Deno.HttpClient;
  /** Authorization (bearer) when the identity is a token. Never logged. */
  headers: Record<string, string>;
  /** Set on SIGINT: loops stop scheduling and the summary is printed. */
  stop: AbortSignal;
}

function shortError(err: unknown): string {
  const raw = err instanceof Error
    ? `${err.name}: ${err.message}`
    : String(err);
  return raw
    .replace(/error sending request for url \([^)]*\):\s*/i, "")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

/**
 * The only function that builds and sends a request. It is always a GET: the
 * method is a constant and asserted before fetch so a future edit cannot turn
 * the load generator into something that writes.
 */
async function getOnce(
  ctx: RunContext,
  endpoint: string,
  path: string,
  timeoutMs: number,
): Promise<RequestResult> {
  const url = endpoint + path;
  const req = new Request(url, {
    method: METHOD,
    headers: ctx.headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (req.method !== "GET") {
    throw new Error(
      `refusing a ${req.method} request to ${url}: read-only tool`,
    );
  }
  const at = Date.now();
  const t0 = performance.now();
  try {
    const res = await fetch(req, { client: ctx.client });
    const body = await res.text();
    const latencyMs = performance.now() - t0;
    const kind = classifyStatus(res.status);
    return {
      at,
      endpoint,
      path,
      status: res.status,
      kind,
      latencyMs,
      error: kind === "ok"
        ? undefined
        : body.replace(/\s+/g, " ").slice(0, 120),
    };
  } catch (err) {
    return {
      at,
      endpoint,
      path,
      status: null,
      kind: classifyError(err),
      latencyMs: performance.now() - t0,
      error: shortError(err),
    };
  }
}

function eventLine(tag: string, r: RequestResult): string {
  const detail = r.error ? ` (${r.error})` : "";
  return `${iso(r.at)} ${tag} ${r.endpoint} ${r.path} ${r.kind}${detail} ${
    Math.round(r.latencyMs)
  }ms`;
}

/** Prints failures and slow requests as they happen. */
function reportEvent(tag: string, r: RequestResult, slowMs: number): void {
  if (r.kind !== "ok") log.error(eventLine(`${tag} FAIL`, r));
  else if (r.latencyMs > slowMs) log.warn(eventLine(`${tag} SLOW`, r));
}

interface ProbeOptions {
  endpoints: string[];
  paths: string[];
  intervalMs: number;
  timeoutMs: number;
  durationMs: number;
  slowMs: number;
  tag: string;
  /** Called with every result; may swap the Lease path for /version. */
  onResult?: (r: RequestResult) => void;
}

/**
 * Fires one GET per endpoint per path every intervalMs (fixed schedule, not
 * back-to-back) until durationMs has elapsed, then waits for the in-flight
 * requests. A 403 on the Lease switches the remaining ticks to /version.
 */
async function runProbe(
  ctx: RunContext,
  opts: ProbeOptions,
): Promise<RequestResult[]> {
  const results: RequestResult[] = [];
  const inflight = new Set<Promise<void>>();
  let paths = [...opts.paths];
  const start = Date.now();
  const deadline = start + opts.durationMs;
  for (let tick = 0; Date.now() < deadline && !ctx.stop.aborted; tick++) {
    for (const endpoint of opts.endpoints) {
      for (const path of paths) {
        const p = getOnce(ctx, endpoint, path, opts.timeoutMs).then((r) => {
          results.push(r);
          reportEvent(opts.tag, r, opts.slowMs);
          const next = applyLeaseFallback(paths, r);
          if (next.includes(FALLBACK_PATH) && !paths.includes(FALLBACK_PATH)) {
            log.warn(
              `${LEASE_PATH} returned 403 (no RBAC for leases); probing ${FALLBACK_PATH} for the rest of the run`,
            );
          }
          paths = next;
          opts.onResult?.(r);
        });
        inflight.add(p);
        p.finally(() => inflight.delete(p));
      }
    }
    const nextTick = start + (tick + 1) * opts.intervalMs;
    await delay(Math.max(0, nextTick - Date.now()));
  }
  await Promise.all(inflight);
  return results;
}

export interface StepSummary {
  concurrency: number;
  durationMs: number;
  requests: number;
  achievedRps: number;
  errors: Record<string, number>;
  latency: LatencyStats;
  probe: CellSummary[];
}

/**
 * One stress step: N workers looping over endpoints x paths plus the probe.
 *
 * `probeCtx` MUST own a different Deno.HttpClient than `ctx`. Sharing one
 * client makes the probe queue behind the load inside the client's own
 * connection pool, so the "baseline" would measure this process rather than
 * the API server: a run against a perfectly healthy cluster (server-side p99
 * 24 ms, no APF queueing) reported 5 s probe timeouts until they were split.
 */
async function runStep(
  ctx: RunContext,
  probeCtx: RunContext,
  plan: Plan,
  endpoints: string[],
  concurrency: number,
): Promise<{ summary: StepSummary; probeResults: RequestResult[] }> {
  let stressPaths = [...plan.stressPaths];
  const load: RequestResult[] = [];
  let printed = 0;
  const started = Date.now();
  const deadline = started + plan.stepDurationMs;

  const probe = runProbe(probeCtx, {
    endpoints,
    paths: plan.probePaths,
    intervalMs: STRESS_PROBE_INTERVAL_MS,
    timeoutMs: plan.timeoutMs,
    durationMs: plan.stepDurationMs,
    slowMs: plan.slowMs,
    tag: "PROBE",
    onResult: (r) => {
      stressPaths = applyLeaseFallback(stressPaths, r);
    },
  });

  const worker = async (id: number) => {
    for (let i = id; Date.now() < deadline && !ctx.stop.aborted; i++) {
      const targets = endpoints.flatMap((e) =>
        stressPaths.map((p) => ({ endpoint: e, path: p }))
      );
      const t = targets[i % targets.length];
      const r = await getOnce(ctx, t.endpoint, t.path, plan.timeoutMs);
      load.push(r);
      stressPaths = applyLeaseFallback(stressPaths, r);
      if (r.kind !== "ok" && printed < LOAD_EVENT_LIMIT) {
        printed++;
        log.error(eventLine("LOAD FAIL", r));
        if (printed === LOAD_EVENT_LIMIT) {
          log.warn(
            `further load failures in this step are counted, not printed`,
          );
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  const probeResults = await probe;
  const elapsedMs = Date.now() - started;
  return {
    summary: {
      concurrency,
      durationMs: elapsedMs,
      requests: load.length,
      achievedRps: elapsedMs > 0 ? load.length / (elapsedMs / 1000) : 0,
      errors: countErrors(load),
      latency: latencyStats(
        load.filter((r) => r.kind === "ok").map((r) => r.latencyMs),
      ),
      probe: summarize(probeResults),
    },
    probeResults,
  };
}

function printStep(s: StepSummary): void {
  const errs = errorsText(s.errors);
  log.info(
    `step concurrency=${s.concurrency}: ${s.requests} requests in ${
      formatDuration(Math.round(s.durationMs / 1000) * 1000)
    }, ${s.achievedRps.toFixed(1)} req/s, errors ${errs}, ` +
      `p50 ${msText(s.latency.p50)}ms p95 ${msText(s.latency.p95)}ms p99 ${
        msText(s.latency.p99)
      }ms max ${msText(s.latency.max)}ms`,
  );
  console.log("baseline probe during this step:");
  console.log(summaryTable(s.probe));
  if (isClientSaturated(s)) {
    log.warn(
      `step concurrency=${s.concurrency} looks client-limited, not server-limited: ` +
        `load requests timed out while the independent probe stayed healthy and the ` +
        `load requests that did complete were fast. Read this step as "this machine ` +
        `cannot drive ${s.concurrency} concurrent requests", not as an API server limit.`,
    );
  }
}

/**
 * True when the load client, not the API server, is the bottleneck: load
 * requests timed out, yet the probe (its own HTTP client) saw no failure and
 * the load requests that completed were fast. A saturated server slows the
 * probe too; a saturated client only starves its own queue.
 */
export function isClientSaturated(s: StepSummary): boolean {
  const loadTimeouts = s.errors.timeout ?? 0;
  if (loadTimeouts === 0) return false;
  const probeFailed = s.probe.some((c) => c.ok < c.count);
  if (probeFailed) return false;
  return s.latency.p99 !== null && s.latency.p99 < 1000;
}

function buildClient(creds: Credentials, http1: boolean): Deno.HttpClient {
  const base: Deno.CreateHttpClientOptions = {
    caCerts: creds.caPem ? [creds.caPem] : undefined,
    http1: true,
    http2: !http1,
  };
  if (creds.certPem && creds.keyPem) {
    return Deno.createHttpClient({
      ...base,
      cert: creds.certPem,
      key: creds.keyPem,
    });
  }
  return Deno.createHttpClient(base);
}

function printPlan(
  kcPath: string,
  rc: ResolvedContext,
  endpoints: string[],
  plan: Plan,
  dryRun: boolean,
): void {
  const tls = rc.insecureSkipTlsVerify
    ? "insecure-skip-tls-verify (needs --unsafely-ignore-certificate-errors)"
    : rc.ca
    ? `CA from kubeconfig (${rc.ca.kind})`
    : "system trust store";
  // Only a dry run may label these lines DRY: in a real run they are the plan
  // of requests that are about to be made.
  const out = dryRun ? log.dry : log.info;
  out(`kubeconfig ${kcPath}, context ${rc.context}, cluster ${rc.cluster}`);
  out(
    `identity: ${describeIdentity(rc)}; tls: ${tls}; ${
      plan.http1 ? "HTTP/1.1 only" : "HTTP/2 allowed"
    }`,
  );
  out(
    `endpoints: ${
      endpoints.map((e, i) => i === 0 ? `${e} (kubeconfig)` : e).join(", ")
    }`,
  );
  out(
    `probe: every ${formatDuration(plan.intervalMs)} for ${
      formatDuration(plan.durationMs)
    }, timeout ${formatDuration(plan.timeoutMs)}, slow > ${
      formatDuration(plan.slowMs)
    }`,
  );
  out(`probe paths: ${plan.probePaths.join(", ")}`);
  if (plan.command === "stress") {
    out(
      `stress: concurrency ${plan.steps.join(",")} x ${
        formatDuration(plan.stepDurationMs)
      } each, probe every ${
        formatDuration(STRESS_PROBE_INTERVAL_MS)
      } during each step`,
    );
    out(`stress paths: ${plan.stressPaths.join(", ")} (GET only)`);
  }
  if (plan.json) out(`summary JSON: ${plan.json}`);
}

function printHelp(): void {
  console.log(
    `apiserver-stress.ts — read-only Kubernetes API server probe and load ramp

Usage:
  scripts/apiserver-stress.ts probe  [--endpoint https://<ip>:6443 ...] [--path /readyz ...]
                                     [--interval ${DEFAULT_INTERVAL}] [--timeout ${DEFAULT_TIMEOUT}] [--duration ${DEFAULT_DURATION}] [--slow ${DEFAULT_SLOW}]
                                     [--kubeconfig <path>] [--context <name>] [--http1] [--json <file>] [--dry-run]
  scripts/apiserver-stress.ts stress [--concurrency ${DEFAULT_CONCURRENCY}] [--step-duration ${DEFAULT_STEP_DURATION}]
                                     [--max-concurrency ${DEFAULT_MAX_CONCURRENCY}] [--i-know] + the probe flags above

Subcommands:
  probe   Every --interval, one GET per endpoint per path; failures and slow requests are printed
          as they happen; at the end a per-endpoint per-path table (count, ok, errors by kind,
          p50/p95/p99/max ms, longest outage). Exit 1 if any probe request failed.
  stress  For each --concurrency step, that many workers loop GET over endpoints x paths for
          --step-duration while a 1/s probe runs alongside. Per step: req/s, errors by kind,
          latency percentiles and the probe table. Exit 1 if the probe failed during any step.

Endpoints: the server of the kubeconfig context, plus each --endpoint (repeatable) so the VIP
and every control plane can be probed side by side. The kubeconfig CA verifies all of them.
Paths:     default ${PROBE_PATHS.join(" and ")}
           (Lease 403 -> ${FALLBACK_PATH}); stress adds ${
      STRESS_PATHS.slice(2).join(" and ")
    }.
           --path (repeatable) replaces the defaults for both subcommands.
Durations: 30s, 5m, 250ms, or plain seconds (90).
Auth:      --kubeconfig, else the first path in $KUBECONFIG, else ~/.kube/config; --context
           (default current-context). client-certificate(-data)/client-key(-data), token and
           tokenFile are supported; exec plugins are not. Tokens are never printed.
           insecure-skip-tls-verify: also run deno with --unsafely-ignore-certificate-errors=<host>.

Every request is a GET (asserted in the single request function); nothing can modify the cluster.
Exit codes: 0 success, 1 failures observed or run failed, 2 usage error.`,
  );
}

async function main(): Promise<number> {
  let args: Args;
  let plan: Plan;
  try {
    args = parseArgs(Deno.args);
    if (args.command === "help") {
      printHelp();
      return 0;
    }
    plan = buildPlan(args);
  } catch (err) {
    if (err instanceof UsageError) {
      log.error(err.message);
      console.error("run with --help for usage");
      return 2;
    }
    throw err;
  }

  const stopController = new AbortController();
  let interrupts = 0;
  const onInterrupt = () => {
    interrupts++;
    if (interrupts > 1) Deno.exit(130);
    log.warn(
      "interrupted: waiting for in-flight requests, then printing the summary (Ctrl-C again to quit)",
    );
    stopController.abort();
  };

  let client: Deno.HttpClient | undefined;
  let probeClient: Deno.HttpClient | undefined;
  try {
    const kcPath = kubeconfigPath(
      args.kubeconfig,
      Deno.env.get("KUBECONFIG"),
      Deno.env.get("HOME") ?? "",
    );
    let doc: unknown;
    try {
      doc = parseYaml(await Deno.readTextFile(kcPath));
    } catch (err) {
      throw new UsageError(
        `cannot read kubeconfig ${kcPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const rc = resolveContext(doc, args.context);
    const endpoints = [
      ...new Set([normalizeEndpoint(rc.server), ...plan.extraEndpoints]),
    ];
    printPlan(kcPath, rc, endpoints, plan, args.dryRun);
    if (args.dryRun) {
      log.dry("no requests were made");
      return 0;
    }
    if (rc.identity.type === "none") {
      log.warn(
        "no client certificate or token in the kubeconfig user: requests are anonymous",
      );
    }
    if (rc.insecureSkipTlsVerify) {
      log.warn(
        "insecure-skip-tls-verify is set: certificate errors will show as kind tls unless deno runs with --unsafely-ignore-certificate-errors",
      );
    }

    const creds = await loadCredentials(rc, dirname(kcPath), Deno.readTextFile);
    client = buildClient(creds, plan.http1);
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (creds.token) headers.authorization = `Bearer ${creds.token}`;
    const ctx: RunContext = { client, headers, stop: stopController.signal };
    // The stress probe needs its own connection pool; see runStep().
    if (plan.command === "stress") {
      probeClient = buildClient(creds, plan.http1);
    }
    const probeCtx: RunContext = probeClient
      ? { client: probeClient, headers, stop: stopController.signal }
      : ctx;
    Deno.addSignalListener("SIGINT", onInterrupt);

    const startedAt = Date.now();
    let probeFailures = 0;
    // deno-lint-ignore no-explicit-any
    const report: Record<string, any> = {
      command: plan.command,
      startedAt: iso(startedAt),
      context: rc.context,
      identity: rc.identity.type,
      endpoints,
    };

    if (plan.command === "probe") {
      log.info(
        `probing ${endpoints.length} endpoint(s) x ${plan.probePaths.length} path(s); failures and slow requests print as they happen`,
      );
      const results = await runProbe(ctx, {
        endpoints,
        paths: plan.probePaths,
        intervalMs: plan.intervalMs,
        timeoutMs: plan.timeoutMs,
        durationMs: plan.durationMs,
        slowMs: plan.slowMs,
        tag: "PROBE",
      });
      const cells = summarize(results);
      console.log("");
      console.log(summaryTable(cells));
      probeFailures = results.filter((r) => r.kind !== "ok").length;
      report.probe = cells;
    } else {
      const steps: StepSummary[] = [];
      for (const n of plan.steps) {
        if (ctx.stop.aborted) break;
        log.info(
          `step: concurrency ${n} for ${
            formatDuration(plan.stepDurationMs)
          } (GET only) with a 1/s probe alongside`,
        );
        const { summary, probeResults } = await runStep(
          ctx,
          probeCtx,
          plan,
          endpoints,
          n,
        );
        printStep(summary);
        steps.push(summary);
        probeFailures += probeResults.filter((r) => r.kind !== "ok").length;
      }
      report.steps = steps;
    }
    report.endedAt = iso(Date.now());
    report.probeFailures = probeFailures;
    report.interrupted = ctx.stop.aborted;

    if (plan.json) {
      await Deno.writeTextFile(
        plan.json,
        JSON.stringify(report, null, 2) + "\n",
      );
      log.info(`summary written to ${plan.json}`);
    }
    if (probeFailures === 0) {
      log.ok(
        `no probe failures between ${report.startedAt} and ${report.endedAt}`,
      );
      return 0;
    }
    log.error(
      `${probeFailures} probe failure(s) between ${report.startedAt} and ${report.endedAt}`,
    );
    return 1;
  } catch (err) {
    if (err instanceof UsageError) {
      log.error(err.message);
      return 2;
    }
    log.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    try {
      Deno.removeSignalListener("SIGINT", onInterrupt);
    } catch {
      // not registered (dry run or early error)
    }
    client?.close();
    probeClient?.close();
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
