#!/usr/bin/env bun

/**
 * unifi-setting.ts
 *
 * Reads or writes one UniFi Network site setting (e.g. netflow) through the
 * controller API of a UniFi OS console, for settings the ubiquiti-community/unifi
 * Terraform provider does not model. The unifi-gateway Terragrunt unit calls
 * `apply netflow` from a local-exec provisioner (docs/logging.md, "UniFi gateway").
 *
 * Subcommands:
 *   get <key>                 Print the setting as JSON.
 *   apply <key> --data <json> Merge the JSON object's fields over the current
 *                             setting and PUT it. Idempotent: no write when every
 *                             field already matches; the result is read back.
 *                             --dry-run prints the planned changes without writing.
 *
 * Credentials come from the environment, as for the Terraform provider
 * (`op run --env-file .env.op`): UNIFI_API (console URL), UNIFI_USERNAME,
 * UNIFI_PASSWORD and UNIFI_SITE (default "default"). Nothing secret is printed.
 *
 * Usage:
 *   op run --env-file=.env.op -- bun scripts/unifi-setting.ts get netflow --insecure
 *   bun scripts/unifi-setting.ts --help
 *
 * Exit codes: 0 = success; 1 = a request failed; 2 = argument error.
 */

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
  error: (msg: string) => console.error(`${red("ERROR")} ${msg}`),
  dry: (msg: string) => console.log(`${yellow("DRY")}   ${msg}`),
};

// ============================================================================
// Pure helpers (unit-tested in unifi-setting_test.ts)
// ============================================================================

/** Raised for invalid invocations; main maps it to exit code 2. */
export class UsageError extends Error {}

export type Command = "help" | "get" | "apply";

export type Setting = Record<string, unknown>;

export interface Args {
  command: Command;
  key: string;
  site: string;
  insecure: boolean;
  dryRun: boolean;
  data: Setting;
}

const SETTING_KEY = /^[a-z][a-z0-9_]*$/;
const VALUE_FLAGS = new Set(["--site", "--data"]);

function parseObject(text: string): Setting {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`--data must be a JSON object, got ${text}`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): Args {
  const args: Args = {
    command: "help",
    key: "",
    site: env.UNIFI_SITE || "default",
    insecure: false,
    dryRun: false,
    data: {},
  };
  const positional: string[] = [];
  let data: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") return { ...args, command: "help" };
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--insecure") {
      args.insecure = true;
      continue;
    }
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (VALUE_FLAGS.has(arg)) {
      value ??= argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      if (arg === "--site") args.site = value;
      else data = value;
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`unknown flag ${arg}`);
    positional.push(arg);
  }

  const [command, key, ...rest] = positional;
  if (command === undefined) return args;
  if (command !== "get" && command !== "apply") {
    throw new UsageError(
      `unknown subcommand ${JSON.stringify(command)} (get, apply)`,
    );
  }
  if (key === undefined || !SETTING_KEY.test(key)) {
    throw new UsageError(
      `${command} needs a setting key such as netflow, got ${JSON.stringify(key)}`,
    );
  }
  if (rest.length > 0) {
    throw new UsageError(`unexpected argument ${JSON.stringify(rest[0])}`);
  }
  if (command === "apply") {
    if (data === undefined) throw new UsageError("apply needs --data <json>");
    args.data = parseObject(data);
  }
  return { ...args, command, key };
}

export interface Plan {
  changed: boolean;
  /** One "field: current -> desired" line per differing field. */
  changes: string[];
  /** The current setting with the desired fields merged over it. */
  body: Setting;
}

const show = (v: unknown) => (v === undefined ? "unset" : JSON.stringify(v));

export function planSetting(current: Setting, desired: Setting): Plan {
  const changes = Object.entries(desired)
    .filter(
      ([field, want]) =>
        JSON.stringify(current[field]) !== JSON.stringify(want),
    )
    .map(([field, want]) =>
      `${field}: ${show(current[field])} -> ${show(want)}`.replaceAll('"', ""),
    );
  return {
    changed: changes.length > 0,
    changes,
    body: { ...current, ...desired },
  };
}

