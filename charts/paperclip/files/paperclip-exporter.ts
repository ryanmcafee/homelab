/**
 * paperclip-exporter.ts
 *
 * Prometheus exporter for Paperclip agent health (docs/runbooks/paperclip-agents.md).
 * On every GET /metrics it reads the Paperclip REST API with a board API key
 * and reports, per active company: runs finished in the last RUN_WINDOW_SECONDS
 * by status and error code, agents by status, live runs, agents that report
 * `running` without a live run ("phantom"), the latest week of
 * recovery-observability, and open issues stranded behind an unfinished wake
 * record. paperclip_up is 0 when any request fails.
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
 *   STALE_WAKE_MINUTES   a claimed wake older than this is stale (default 30)
 *   STALE_WAKE_INTERVAL_SECONDS  seconds between wake sweeps (default 300)
 *   STALE_WAKE_MAX_ISSUES        issues read per sweep (default 200)
 */

export const TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
  "timed_out",
] as const;
const LIVE_STATUSES = new Set(["queued", "running", "scheduled_retry"]);

/** Issue statuses that can still be dispatched, so a stranded one costs delivery. */
export const OPEN_ISSUE_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "backlog",
] as const;

/** Issues read concurrently during a wake sweep. */
const SWEEP_CONCURRENCY = 8;

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
  id: string | null;
  agentId: string;
  status: string;
}
export interface Issue {
  id: string;
  identifier: string;
}
export interface WakeEvent {
  kind: string;
  status: string;
  runId: string | null;
  claimedAt: string | null;
  finishedAt: string | null;
}
/**
 * One pass over the open issues of a company, cached between scrapes because it
 * costs one request per issue (there is no company-level wake endpoint).
 */
export interface WakeSweep {
  openIssues: number;
  sweptIssues: number;
  stranded: number;
  truncated: boolean;
  sweptAtMs: number;
}
export type WakeSweepCache = Map<string, WakeSweep>;
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
  wakeSweep: WakeSweep | null;
}
export interface ScrapeResult {
  up: boolean;
  durationSeconds: number;
  windowSeconds: number;
  nowMs: number;
  companies: CompanyMetrics[];
}
export interface ExporterConfig {
  baseUrl: string;
  apiKey: string;
  windowSeconds: number;
  runLimit: number;
  requestTimeoutMs: number;
  port: number;
  staleWakeMinutes: number;
  staleWakeIntervalSeconds: number;
  staleWakeMaxIssues: number;
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
    id: str(r["id"]),
    agentId: requireString(r, "agentId", "live-runs"),
    status: str(r["status"]) ?? "",
  }));
}

export function parseIssues(json: unknown): Issue[] {
  const list = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json["issues"])
      ? json["issues"]
      : json;
  return records(list, "issues").map((i) => ({
    id: requireString(i, "id", "issues"),
    identifier: str(i["identifier"]) ?? "",
  }));
}

export function parseWakeEvents(json: unknown): WakeEvent[] {
  if (!isRecord(json)) {
    throw new Error("diagnostics/wakes: expected a JSON object");
  }
  return records(json["events"] ?? [], "diagnostics/wakes").map((e) => ({
    kind: str(e["kind"]) ?? "",
    status: str(e["status"]) ?? "",
    runId: str(e["runId"]),
    claimedAt: str(e["claimedAt"]),
    finishedAt: str(e["finishedAt"]),
  }));
}

/**
 * True when a wake request was claimed by a run that is gone and never finished.
 *
 * A sandbox drop terminalizes the run row but leaves the wake record `claimed`
 * with a null `finishedAt`, and the dispatcher will not wake an issue behind an
 * outstanding claim — every later wake lands `deferred_issue_execution`. The
 * issue row still looks healthy, so this ledger read is the only signal.
 *
 * The age floor is what keeps a genuinely in-flight run from being counted; the
 * live-run check is what proves the claimant is dead rather than merely slow.
 */
export function isStrandedByWake(
  events: WakeEvent[],
  liveRunIds: Set<string>,
  now: number,
  staleMinutes: number,
): boolean {
  const floor = now - staleMinutes * 60 * 1000;
  return events.some((e) => {
    if (e.kind !== "wake_request") return false;
    if (e.status !== "claimed" || e.finishedAt !== null) return false;
    if (e.claimedAt === null || Date.parse(e.claimedAt) > floor) return false;
    return e.runId === null || !liveRunIds.has(e.runId);
  });
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
  const openIssues = family(
    "paperclip_issues_open",
    "Open issues read by the last wake sweep.",
  );
  const sweptIssues = family(
    "paperclip_issues_wake_swept",
    "Open issues actually swept, below paperclip_issues_open when capped.",
  );
  const stranded = family(
    "paperclip_issues_wake_stranded",
    "Open issues undispatchable behind a claimed wake record that never finished.",
  );
  const sweepAge = family(
    "paperclip_wake_sweep_age_seconds",
    "Age of the cached wake sweep; grows without bound if sweeps stop succeeding.",
  );

  for (const { company, summary, recovery, wakeSweep } of result.companies) {
    const base = { company_id: company.id, company: company.name };
    if (wakeSweep) {
      openIssues.samples.push({ labels: base, value: wakeSweep.openIssues });
      sweptIssues.samples.push({ labels: base, value: wakeSweep.sweptIssues });
      stranded.samples.push({ labels: base, value: wakeSweep.stranded });
      sweepAge.samples.push({
        labels: base,
        value: Math.max(0, (result.nowMs - wakeSweep.sweptAtMs) / 1000),
      });
    }
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
    openIssues,
    sweptIssues,
    stranded,
    sweepAge,
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

/** Run `worker` over `items` at most SWEEP_CONCURRENCY at a time. */
async function mapLimit<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(SWEEP_CONCURRENCY, items.length) },
    async () => {
      for (let i = next++; i < items.length; i = next++) {
        out[i] = await worker(items[i] as T);
      }
    },
  );
  await Promise.all(lanes);
  return out;
}

