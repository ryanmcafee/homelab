#!/usr/bin/env bun

/**
 * tailscale-dns.ts
 *
 * Split DNS for the homelab domain on the tailnet (docs/runbooks/tailscale-dns.md).
 *
 * Devices on the tailnet (phones, laptops off the LAN) cannot resolve private
 * hostnames such as argocd.<DOMAIN> because those records only exist on the
 * UniFi gateway's resolver. Tailscale "split DNS" sends lookups for one domain
 * to a chosen nameserver, so this script points <DOMAIN> at GATEWAY_IP, the
 * gateway's address inside the LAN /24 the Connector subnet router advertises
 * (TAILSCALE_ADVERTISE_ROUTES). The ACL grant `autogroup:member ->
 * <GATEWAY_IP>/32 udp:53,tcp:53` in policy.sops.hujson opens the path.
 *
 * The tailnet DNS settings are not part of the ACL policy file, so they are
 * managed here through the Tailscale API with an OAuth client that has the
 * `dns` scope (read and write). Its client_id/client_secret live in 1Password
 * (default op://homelab/tailscale-dns-oauth) and are read with `op read`;
 * nothing is printed, and the access token never leaves this process.
 *
 * Subcommands:
 *   status   Print MagicDNS, global nameservers, search paths and split DNS.
 *   apply    PATCH split DNS so <domain> -> <nameservers>. Idempotent: no
 *            request is made when the tailnet already matches. Only the
 *            requested domain is touched (the API's PATCH semantics); every
 *            other split-DNS domain stays as it is. --dry-run prints the
 *            planned PATCH body and reads nothing from 1Password or the API.
 *   remove   PATCH split DNS with <domain>: null (clears that domain only).
 *
 * Defaults come from the gitignored configuration/environments/homelab.yaml:
 * --domain <- DOMAIN, --nameserver <- GATEWAY_IP. Flags win.
 *
 * Usage:
 *   task tailscale:dns:status
 *   task tailscale:dns:apply -- --dry-run
 *   task tailscale:dns:apply
 *   bun scripts/tailscale-dns.ts --help
 *
 * Exit codes: 0 = success; 1 = a request failed; 2 = argument error.
 */

import { readFile } from "node:fs/promises";
import { isNotFound } from "./lib/errors.ts";
import { parse as parseYaml } from "./lib/yaml.ts";

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
export const API_BASE = "https://api.tailscale.com/api/v2";
/** 1Password item holding the OAuth client (fields client_id, client_secret). */
export const DEFAULT_OAUTH_REF = "op://homelab/tailscale-dns-oauth";
/** "-" is the API's alias for the tailnet the OAuth client belongs to. */
export const DEFAULT_TAILNET = "-";
export const HOMELAB_ENV_FILE = "configuration/environments/homelab.yaml";

// ============================================================================
// Pure helpers (unit-tested in tailscale-dns_test.ts)
// ============================================================================

/** Raised for invalid invocations; main maps it to exit code 2. */
export class UsageError extends Error {}

const DNS_NAME =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;
/** Tailnet names look like "example.com", "user@github" or "-". */
const TAILNET = /^(-|[a-z0-9][-a-z0-9.@_]*[a-z0-9])$/i;

export type Command = "help" | "status" | "apply" | "remove";

export interface Args {
  command: Command;
  dryRun: boolean;
  domain?: string;
  nameservers: string[];
  oauthRef: string;
  tailnet: string;
}

/** Defaults taken from configuration/environments/homelab.yaml. */
export interface ArgEnv {
  domain?: string;
  nameserver?: string;
}

const VALUE_FLAGS = new Set([
  "--domain",
  "--nameserver",
  "--oauth-ref",
  "--tailnet",
]);

export function normalizeDomain(domain: string): string {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.length > 253 || !DNS_NAME.test(d)) {
    throw new UsageError(
      `invalid domain ${JSON.stringify(domain)} (expected e.g. example.com)`,
    );
  }
  return d;
}

export function isIpAddress(value: string): boolean {
  return IPV4.test(value) || IPV6.test(value);
}

