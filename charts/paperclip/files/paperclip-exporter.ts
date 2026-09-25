/**
 * paperclip-exporter.ts
 *
 * Prometheus exporter for Paperclip agent health (docs/runbooks/paperclip-agents.md).
 * On every GET /metrics it reads the Paperclip REST API with a board API key
 * and reports, per active company: runs finished in the last RUN_WINDOW_SECONDS
 * by status and error code, agents by status, live runs, agents that report
 * `running` without a live run ("phantom"), and the latest week of
 * recovery-observability. paperclip_up is 0 when any request fails.
 *
 * Runs from a ConfigMap in the stock oven/bun image (charts/paperclip
 * templates/exporter.yaml), so it has no dependencies beyond Bun itself.
 *
 * Environment:
 *   PAPERCLIP_API_URL    e.g. http://paperclip.paperclip.svc.cluster.local:3100/api
 *   PAPERCLIP_API_KEY    board API key (Secret paperclip-exporter)
 *   RUN_WINDOW_SECONDS   window for run counts (default 3600)
 *   RUN_LIMIT            newest runs read per company (default 500, API max 1000)
 *   REQUEST_TIMEOUT_MS   per request (default 10000)
 *   PORT                 listen port (default 9464)
 */

export const TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
  "timed_out",
] as const;
const LIVE_STATUSES = new Set(["queued", "running", "scheduled_retry"]);

export interface Company {
  id: string;
  name: string;
  status: string;
}
export interface Run {
  status: string;
  finishedAt: string | null;
  errorCode: string | null;
}
export interface Agent {
  id: string;
  status: string;
}
export interface LiveRun {
  agentId: string;
  status: string;
}
export interface Recovery {
  thresholdPercent: number;
  breached: boolean;
  runs: number;
  recoveryActions: number;
  ratePercent: number;
}
export interface Summary {
  finishedByStatus: Record<string, number>;
  errorsByCode: Record<string, number>;
  agentsByStatus: Record<string, number>;
  liveRuns: number;
  phantomRunning: number;
}
export interface CompanyMetrics {
  company: Company;
  summary: Summary;
  recovery: Recovery;
}
export interface ScrapeResult {
  up: boolean;
  durationSeconds: number;
  windowSeconds: number;
  companies: CompanyMetrics[];
}
export interface ExporterConfig {
  baseUrl: string;
  apiKey: string;
  windowSeconds: number;
  runLimit: number;
  requestTimeoutMs: number;
  port: number;
}
export type Logger = (msg: string) => void;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function records(json: unknown, what: string): Json[] {
  if (!Array.isArray(json) || !json.every(isRecord)) {
    throw new Error(`${what}: expected a JSON array of objects`);
  }
  return json;
}

function requireString(record: Json, key: string, what: string): string {
  const value = str(record[key]);
  if (value === null) throw new Error(`${what}: field ${key} is not a string`);
  return value;
}

export function parseCompanies(json: unknown): Company[] {
  return records(json, "companies")
    .map((c) => ({
      id: requireString(c, "id", "companies"),
      name: str(c["name"]) ?? "",
      status: str(c["status"]) ?? "",
    }))
    .filter((c) => c.status === "active");
}

export function parseRuns(json: unknown): Run[] {
  return records(json, "heartbeat-runs").map((r) => ({
    status: requireString(r, "status", "heartbeat-runs"),
    finishedAt: str(r["finishedAt"]),
    errorCode: str(r["errorCode"]),
  }));
}

export function parseAgents(json: unknown): Agent[] {
  return records(json, "agents").map((a) => ({
    id: requireString(a, "id", "agents"),
    status: requireString(a, "status", "agents"),
  }));
}

export function parseLiveRuns(json: unknown): LiveRun[] {
  return records(json, "live-runs").map((r) => ({
    agentId: requireString(r, "agentId", "live-runs"),
    status: str(r["status"]) ?? "",
  }));
}

export function parseRecovery(json: unknown): Recovery {
  if (!isRecord(json)) {
    throw new Error("recovery-observability: expected a JSON object");
  }
  const alert = isRecord(json["alert"]) ? json["alert"] : {};
  const latest = isRecord(alert["latestWeek"]) ? alert["latestWeek"] : {};
  return {
    thresholdPercent: num(
      alert["thresholdPercent"] ?? json["thresholdPercent"],
    ),
    breached: alert["latestWeekBreached"] === true,
    runs: num(latest["runs"]),
    recoveryActions: num(latest["recoveryActions"]),
    ratePercent: num(latest["ratePercent"]),
  };
}