/**
 * Count open issues stranded behind an unfinished wake record.
 *
 * One request per open issue, so it is rate-limited by
 * STALE_WAKE_INTERVAL_SECONDS rather than run on every scrape, and capped at
 * STALE_WAKE_MAX_ISSUES so a large board cannot stall the exporter.
 */
export async function sweepWakes(
  cfg: ExporterConfig,
  company: Company,
  liveRunIds: Set<string>,
  now: number,
): Promise<WakeSweep> {
  const base = `/companies/${encodeURIComponent(company.id)}`;
  const query = `status=${OPEN_ISSUE_STATUSES.join(",")}&limit=${cfg.staleWakeMaxIssues}`;
  const issues = parseIssues(await getJson(cfg, `${base}/issues?${query}`));
  const swept = issues.slice(0, cfg.staleWakeMaxIssues);
  const flags = await mapLimit(swept, async (issue) => {
    const wakes = await getJson(
      cfg,
      `/issues/${encodeURIComponent(issue.id)}/diagnostics/wakes`,
    );
    return isStrandedByWake(
      parseWakeEvents(wakes),
      liveRunIds,
      now,
      cfg.staleWakeMinutes,
    );
  });
  return {
    openIssues: issues.length,
    sweptIssues: swept.length,
    stranded: flags.filter(Boolean).length,
    truncated: issues.length > swept.length,
    sweptAtMs: now,
  };
}

async function collectCompany(
  cfg: ExporterConfig,
  company: Company,
  now: number,
  cache: WakeSweepCache,
  logError: Logger,
): Promise<CompanyMetrics> {
  const base = `/companies/${encodeURIComponent(company.id)}`;
  const [runs, agents, liveRuns, recovery] = await Promise.all([
    getJson(cfg, `${base}/heartbeat-runs?limit=${cfg.runLimit}`),
    getJson(cfg, `${base}/agents`),
    getJson(cfg, `${base}/live-runs`),
    getJson(cfg, `${base}/recovery-observability`),
  ]);
  const parsedLiveRuns = parseLiveRuns(liveRuns);
  return {
    company,
    summary: summarize(
      {
        runs: parseRuns(runs),
        agents: parseAgents(agents),
        liveRuns: parsedLiveRuns,
      },
      now,
      cfg.windowSeconds,
    ),
    recovery: parseRecovery(recovery),
    wakeSweep: await cachedSweep(
      cfg,
      company,
      parsedLiveRuns,
      now,
      cache,
      logError,
    ),
  };
}

/**
 * Serve the cached sweep until it ages past STALE_WAKE_INTERVAL_SECONDS.
 *
 * A failed sweep keeps the previous result rather than blanking the series —
 * paperclip_wake_sweep_age_seconds is what shows the value went stale, so a
 * silently failing sweep is visible instead of looking like zero stranded.
 */
async function cachedSweep(
  cfg: ExporterConfig,
  company: Company,
  liveRuns: LiveRun[],
  now: number,
  cache: WakeSweepCache,
  logError: Logger,
): Promise<WakeSweep | null> {
  const previous = cache.get(company.id) ?? null;
  const fresh =
    previous !== null &&
    now - previous.sweptAtMs < cfg.staleWakeIntervalSeconds * 1000;
  if (fresh) return previous;
  const liveRunIds = new Set(
    liveRuns
      .filter((r) => LIVE_STATUSES.has(r.status))
      .map((r) => r.id)
      .filter((id): id is string => id !== null),
  );
  try {
    const sweep = await sweepWakes(cfg, company, liveRunIds, now);
    cache.set(company.id, sweep);
    return sweep;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logError(`wake sweep for company ${company.id} failed: ${detail}`);
    return previous;
  }
}

/** Wake sweeps outlive a single scrape; see cachedSweep. */
const defaultWakeSweepCache: WakeSweepCache = new Map();

export async function collect(
  cfg: ExporterConfig,
  now: number = Date.now(),
  logError: Logger = (msg) => log("error", msg),
  cache: WakeSweepCache = defaultWakeSweepCache,
): Promise<ScrapeResult> {
  const started = performance.now();
  const done = (up: boolean, companies: CompanyMetrics[]): ScrapeResult => ({
    up,
    durationSeconds: (performance.now() - started) / 1000,
    windowSeconds: cfg.windowSeconds,
    nowMs: now,
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
      companies.map((c) => collectCompany(cfg, c, now, cache, logError)),
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
    staleWakeMinutes: intEnv(env, "STALE_WAKE_MINUTES", 30),
    staleWakeIntervalSeconds: intEnv(env, "STALE_WAKE_INTERVAL_SECONDS", 300),
    staleWakeMaxIssues: intEnv(env, "STALE_WAKE_MAX_ISSUES", 200),
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