export function parseArgs(argv: string[], env: ArgEnv): Args {
  const args: Args = {
    command: "help",
    dryRun: false,
    nameservers: [],
    oauthRef: DEFAULT_OAUTH_REF,
    tailnet: DEFAULT_TAILNET,
  };
  const positional: string[] = [];
  let domain: string | undefined;

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
        case "--domain":
          domain = value;
          break;
        case "--nameserver":
          args.nameservers.push(value.trim());
          break;
        case "--oauth-ref":
          args.oauthRef = value;
          break;
        case "--tailnet":
          args.tailnet = value;
          break;
      }
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`unknown flag ${arg}`);
    positional.push(arg);
  }

  const [command, ...rest] = positional;
  if (command === undefined) return args;
  if (command !== "status" && command !== "apply" && command !== "remove") {
    throw new UsageError(
      `unknown subcommand ${JSON.stringify(command)} (status, apply, remove)`,
    );
  }
  if (rest.length > 0) {
    throw new UsageError(`unexpected argument ${JSON.stringify(rest[0])}`);
  }
  args.command = command;

  if (!/^op:\/\/[^/]+\/[^/]+$/.test(args.oauthRef)) {
    throw new UsageError(
      `--oauth-ref must be a 1Password item reference (op://<vault>/<item>, no field), got ${args.oauthRef}`,
    );
  }
  if (!TAILNET.test(args.tailnet)) {
    throw new UsageError(`invalid tailnet ${JSON.stringify(args.tailnet)}`);
  }

  if (domain !== undefined) {
    args.domain = normalizeDomain(domain);
  } else if (env.domain) {
    args.domain = normalizeDomain(env.domain);
  }
  if (args.nameservers.length === 0 && env.nameserver) {
    args.nameservers = [env.nameserver.trim()];
  }
  for (const ns of args.nameservers) {
    if (!isIpAddress(ns)) {
      throw new UsageError(
        `invalid nameserver ${JSON.stringify(ns)} (expected an IP address)`,
      );
    }
  }

  if (command === "apply" || command === "remove") {
    if (args.domain === undefined) {
      throw new UsageError(
        `${command} needs --domain (or DOMAIN in ${HOMELAB_ENV_FILE})`,
      );
    }
  }
  if (command === "apply" && args.nameservers.length === 0) {
    throw new UsageError(
      `apply needs at least one --nameserver (or GATEWAY_IP in ${HOMELAB_ENV_FILE})`,
    );
  }
  if (command === "remove") args.nameservers = [];
  return args;
}

/**
 * A trimmed, lower-cased string value from the environment YAML, or null when
 * the file does not parse, the key is missing, empty, a REPLACEME placeholder
 * or not a plausible hostname/IP.
 */
export function envFileValue(text: string, key: string): string | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = (parsed as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v || v.includes("replaceme")) return null;
  if (!isIpAddress(v) && !(v.includes(".") && DNS_NAME.test(v))) return null;
  return v;
}

/** GET/PATCH body of /dns/split-dns: domain -> nameservers (null clears). */
export type SplitDns = Record<string, string[] | null>;

export interface Plan {
  changed: boolean;
  /** What the tailnet has for the domain right now (undefined = unset). */
  current: string[] | undefined;
  /** PATCH body; only the requested domain, so other domains are untouched. */
  patch: SplitDns;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function planSplitDns(
  current: SplitDns,
  domain: string,
  nameservers: string[],
): Plan {
  const now = current[domain] ?? undefined;
  return {
    changed: now === undefined || !sameSet(now, nameservers),
    current: now,
    patch: { [domain]: nameservers },
  };
}

export function planRemove(current: SplitDns, domain: string): Plan {
  const now = current[domain] ?? undefined;
  return {
    changed: now !== undefined,
    current: now,
    patch: { [domain]: null },
  };
}

export interface DnsStatus {
  magicDNS: boolean;
  nameservers: string[];
  searchPaths: string[];
  splitDns: SplitDns;
}

export function formatStatus(s: DnsStatus): string {
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "(none)");
  const lines = [
    `MagicDNS: ${s.magicDNS ? "enabled" : "disabled"}`,
    `Global nameservers: ${list(s.nameservers)}`,
    `Search paths: ${list(s.searchPaths)}`,
    "Split DNS:",
  ];
  const domains = Object.keys(s.splitDns).sort();
  if (domains.length === 0) lines.push("  (none)");
  for (const d of domains) lines.push(`  ${d} -> ${list(s.splitDns[d] ?? [])}`);
  return lines.join("\n");
}