function countBy<T>(items: T[], key: (item: T) => string | null) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (k !== null) counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

export function summarize(
  data: { runs: Run[]; agents: Agent[]; liveRuns: LiveRun[] },
  now: number,
  windowSeconds: number,
): Summary {
  const since = now - windowSeconds * 1000;
  const finished = data.runs.filter((r) => {
    const at = r.finishedAt === null ? Number.NaN : Date.parse(r.finishedAt);
    return at >= since && at <= now;
  });
  const finishedByStatus = Object.fromEntries(
    TERMINAL_STATUSES.map((s) => [s, 0]),
  );
  for (const run of finished) {
    if (run.status in finishedByStatus) {
      finishedByStatus[run.status] = (finishedByStatus[run.status] ?? 0) + 1;
    }
  }
  const live = data.liveRuns.filter((r) => LIVE_STATUSES.has(r.status));
  const agentsWithLiveRun = new Set(live.map((r) => r.agentId));
  return {
    finishedByStatus,
    errorsByCode: countBy(finished, (r) => r.errorCode),
    agentsByStatus: countBy(data.agents, (a) => a.status),
    liveRuns: live.length,
    phantomRunning: data.agents.filter(
      (a) => a.status === "running" && !agentsWithLiveRun.has(a.id),
    ).length,
  };
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}

function labelSet(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${escapeLabel(v)}"`,
  );
  return parts.length === 0 ? "" : `{${parts.join(",")}}`;
}

interface Family {
  name: string;
  help: string;
  samples: { labels: Record<string, string>; value: number }[];
}

function family(name: string, help: string): Family {
  return { name, help, samples: [] };
}

export function renderMetrics(result: ScrapeResult): string {
  const up = family(
    "paperclip_up",
    "1 if the last read of the Paperclip API succeeded.",
  );
  up.samples.push({ labels: {}, value: result.up ? 1 : 0 });
  const duration = family(
    "paperclip_scrape_duration_seconds",
    "Time spent reading the Paperclip API.",
  );
  duration.samples.push({ labels: {}, value: result.durationSeconds });
  const window = family(
    "paperclip_agent_runs_window_seconds",
    "Window that paperclip_agent_runs_* count over.",
  );
  window.samples.push({ labels: {}, value: result.windowSeconds });

  const finished = family(
    "paperclip_agent_runs_finished",
    "Agent runs that finished inside the window, by status.",
  );
  const errors = family(
    "paperclip_agent_runs_errors",
    "Agent runs that finished inside the window with an error code.",
  );
  const live = family("paperclip_agent_runs_live", "Queued or running runs.");
  const agents = family("paperclip_agents", "Agents by status.");
  const phantom = family(
    "paperclip_agents_phantom_running",
    "Agents with status running but no live run.",
  );
  const rate = family(
    "paperclip_recovery_rate_percent",
    "Recovery actions per run in the latest week (recovery-observability).",
  );
  const threshold = family(
    "paperclip_recovery_threshold_percent",
    "Recovery rate threshold Paperclip alerts on.",
  );
  const breached = family(
    "paperclip_recovery_breached",
    "1 if Paperclip reports the latest week above its recovery threshold.",
  );
  const weekRuns = family(
    "paperclip_recovery_week_runs",
    "Runs in the latest recovery-observability week.",
  );
  const weekActions = family(
    "paperclip_recovery_week_actions",
    "Recovery actions in the latest recovery-observability week.",
  );

  for (const { company, summary, recovery } of result.companies) {
    const base = { company_id: company.id, company: company.name };
    for (const [status, value] of Object.entries(summary.finishedByStatus)) {
      finished.samples.push({ labels: { ...base, status }, value });
    }
    for (const [error_code, value] of Object.entries(summary.errorsByCode)) {
      errors.samples.push({ labels: { ...base, error_code }, value });
    }
    for (const [status, value] of Object.entries(summary.agentsByStatus)) {
      agents.samples.push({ labels: { ...base, status }, value });
    }
    live.samples.push({ labels: base, value: summary.liveRuns });
    phantom.samples.push({ labels: base, value: summary.phantomRunning });
    rate.samples.push({ labels: base, value: recovery.ratePercent });
    threshold.samples.push({ labels: base, value: recovery.thresholdPercent });
    breached.samples.push({ labels: base, value: recovery.breached ? 1 : 0 });
    weekRuns.samples.push({ labels: base, value: recovery.runs });
    weekActions.samples.push({ labels: base, value: recovery.recoveryActions });
  }

  return [
    up,
    duration,
    window,
    finished,
    errors,
    live,
    agents,
    phantom,
    rate,
    threshold,
    breached,
    weekRuns,
    weekActions,
  ]
    .filter((f) => f.samples.length > 0)
    .map((f) =>
      [
        `# HELP ${f.name} ${f.help}`,
        `# TYPE ${f.name} gauge`,
        ...f.samples.map((s) => `${f.name}${labelSet(s.labels)} ${s.value}`),
      ].join("\n"),
    )
    .join("\n")
    .concat("\n");
}

