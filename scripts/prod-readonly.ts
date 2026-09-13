#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env --allow-read --allow-write

/**
 * prod-readonly.ts
 *
 * Read-only access to the homelab (production) cluster for agents and humans
 * (issue #261 item 18, docs/runbooks/readonly-access.md). Nothing here can
 * change production (ADR-009): the Kubernetes identity is the agent-readonly
 * ServiceAccount (charts/agent-readonly: `view` + homelab-agent-readonly,
 * no Secrets, no write verbs) and the ArgoCD identity is the `agent` account
 * (role:readonly). Both tokens live in 1Password and are read with `op read`.
 *
 * Subcommands:
 *   kubeconfig  Write ~/.kube/homelab-readonly.yaml (mode 0600, context
 *               homelab-readonly). Server: https://<hostname>.<tailnet>, the
 *               Tailscale operator's API server proxy in "noauth" mode, which
 *               forwards the bearer token to the kube-apiserver unchanged. The
 *               tailnet comes from --tailnet, $HOMELAB_TAILNET or
 *               `tailscale status --json` (MagicDNSSuffix). The token comes from
 *               `op read <--token-ref>`. The file is separate from
 *               ~/.kube/config on purpose and is never written there. --dry-run
 *               prints the file with the token redacted and reads nothing from
 *               1Password.
 *   status      Application table (name, sync, health, operation, revision)
 *               through that kubeconfig and context (one `kubectl get`).
 *   diff <app>  `argocd app diff <app> --server <host> --grpc-web
 *               --exit-code=false` as the read-only `agent` account. The token
 *               (`op read <--argocd-token-ref>`) is passed in ARGOCD_AUTH_TOKEN,
 *               never on the command line, and the CLI gets an empty private
 *               --config so no other login can be used. Server: --argocd-server,
 *               $HOMELAB_ARGOCD_SERVER, or argocd.<DOMAIN> from the gitignored
 *               configuration/environments/homelab.yaml.
 *
 * The token is never printed: every message goes through redact(), and
 * --dry-run renders the kubeconfig with "<redacted>".
 *
 * Usage:
 *   task prod:kubeconfig [-- --tailnet tail1234.ts.net] [-- --dry-run]
 *   task prod:status
 *   task prod:diff -- <app>
 *   deno run ... scripts/prod-readonly.ts --help
 *
 * Exit codes: 0 = success; 1 = a command failed; 2 = argument error.
 */

import { stringify as stringifyYaml } from "jsr:@std/yaml@^1";
import { parse as parseYaml } from "jsr:@std/yaml@^1";
import { dirname, join, resolve } from "jsr:@std/path@^1";

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
export const DEFAULT_CONTEXT = "homelab-readonly";
export const DEFAULT_USER = "agent-readonly";
/** 1Password reference of the agent-readonly ServiceAccount token. */
export const DEFAULT_TOKEN_REF = "op://homelab/k8s-agent-readonly/credential";
/** 1Password reference of the ArgoCD `agent` account API token. */
export const DEFAULT_ARGOCD_TOKEN_REF =
  "op://homelab/argocd-agent-token/credential";
/** tailscale-operator.hostname in charts/addons (operatorConfig.hostname). */
export const DEFAULT_HOSTNAME = "tailscale-operator-homelab";
export const DEFAULT_REQUEST_TIMEOUT = "30s";
export const DEFAULT_NAMESPACE = "argocd";
export const REDACTED = "<redacted>";
export const HOMELAB_ENV_FILE = "configuration/environments/homelab.yaml";

// ============================================================================
// Pure helpers (unit-tested in prod-readonly_test.ts)
// ============================================================================

/** Raised for invalid invocations; main maps it to exit code 2. */
export class UsageError extends Error {}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_NAME =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** ~/.kube/homelab-readonly.yaml for the given home directory. */
export function defaultKubeconfigPath(home: string): string {
  return join(home, ".kube", "homelab-readonly.yaml");
}

/**
 * Normalises a tailnet name to its MagicDNS domain: "tail1234" and
 * "tail1234.ts.net." both become "tail1234.ts.net".
 */
export function tailnetDomain(tailnet: string): string {
  const t = tailnet.trim().toLowerCase().replace(/\.$/, "");
  if (!DNS_NAME.test(t)) {
    throw new UsageError(
      `invalid tailnet ${
        JSON.stringify(tailnet)
      } (expected e.g. tail1234.ts.net)`,
    );
  }
  return t.endsWith(".ts.net") ? t : `${t}.ts.net`;
}