// ============================================================================
// 1Password + Tailscale API
// ============================================================================

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string[]): Promise<RunResult> {
  try {
    const p = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, stdout, stderr };
  } catch (err) {
    if (isNotFound(err)) {
      return {
        code: 127,
        stdout: "",
        stderr: `${cmd[0]}: command not found on PATH`,
      };
    }
    throw err;
  }
}

async function opRead(ref: string): Promise<string> {
  const res = await run(["op", "read", ref]);
  if (res.code !== 0) {
    throw new Error(
      `op read ${ref} failed (exit ${res.code}): ${
        res.stderr.trim() || "no output"
      }` +
        " — sign in with `op signin` or create the item (docs/runbooks/tailscale-dns.md)",
    );
  }
  return res.stdout.trim();
}

/** Exchanges the OAuth client in 1Password for a short-lived API token. */
async function oauthToken(oauthRef: string): Promise<string> {
  const clientId = await opRead(`${oauthRef}/client_id`);
  const clientSecret = await opRead(`${oauthRef}/client_secret`);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    // The response body can echo the client id; never print it.
    throw new Error(
      `OAuth token exchange failed (HTTP ${res.status}); check the client in ${oauthRef} exists and is not revoked`,
    );
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("OAuth response had no access_token");
  return json.access_token;
}

class TailscaleApi {
  constructor(
    private token: string,
    private tailnet: string,
  ) {}

