/**
 * paperclip-agent-policy.ts
 *
 * Enforces the per-agent run cap (runtimeConfig.heartbeat.maxConcurrentRuns) on
 * every agent of every active company. Paperclip keeps the cap in its database
 * and defaults new agents to 20, so a CronJob (charts/paperclip
 * templates/agent-policy.yaml) re-applies it and catches agents created since.
 * Other runtimeConfig keys are sent back unchanged: PATCH replaces the object.
 *
 * Runs from a ConfigMap in the stock oven/bun image, no dependencies.
 *
 * Environment:
 *   PAPERCLIP_API_URL    e.g. http://paperclip.paperclip.svc.cluster.local:3100/api
 *   PAPERCLIP_API_KEY    board API key (Secret paperclip-exporter)
 *   MAX_CONCURRENT_RUNS  cap per agent, 1-50 (default 1)
 *   DRY_RUN              "true" logs the changes without applying them
 *   REQUEST_TIMEOUT_MS   per request (default 10000)
 */

export interface Agent {
  id: string;
  name: string;
  status: string;
  runtimeConfig: Json | null;
}
export interface PolicyConfig {
  baseUrl: string;
  apiKey: string;
  maxConcurrentRuns: number;
  requestTimeoutMs: number;
  dryRun: boolean;
}
export interface PolicyResult {
  checked: number;
  updated: number;
  failed: number;
}
export type Logger = (msg: string) => void;

type Json = Record<string, unknown>;

const PAPERCLIP_MAX_CONCURRENT_RUNS = 50;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Json, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${what}: field ${key} is not a string`);
  }
  return value;
}

function records(json: unknown, what: string): Json[] {
  if (!Array.isArray(json) || !json.every(isRecord)) {
    throw new Error(`${what}: expected a JSON array of objects`);
  }
  return json;
}

export function parseAgents(json: unknown): Agent[] {
  return records(json, "agents").map((a) => ({
    id: requireString(a, "id", "agents"),
    name: typeof a["name"] === "string" ? a["name"] : "",
    status: requireString(a, "status", "agents"),
    runtimeConfig: isRecord(a["runtimeConfig"]) ? a["runtimeConfig"] : null,
  }));
}

export function plannedRuntimeConfig(
  runtimeConfig: Json | null,
  maxConcurrentRuns: number,
): Json | null {
  const current = runtimeConfig ?? {};
  const heartbeat = isRecord(current["heartbeat"]) ? current["heartbeat"] : {};
  if (heartbeat["maxConcurrentRuns"] === maxConcurrentRuns) return null;
  return { ...current, heartbeat: { ...heartbeat, maxConcurrentRuns } };
}

async function request(
  cfg: PolicyConfig,
  method: "GET" | "PATCH",
  path: string,
  body?: Json,
): Promise<unknown> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path}: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function applyAgent(
  cfg: PolicyConfig,
  agent: Agent,
  runtimeConfig: Json,
  log: Logger,
): Promise<boolean> {
  const label = `agent ${agent.id} (${agent.name})`;
  if (cfg.dryRun) {
    log(
      `dry-run: would set maxConcurrentRuns=${cfg.maxConcurrentRuns} on ${label}`,
    );
    return true;
  }
  try {
    await request(cfg, "PATCH", `/agents/${encodeURIComponent(agent.id)}`, {
      runtimeConfig,
    });
    log(`set maxConcurrentRuns=${cfg.maxConcurrentRuns} on ${label}`);
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`updating ${label} failed: ${detail}`);
    return false;
  }
}

export async function enforce(
  cfg: PolicyConfig,
  log: Logger,
): Promise<PolicyResult> {
  if (cfg.apiKey === "") {
    throw new Error(
      "PAPERCLIP_API_KEY is empty: create the paperclip-exporter 1Password item (docs/runbooks/paperclip-agents.md)",
    );
  }
  const companies = records(
    await request(cfg, "GET", "/companies"),
    "companies",
  )
    .filter((c) => c["status"] === "active")
    .map((c) => requireString(c, "id", "companies"));
  const agents = (
    await Promise.all(
      companies.map(async (id) =>
        parseAgents(
          await request(
            cfg,
            "GET",
            `/companies/${encodeURIComponent(id)}/agents`,
          ),
        ),
      ),
    )
  )
    .flat()
    .filter((a) => a.status !== "terminated");

  const outcomes = await Promise.all(
    agents.flatMap((agent) => {
      const planned = plannedRuntimeConfig(
        agent.runtimeConfig,
        cfg.maxConcurrentRuns,
      );
      return planned === null ? [] : [applyAgent(cfg, agent, planned, log)];
    }),
  );
  return {
    checked: agents.length,
    updated: outcomes.filter(Boolean).length,
    failed: outcomes.filter((ok) => !ok).length,
  };
}

function intEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${key} must be an integer from 1 to ${max}, got "${raw}"`);
  }
  return value;
}

export function readConfig(
  env: Record<string, string | undefined>,
): PolicyConfig {
  const baseUrl = env["PAPERCLIP_API_URL"];
  if (!baseUrl) throw new Error("PAPERCLIP_API_URL is required");
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: env["PAPERCLIP_API_KEY"] ?? "",
    maxConcurrentRuns: intEnv(
      env,
      "MAX_CONCURRENT_RUNS",
      1,
      PAPERCLIP_MAX_CONCURRENT_RUNS,
    ),
    requestTimeoutMs: intEnv(env, "REQUEST_TIMEOUT_MS", 10000),
    dryRun: env["DRY_RUN"] === "true",
  };
}

function log(level: "info" | "error", msg: string): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg });
  if (level === "error") console.error(line);
  else console.log(line);
}

async function main(): Promise<number> {
  try {
    const cfg = readConfig(process.env);
    const result = await enforce(cfg, (msg) => log("info", msg));
    log(
      result.failed > 0 ? "error" : "info",
      `checked ${result.checked} agents, updated ${result.updated}, failed ${result.failed}`,
    );
    return result.failed > 0 ? 1 : 0;
  } catch (err) {
    log("error", err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