export function settingPath(
  verb: "get" | "set",
  site: string,
  key: string,
): string {
  return `/proxy/network/api/s/${encodeURIComponent(site)}/${verb}/setting/${key}`;
}

// ============================================================================
// UniFi OS controller API
// ============================================================================

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set; run through \`op run --env-file=.env.op --\` (see .env.op)`,
    );
  }
  return value;
}

class UnifiApi {
  private constructor(
    private base: string,
    private insecure: boolean,
    private headers: Record<string, string>,
  ) {}

  static async login(insecure: boolean): Promise<UnifiApi> {
    const base = requiredEnv("UNIFI_API").replace(/\/+$/, "");
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      tls: { rejectUnauthorized: !insecure },
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: requiredEnv("UNIFI_USERNAME"),
        password: requiredEnv("UNIFI_PASSWORD"),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `login to ${base} failed (HTTP ${res.status}); check UNIFI_USERNAME/UNIFI_PASSWORD and that UNIFI_API is a UniFi OS console`,
      );
    }
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const csrf = res.headers.get("x-csrf-token") ?? "";
    return new UnifiApi(base, insecure, { cookie, "x-csrf-token": csrf });
  }

  private async request(
    method: "GET" | "PUT",
    path: string,
    body?: Setting,
  ): Promise<Setting> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      tls: { rejectUnauthorized: !this.insecure },
      headers: {
        ...this.headers,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `${method} ${path} failed (HTTP ${res.status}): ${text.trim() || "no body"}`,
      );
    }
    const json: { data?: Setting[] } = JSON.parse(text);
    const [setting] = json.data ?? [];
    if (!setting) throw new Error(`${method} ${path} returned no setting`);
    return setting;
  }

  get(site: string, key: string): Promise<Setting> {
    return this.request("GET", settingPath("get", site, key));
  }

  set(site: string, key: string, body: Setting): Promise<Setting> {
    return this.request("PUT", settingPath("set", site, key), body);
  }
}

// ============================================================================
// Subcommands
// ============================================================================

async function cmdGet(args: Args): Promise<number> {
  const api = await UnifiApi.login(args.insecure);
  console.log(JSON.stringify(await api.get(args.site, args.key), null, 2));
  return 0;
}

async function cmdApply(args: Args): Promise<number> {
  const api = await UnifiApi.login(args.insecure);
  const plan = planSetting(await api.get(args.site, args.key), args.data);
  if (!plan.changed) {
    log.ok(`${args.key} already matches; nothing to do`);
    return 0;
  }
  for (const change of plan.changes) {
    (args.dryRun ? log.dry : log.info)(`${args.key} ${change}`);
  }
  if (args.dryRun) return 0;
  const after = await api.set(args.site, args.key, plan.body);
  const verify = planSetting(after, args.data);
  if (verify.changed) {
    throw new Error(
      `PUT accepted but ${args.key} still differs: ${verify.changes.join(", ")}`,
    );
  }
  log.ok(`${args.key} updated on site ${args.site}`);
  return 0;
}

function printHelp(): void {
  console.log(
    `unifi-setting.ts -- read or write a UniFi Network site setting (docs/logging.md)

Usage:
  scripts/unifi-setting.ts get <key> [--site <site>] [--insecure]
  scripts/unifi-setting.ts apply <key> --data <json> [--site <site>] [--insecure] [--dry-run]

Subcommands:
  get      Print the setting (e.g. netflow, rsyslogd) as JSON.
  apply    Merge the fields of <json> over the current setting and write it. Idempotent;
           --dry-run prints the changes and writes nothing.

Flags:
  --site      UniFi site name (default: UNIFI_SITE, else "default")
  --insecure  Accept the console's self-signed TLS certificate

Environment: UNIFI_API, UNIFI_USERNAME, UNIFI_PASSWORD, UNIFI_SITE (op run --env-file=.env.op).

Exit codes: 0 success, 1 request failed, 2 usage error.`,
  );
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
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
      case "get":
        return await cmdGet(args);
      case "apply":
        return await cmdApply(args);
    }
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