  private async request(
    method: "GET" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${API_BASE}/tailnet/${encodeURIComponent(
      this.tailnet,
    )}/dns/${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = (await res.text()).trim();
      const hint =
        res.status === 403
          ? " — the OAuth client needs the `dns` scope (read and write)"
          : "";
      throw new Error(
        `${method} ${url} failed (HTTP ${res.status}): ${
          text || "no body"
        }${hint}`,
      );
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  splitDns(): Promise<SplitDns> {
    return this.request("GET", "split-dns") as Promise<SplitDns>;
  }

  patchSplitDns(patch: SplitDns): Promise<SplitDns> {
    return this.request("PATCH", "split-dns", patch) as Promise<SplitDns>;
  }

  async status(): Promise<DnsStatus> {
    const [prefs, ns, paths, split] = await Promise.all([
      this.request("GET", "preferences") as Promise<{ magicDNS?: boolean }>,
      this.request("GET", "nameservers") as Promise<{ dns?: string[] }>,
      this.request("GET", "searchpaths") as Promise<{ searchPaths?: string[] }>,
      this.splitDns(),
    ]);
    return {
      magicDNS: prefs.magicDNS === true,
      nameservers: ns.dns ?? [],
      searchPaths: paths.searchPaths ?? [],
      splitDns: split ?? {},
    };
  }
}

// ============================================================================
// Subcommands
// ============================================================================

async function client(args: Args): Promise<TailscaleApi> {
  log.info(`reading OAuth client from ${args.oauthRef}`);
  return new TailscaleApi(await oauthToken(args.oauthRef), args.tailnet);
}

async function cmdStatus(args: Args): Promise<number> {
  const api = await client(args);
  console.log(formatStatus(await api.status()));
  return 0;
}

function describe(plan: Plan, domain: string): string {
  const now =
    plan.current === undefined ? "unset" : plan.current.join(", ") || "(empty)";
  const want = plan.patch[domain];
  return `${domain}: ${now} -> ${want === null ? "unset" : want.join(", ")}`;
}

async function cmdApply(args: Args): Promise<number> {
  const domain = args.domain!;
  if (args.dryRun) {
    const plan = planSplitDns({}, domain, args.nameservers);
    log.dry(
      `would PATCH ${API_BASE}/tailnet/${args.tailnet}/dns/split-dns with ${JSON.stringify(
        plan.patch,
      )}`,
    );
    log.dry("no 1Password or API access in --dry-run; current state not read");
    return 0;
  }
  const api = await client(args);
  const current = await api.splitDns();
  const plan = planSplitDns(current, domain, args.nameservers);
  if (!plan.changed) {
    log.ok(`split DNS already ${describe(plan, domain)}; nothing to do`);
    return 0;
  }
  log.info(`split DNS ${describe(plan, domain)}`);
  const after = await api.patchSplitDns(plan.patch);
  const verify = planSplitDns(after, domain, args.nameservers);
  if (verify.changed) {
    throw new Error(
      `PATCH accepted but the tailnet reports ${domain} -> ${
        (after[domain] ?? []).join(", ") || "unset"
      }`,
    );
  }
  log.ok(`split DNS ${domain} -> ${args.nameservers.join(", ")}`);
  log.info(
    "devices resolve it on their next DNS config push; on a phone toggle Tailscale off/on if needed",
  );
  return 0;
}

async function cmdRemove(args: Args): Promise<number> {
  const domain = args.domain!;
  if (args.dryRun) {
    log.dry(
      `would PATCH ${API_BASE}/tailnet/${args.tailnet}/dns/split-dns with ${JSON.stringify(
        { [domain]: null },
      )}`,
    );
    return 0;
  }
  const api = await client(args);
  const plan = planRemove(await api.splitDns(), domain);
  if (!plan.changed) {
    log.ok(`split DNS has no entry for ${domain}; nothing to do`);
    return 0;
  }
  log.info(`split DNS ${describe(plan, domain)}`);
  const after = await api.patchSplitDns(plan.patch);
  if (after[domain] !== undefined && after[domain] !== null) {
    throw new Error(`PATCH accepted but ${domain} is still configured`);
  }
  log.ok(`split DNS entry for ${domain} removed`);
  return 0;
}

function printHelp(): void {
  console.log(
    `tailscale-dns.ts — split DNS for the homelab domain on the tailnet (docs/runbooks/tailscale-dns.md)

Usage:
  scripts/tailscale-dns.ts status [--oauth-ref ${DEFAULT_OAUTH_REF}] [--tailnet ${DEFAULT_TAILNET}]
  scripts/tailscale-dns.ts apply  [--domain <DOMAIN>] [--nameserver <ip>]... [--dry-run]
  scripts/tailscale-dns.ts remove [--domain <DOMAIN>] [--dry-run]

Subcommands:
  status   MagicDNS, global nameservers, search paths and split DNS of the tailnet.
  apply    Point split DNS for <domain> at <nameserver>(s). Idempotent; only that
           domain is patched. --dry-run prints the PATCH body and calls nothing.
  remove   Clear the split DNS entry for <domain> (PATCH with null).

Defaults (from ${HOMELAB_ENV_FILE}, gitignored):
  --domain      DOMAIN          --nameserver  GATEWAY_IP

Credentials:
  --oauth-ref   1Password item with fields client_id and client_secret of a Tailscale
                OAuth client that has the dns scope (read and write). Read with op read;
                never printed.

Exit codes: 0 success, 1 request failed, 2 usage error.`,
  );
}

async function readEnvDefaults(): Promise<ArgEnv> {
  let text: string;
  try {
    text = await readFile(HOMELAB_ENV_FILE, "utf8");
  } catch {
    return {};
  }
  return {
    domain: envFileValue(text, "DOMAIN") ?? undefined,
    nameserver: envFileValue(text, "GATEWAY_IP") ?? undefined,
  };
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2), await readEnvDefaults());
  } catch (err) {
    if (err instanceof UsageError) {
      log.error(err.message);
      console.error("run with --help for usage");
      return 2;
    }
    throw err;
  }
  try {
    switch (args.command) {
      case "help":
        printHelp();
        return 0;
      case "status":
        return await cmdStatus(args);
      case "apply":
        return await cmdApply(args);
      case "remove":
        return await cmdRemove(args);
    }
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