async function getJson(cfg: ExporterConfig, path: string): Promise<unknown> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`GET ${path}: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function collectCompany(
  cfg: ExporterConfig,
  company: Company,
  now: number,
): Promise<CompanyMetrics> {
  const base = `/companies/${encodeURIComponent(company.id)}`;
  const [runs, agents, liveRuns, recovery] = await Promise.all([
    getJson(cfg, `${base}/heartbeat-runs?limit=${cfg.runLimit}`),
    getJson(cfg, `${base}/agents`),
    getJson(cfg, `${base}/live-runs`),
    getJson(cfg, `${base}/recovery-observability`),
  ]);
  return {
    company,
    summary: summarize(
      {
        runs: parseRuns(runs),
        agents: parseAgents(agents),
        liveRuns: parseLiveRuns(liveRuns),
      },
      now,
      cfg.windowSeconds,
    ),
    recovery: parseRecovery(recovery),
  };
}

export async function collect(
  cfg: ExporterConfig,
  now: number = Date.now(),
  logError: Logger = (msg) => log("error", msg),
): Promise<ScrapeResult> {
  const started = performance.now();
  const done = (up: boolean, companies: CompanyMetrics[]): ScrapeResult => ({
    up,
    durationSeconds: (performance.now() - started) / 1000,
    windowSeconds: cfg.windowSeconds,
    companies,
  });
  if (cfg.apiKey === "") {
    logError(
      "PAPERCLIP_API_KEY is empty: create the paperclip-exporter 1Password item (docs/runbooks/paperclip-agents.md)",
    );
    return done(false, []);
  }
  try {
    const companies = parseCompanies(await getJson(cfg, "/companies"));
    const metrics = await Promise.all(
      companies.map((c) => collectCompany(cfg, c, now)),
    );
    return done(true, metrics);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logError(`reading the Paperclip API at ${cfg.baseUrl} failed: ${detail}`);
    return done(false, []);
  }
}

function intEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function readConfig(
  env: Record<string, string | undefined>,
): ExporterConfig {
  const baseUrl = env["PAPERCLIP_API_URL"];
  if (!baseUrl) throw new Error("PAPERCLIP_API_URL is required");
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: env["PAPERCLIP_API_KEY"] ?? "",
    windowSeconds: intEnv(env, "RUN_WINDOW_SECONDS", 3600),
    runLimit: Math.min(intEnv(env, "RUN_LIMIT", 500), 1000),
    requestTimeoutMs: intEnv(env, "REQUEST_TIMEOUT_MS", 10000),
    port: intEnv(env, "PORT", 9464),
  };
}

function log(level: "info" | "error", msg: string): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg });
  if (level === "error") console.error(line);
  else console.log(line);
}

export function startServer(cfg: ExporterConfig) {
  return Bun.serve({
    port: cfg.port,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/healthz") return new Response("ok\n");
      if (pathname !== "/metrics") {
        return new Response("not found\n", { status: 404 });
      }
      const body = renderMetrics(await collect(cfg));
      return new Response(body, {
        headers: { "content-type": "text/plain; version=0.0.4" },
      });
    },
  });
}

if (import.meta.main) {
  const cfg = readConfig(process.env);
  const server = startServer(cfg);
  log(
    "info",
    `serving /metrics on :${server.port} for ${cfg.baseUrl} (window ${cfg.windowSeconds}s)`,
  );
}