/** https://<hostname>.<tailnet>.ts.net — the operator's API server proxy. */
export function proxyServerUrl(hostname: string, tailnet: string): string {
  const h = hostname.trim().toLowerCase();
  if (!DNS_LABEL.test(h)) {
    throw new UsageError(
      `invalid --hostname ${JSON.stringify(hostname)} (a single DNS label)`,
    );
  }
  return `https://${h}.${tailnetDomain(tailnet)}`;
}

export interface KubeconfigInput {
  server: string;
  token: string;
  context: string;
  user: string;
  namespace: string;
}

/**
 * The kubeconfig for the read-only context. No certificate-authority data:
 * the proxy serves the tailnet's Let's Encrypt certificate (Tailscale HTTPS),
 * which the system trust store accepts.
 */
export function renderKubeconfig(input: KubeconfigInput): string {
  const doc = {
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name: input.context, cluster: { server: input.server } }],
    contexts: [{
      name: input.context,
      context: {
        cluster: input.context,
        user: input.user,
        namespace: input.namespace,
      },
    }],
    "current-context": input.context,
    users: [{ name: input.user, user: { token: input.token } }],
    preferences: {},
  };
  return [
    "# Generated by scripts/prod-readonly.ts kubeconfig (task prod:kubeconfig).",
    "# Read-only agent identity for the homelab cluster (charts/agent-readonly):",
    "# no Secrets, no write verbs. Holds a credential: mode 0600, never commit it.",
    "# docs/runbooks/readonly-access.md",
    stringifyYaml(doc).trimEnd(),
    "",
  ].join("\n");
}

/** The kubeconfig with the token replaced by <redacted> (for --dry-run). */
export function kubeconfigPreview(input: KubeconfigInput): string {
  return renderKubeconfig({ ...input, token: REDACTED });
}

/** Replaces every occurrence of each non-empty secret in text. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join(REDACTED);
  }
  return out;
}

/**
 * Validates a ServiceAccount token (a JWT) without ever echoing it.
 * Returns the trimmed token.
 */
export function checkToken(raw: string, ref: string): string {
  const token = raw.trim();
  if (!token) throw new Error(`${ref} is empty`);
  if (!JWT.test(token)) {
    throw new Error(
      `${ref} does not look like a Kubernetes ServiceAccount token (expected a JWT)`,
    );
  }
  return token;
}

/** The only kubectl invocation `status` makes: a read of the Applications. */
export function kubectlStatusCmd(
  kubeconfig: string,
  context: string,
  requestTimeout: string,
): string[] {
  return [
    "kubectl",
    "--kubeconfig",
    kubeconfig,
    "--context",
    context,
    "--request-timeout",
    requestTimeout,
    "get",
    "applications.argoproj.io",
    "-n",
    DEFAULT_NAMESPACE,
    "-o",
    "json",
  ];
}

/**
 * `argocd app diff` for one app. The token is NOT part of argv (it travels in
 * ARGOCD_AUTH_TOKEN); --config points at an empty private file so no other
 * saved login is ever used.
 */
export function argocdDiffCmd(
  app: string,
  server: string,
  configPath: string,
): string[] {
  return [
    "argocd",
    "app",
    "diff",
    app,
    "--server",
    server,
    "--grpc-web",
    "--exit-code=false",
    "--config",
    configPath,
  ];
}

/** DOMAIN from configuration/environments/homelab.yaml, ignoring placeholders. */
export function domainFromEnvFile(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const domain = (parsed as Record<string, unknown>).DOMAIN;
  if (typeof domain !== "string") return null;
  const d = domain.trim().toLowerCase();
  if (!d || d.includes("replaceme") || !DNS_NAME.test(d)) return null;
  return d;
}

// deno-lint-ignore no-explicit-any
type Json = any;

export interface AppRow {
  name: string;
  sync: string;
  health: string;
  operation: string;
  revision: string;
}

/** One row per Application, sorted by name. */
export function statusRows(list: Json): AppRow[] {
  const items: Json[] = Array.isArray(list?.items) ? list.items : [];
  return items
    .map((app) => {
      const revision = String(app?.status?.sync?.revision ?? "");
      return {
        name: String(app?.metadata?.name ?? "?"),
        sync: String(app?.status?.sync?.status ?? "-"),
        health: String(app?.status?.health?.status ?? "-"),
        operation: String(app?.status?.operationState?.phase ?? "-"),
        revision: revision ? revision.slice(0, 7) : "-",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Healthy with a Succeeded last operation: the `verify prod` contract. */
export function isRowHealthy(row: AppRow): boolean {
  return row.health === "Healthy" && row.operation === "Succeeded";
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

export type Command = "kubeconfig" | "status" | "diff" | "help";

export interface Args {
  command: Command;
  app?: string;
  dryRun: boolean;
  tokenRef: string;
  argocdTokenRef: string;
  tailnet?: string;
  hostname: string;
  server?: string;
  kubeconfig: string;
  context: string;
  argocdServer?: string;
  requestTimeout: string;
}

export interface ArgEnv {
  home: string;
  tailnet?: string;
  argocdServer?: string;
}

const VALUE_FLAGS = new Set([
  "--token-ref",
  "--argocd-token-ref",
  "--tailnet",
  "--hostname",
  "--server",
  "--kubeconfig",
  "--context",
  "--argocd-server",
  "--request-timeout",
]);

/** Parses argv. Throws UsageError on anything invalid. */
export function parseArgs(argv: string[], env: ArgEnv): Args {
  const args: Args = {
    command: "help",
    dryRun: false,
    tokenRef: DEFAULT_TOKEN_REF,
    argocdTokenRef: DEFAULT_ARGOCD_TOKEN_REF,
    tailnet: env.tailnet || undefined,
    hostname: DEFAULT_HOSTNAME,
    kubeconfig: defaultKubeconfigPath(env.home),
    context: DEFAULT_CONTEXT,
    argocdServer: env.argocdServer || undefined,
    requestTimeout: DEFAULT_REQUEST_TIMEOUT,
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
        case "--token-ref":
          args.tokenRef = value;
          break;
        case "--argocd-token-ref":
          args.argocdTokenRef = value;
          break;
        case "--tailnet":
          args.tailnet = value;
          break;
        case "--hostname":
          args.hostname = value;
          break;
        case "--server":
          args.server = value;
          break;
        case "--kubeconfig":
          args.kubeconfig = value;
          break;
        case "--context":
          args.context = value;
          break;
        case "--argocd-server":
          args.argocdServer = value;
          break;
        case "--request-timeout":
          args.requestTimeout = value;
          break;
      }
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`unknown flag ${arg}`);
    positional.push(arg);
  }

  const [command, ...rest] = positional;
  if (command === undefined) return args;
  if (command !== "kubeconfig" && command !== "status" && command !== "diff") {
    throw new UsageError(
      `unknown subcommand ${
        JSON.stringify(command)
      } (kubeconfig, status, diff)`,
    );
  }
  args.command = command;

  if (command === "diff") {
    if (rest.length !== 1) {
      throw new UsageError(
        "diff needs exactly one Application name: diff <app>",
      );
    }
    const app = rest[0];
    if (!DNS_NAME.test(app) || app.length > 253) {
      throw new UsageError(`invalid Application name ${JSON.stringify(app)}`);
    }
    args.app = app;
  } else if (rest.length > 0) {
    throw new UsageError(`unexpected argument ${JSON.stringify(rest[0])}`);
  }

  for (
    const [flag, ref] of [["--token-ref", args.tokenRef], [
      "--argocd-token-ref",
      args.argocdTokenRef,
    ]]
  ) {
    if (!ref.startsWith("op://")) {
      throw new UsageError(
        `${flag} must be a 1Password reference (op://...), got ${ref}`,
      );
    }
  }
  if (args.server !== undefined && !args.server.startsWith("https://")) {
    throw new UsageError(
      `--server must be an https:// URL, got ${args.server}`,
    );
  }
  if (args.context.startsWith("kind-")) {
    throw new UsageError(
      `--context ${args.context} is a Kind context; this script reads production only`,
    );
  }
  if (!/^[1-9][0-9]*(ms|s|m)$/.test(args.requestTimeout)) {
    throw new UsageError(
      `--request-timeout must look like 30s, got ${args.requestTimeout}`,
    );
  }
  if (command === "kubeconfig" && isMainKubeconfig(args.kubeconfig, env.home)) {
    throw new UsageError(
      `refusing to write ${args.kubeconfig}: the read-only context lives in its own file`,
    );
  }
  return args;
}

/** Whether path is the default kubeconfig (~/.kube/config), which is never written. */
export function isMainKubeconfig(path: string, home: string): boolean {
  return resolve(path) === resolve(join(home, ".kube", "config"));
}

// ============================================================================
// Side effects
// ============================================================================

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string[],
  env?: Record<string, string>,
): Promise<RunResult> {
  try {
    const out = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    return {
      code: out.code,
      stdout: dec.decode(out.stdout),
      stderr: dec.decode(out.stderr),
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return {
        code: 127,
        stdout: "",
        stderr: `${cmd[0]}: command not found on PATH`,
      };
    }
    throw err;
  }
}

/** Reads one secret with `op read`; the value is never logged. */
async function opRead(ref: string): Promise<string> {
  const res = await run(["op", "read", ref]);
  if (res.code !== 0) {
    throw new Error(
      `op read ${ref} failed (exit ${res.code}): ${
        res.stderr.trim() || "no output"
      }` +
        " — sign in with `op signin` or check the item exists (docs/runbooks/readonly-access.md)",
    );
  }
  return res.stdout;
}

/** The tailnet domain: --tailnet / $HOMELAB_TAILNET, else `tailscale status --json`. */
async function resolveTailnet(args: Args): Promise<string> {
  if (args.tailnet) return tailnetDomain(args.tailnet);
  const res = await run(["tailscale", "status", "--json"]);
  if (res.code === 0) {
    try {
      const suffix = JSON.parse(res.stdout)?.MagicDNSSuffix;
      if (typeof suffix === "string" && suffix) return tailnetDomain(suffix);
    } catch {
      // fall through to the usage error
    }
  }
  throw new UsageError(
    "cannot determine the tailnet: pass --tailnet <name>.ts.net or set HOMELAB_TAILNET " +
      "(`tailscale status --json` gave no MagicDNSSuffix)",
  );
}

async function cmdKubeconfig(args: Args): Promise<number> {
  const server = args.server ??
    proxyServerUrl(args.hostname, await resolveTailnet(args));
  const input: KubeconfigInput = {
    server,
    token: REDACTED,
    context: args.context,
    user: DEFAULT_USER,
    namespace: DEFAULT_NAMESPACE,
  };

  if (args.dryRun) {
    log.dry(`would read the token with: op read ${args.tokenRef}`);
    log.dry(`would write ${args.kubeconfig} (mode 0600):`);
    console.log(kubeconfigPreview(input));
    return 0;
  }

  const token = checkToken(await opRead(args.tokenRef), args.tokenRef);
  const text = renderKubeconfig({ ...input, token });
  await Deno.mkdir(dirname(args.kubeconfig), { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(args.kubeconfig, text, { mode: 0o600 });
  await Deno.chmod(args.kubeconfig, 0o600);
  log.ok(
    `wrote ${args.kubeconfig} (mode 0600): context ${args.context}, server ${server}`,
  );
  log.info("next: task verify:prod (Application health) or task prod:status");
  return 0;
}

async function cmdStatus(args: Args): Promise<number> {
  const cmd = kubectlStatusCmd(
    args.kubeconfig,
    args.context,
    args.requestTimeout,
  );
  if (args.dryRun) {
    log.dry(cmd.join(" "));
    return 0;
  }
  const res = await run(cmd);
  if (res.code !== 0) {
    log.error(`kubectl get applications failed (exit ${res.code}):`);
    console.error(res.stderr.trim());
    log.info(
      "run task prod:kubeconfig and check Tailscale is connected (docs/runbooks/readonly-access.md)",
    );
    return 1;
  }
  const rows = statusRows(JSON.parse(res.stdout));
  console.log(formatTable(
    ["NAME", "SYNC", "HEALTH", "OPERATION", "REVISION"],
    rows.map((r) => [r.name, r.sync, r.health, r.operation, r.revision]),
  ));
  const bad = rows.filter((r) => !isRowHealthy(r));
  if (bad.length === 0) {
    log.ok(
      `${rows.length} Applications, all Healthy with a Succeeded last operation`,
    );
  } else {
    log.warn(
      `${bad.length} of ${rows.length} Applications not Healthy/Succeeded: ${
        bad.map((r) => r.name).join(", ")
      }`,
    );
  }
  return 0;
}

async function resolveArgocdServer(args: Args): Promise<string> {
  if (args.argocdServer) return args.argocdServer;
  try {
    const domain = domainFromEnvFile(await Deno.readTextFile(HOMELAB_ENV_FILE));
    if (domain) return `argocd.${domain}`;
  } catch {
    // fall through
  }
  throw new UsageError(
    `cannot determine the ArgoCD server: pass --argocd-server <host>, set HOMELAB_ARGOCD_SERVER, ` +
      `or fill DOMAIN in ${HOMELAB_ENV_FILE}`,
  );
}

async function cmdDiff(args: Args): Promise<number> {
  const server = await resolveArgocdServer(args);
  const configDir = args.dryRun
    ? "<temp-dir>"
    : await Deno.makeTempDir({ prefix: "homelab-argocd-readonly-" });
  const cmd = argocdDiffCmd(args.app!, server, join(configDir, "config"));
  if (args.dryRun) {
    log.dry(`would read the token with: op read ${args.argocdTokenRef}`);
    log.dry(`ARGOCD_AUTH_TOKEN=${REDACTED} ${cmd.join(" ")}`);
    return 0;
  }
  try {
    const token = (await opRead(args.argocdTokenRef)).trim();
    if (!token) throw new Error(`${args.argocdTokenRef} is empty`);
    log.info(
      `argocd app diff ${args.app} --server ${server} (read-only account agent)`,
    );
    const res = await run(cmd, { ARGOCD_AUTH_TOKEN: token });
    const out = redact(res.stdout, [token]);
    const err = redact(res.stderr, [token]);
    if (out) console.log(out.trimEnd());
    if (res.code !== 0) {
      log.error(`argocd app diff failed (exit ${res.code}): ${err.trim()}`);
      return 1;
    }
    if (!out.trim()) {
      log.ok(`${args.app}: no difference between Git and the live cluster`);
    }
    return 0;
  } finally {
    await Deno.remove(configDir, { recursive: true }).catch(() => {});
  }
}

function printHelp(): void {
  console.log(
    `prod-readonly.ts — read-only access to the homelab cluster (docs/runbooks/readonly-access.md)

Usage:
  scripts/prod-readonly.ts kubeconfig [--tailnet <name>.ts.net] [--hostname ${DEFAULT_HOSTNAME}]
                                      [--server https://...] [--token-ref ${DEFAULT_TOKEN_REF}]
                                      [--kubeconfig <path>] [--context ${DEFAULT_CONTEXT}] [--dry-run]
  scripts/prod-readonly.ts status     [--kubeconfig <path>] [--context ${DEFAULT_CONTEXT}] [--request-timeout 30s]
  scripts/prod-readonly.ts diff <app> [--argocd-server <host>] [--argocd-token-ref ${DEFAULT_ARGOCD_TOKEN_REF}]

Subcommands:
  kubeconfig  Write the read-only kubeconfig (default ~/.kube/homelab-readonly.yaml, mode 0600)
              for the Tailscale API server proxy https://<hostname>.<tailnet>. The token is read
              with op read; --dry-run prints the file with the token redacted.
  status      Application table through the read-only context (one kubectl get).
  diff <app>  argocd app diff as the read-only ArgoCD account agent (token via ARGOCD_AUTH_TOKEN).

Environment:
  HOMELAB_TAILNET        default for --tailnet (else tailscale status --json MagicDNSSuffix)
  HOMELAB_ARGOCD_SERVER  default for --argocd-server (else argocd.<DOMAIN> from ${HOMELAB_ENV_FILE})

Nothing here can modify the cluster: the identities are read-only by RBAC (ADR-009).
Exit codes: 0 success, 1 failure, 2 usage error.`,
  );
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(Deno.args, {
      home: Deno.env.get("HOME") ?? "",
      tailnet: Deno.env.get("HOMELAB_TAILNET"),
      argocdServer: Deno.env.get("HOMELAB_ARGOCD_SERVER"),
    });
  } catch (err) {
    if (err instanceof UsageError) {
      log.error(err.message);
      console.error("run with --help for usage");
      return 2;
    }
    throw err;
  }
  if (!args.dryRun && args.command !== "help" && !Deno.env.get("HOME")) {
    log.error("HOME is not set");
    return 2;
  }
  try {
    switch (args.command) {
      case "help":
        printHelp();
        return 0;
      case "kubeconfig":
        return await cmdKubeconfig(args);
      case "status":
        return await cmdStatus(args);
      case "diff":
        return await cmdDiff(args);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      log.error(err.message);
      return 2;
    }
    log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
