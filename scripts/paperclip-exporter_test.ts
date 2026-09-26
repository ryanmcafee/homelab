#!/usr/bin/env -S bun test
/**
 * Unit tests for charts/paperclip/files/paperclip-exporter.ts. The API side is
 * a real Bun.serve stand-in for Paperclip; nothing talks to a cluster.
 *
 *   bun test scripts/paperclip-exporter_test.ts
 */

import { afterAll, beforeAll, test } from "bun:test";
import {
  collect,
  type ExporterConfig,
  isStrandedByWake,
  parseAgents,
  parseCompanies,
  parseIssues,
  parseLiveRuns,
  parseRecovery,
  parseRuns,
  parseWakeEvents,
  readConfig,
  renderMetrics,
  startServer,
  summarize,
} from "../charts/paperclip/files/paperclip-exporter.ts";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "./lib/assert.ts";

const NOW = Date.parse("2026-09-25T04:00:00Z");
const HOUR = 3600;
const ACTIVE = "11111111-1111-1111-1111-111111111111";
const ARCHIVED = "22222222-2222-2222-2222-222222222222";
const API_KEY = "test-board-key";

function run(
  status: string,
  finishedAt: string | null,
  errorCode: string | null = null,
) {
  return { id: crypto.randomUUID(), status, finishedAt, errorCode };
}

const RUNS = [
  run("succeeded", "2026-09-25T03:50:00Z"),
  run("succeeded", "2026-09-25T03:40:00Z"),
  run("failed", "2026-09-25T03:30:00Z", "process_lost"),
  run("interrupted", "2026-09-25T03:20:00Z", "orphaned_running_run"),
  run("interrupted", "2026-09-25T03:10:00Z", "orphaned_running_run"),
  run("cancelled", "2026-09-25T03:05:00Z", "cancelled"),
  run("running", null),
  run("failed", "2026-09-25T02:30:00Z", "acpx_turn_failed"),
];

const AGENTS = [
  { id: "a1", status: "running" },
  { id: "a2", status: "running" },
  { id: "a3", status: "idle" },
];

const LIVE_RUNS = [{ id: "live-run-1", agentId: "a1", status: "running" }];

const OPEN_ISSUES = [
  { id: "i-clean", identifier: "ACME-1" },
  { id: "i-stranded", identifier: "ACME-2" },
  { id: "i-live", identifier: "ACME-3" },
];

function wake(
  status: string,
  runId: string | null,
  claimedAt: string | null,
  finishedAt: string | null,
) {
  return {
    kind: "wake_request",
    reason: "issue_assigned",
    status,
    runId,
    claimedAt,
    finishedAt,
  };
}

// i-clean: every claim finished. i-stranded: claimed 20h ago by a run that is
// gone. i-live: claimed 2min ago by a run that is still in LIVE_RUNS.
const WAKES: Record<string, { events: unknown[] }> = {
  "i-clean": {
    events: [
      wake(
        "finished",
        "dead-run",
        "2026-09-24T08:00:00Z",
        "2026-09-24T08:05:00Z",
      ),
    ],
  },
  "i-stranded": {
    events: [wake("claimed", "dead-run", "2026-09-24T08:00:00Z", null)],
  },
  "i-live": {
    events: [wake("claimed", "live-run-1", "2026-09-25T03:58:00Z", null)],
  },
};

const RECOVERY = {
  thresholdPercent: 2,
  alert: {
    thresholdPercent: 2,
    latestWeek: {
      weekStart: "2026-09-21",
      runs: 50,
      recoveryActions: 29,
      ratePercent: 58,
    },
    latestWeekBreached: true,
  },
};

const COMPANIES = [
  { id: ACTIVE, name: 'Acme "Labs"', status: "active" },
  { id: ARCHIVED, name: "Old", status: "archived" },
];

let server: ReturnType<typeof Bun.serve>;
const seenPaths: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seenPaths.push(url.pathname + url.search);
      if (req.headers.get("authorization") !== `Bearer ${API_KEY}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const routes: Record<string, unknown> = {
        "/api/companies": COMPANIES,
        [`/api/companies/${ACTIVE}/heartbeat-runs`]: RUNS,
        [`/api/companies/${ACTIVE}/agents`]: AGENTS,
        [`/api/companies/${ACTIVE}/live-runs`]: LIVE_RUNS,
        [`/api/companies/${ACTIVE}/recovery-observability`]: RECOVERY,
        [`/api/companies/${ACTIVE}/issues`]: OPEN_ISSUES,
      };
      const wakeMatch = url.pathname.match(
        /^\/api\/issues\/([^/]+)\/diagnostics\/wakes$/,
      );
      if (wakeMatch) {
        const found = WAKES[wakeMatch[1] as string];
        return found === undefined
          ? Response.json({ error: "not found" }, { status: 404 })
          : Response.json(found);
      }
      const body = routes[url.pathname];
      return body === undefined
        ? Response.json({ error: "not found" }, { status: 404 })
        : Response.json(body);
    },
  });
});

afterAll(() => {
  server.stop(true);
});

function config(overrides: Partial<ExporterConfig> = {}): ExporterConfig {
  return {
    baseUrl: `http://localhost:${server.port}/api`,
    apiKey: API_KEY,
    windowSeconds: HOUR,
    runLimit: 500,
    requestTimeoutMs: 2000,
    port: 0,
    staleWakeMinutes: 30,
    staleWakeIntervalSeconds: 300,
    staleWakeMaxIssues: 200,
    ...overrides,
  };
}

test("parseCompanies keeps only active companies", () => {
  assertEquals(parseCompanies(COMPANIES), [
    { id: ACTIVE, name: 'Acme "Labs"', status: "active" },
  ]);
});

test("parse functions reject payloads that are not arrays of objects", () => {
  assertThrows(() => parseRuns({ runs: [] }), Error, "heartbeat-runs");
  assertThrows(() => parseAgents([{ id: 1 }]), Error, "agents");
  assertThrows(() => parseLiveRuns("nope"), Error, "live-runs");
  assertThrows(() => parseCompanies(null), Error, "companies");
});

test("parseRecovery reads the latest week and the breached flag", () => {
  assertEquals(parseRecovery(RECOVERY), {
    thresholdPercent: 2,
    breached: true,
    runs: 50,
    recoveryActions: 29,
    ratePercent: 58,
  });
});

test("parseRecovery treats a missing latest week as zero runs", () => {
  assertEquals(parseRecovery({ thresholdPercent: 2, alert: {} }), {
    thresholdPercent: 2,
    breached: false,
    runs: 0,
    recoveryActions: 0,
    ratePercent: 0,
  });
});

test("summarize counts runs finished inside the window by status and error code", () => {
  const summary = summarize(
    {
      runs: parseRuns(RUNS),
      agents: parseAgents(AGENTS),
      liveRuns: parseLiveRuns(LIVE_RUNS),
    },
    NOW,
    HOUR,
  );
  assertEquals(summary.finishedByStatus, {
    succeeded: 2,
    failed: 1,
    interrupted: 2,
    cancelled: 1,
    timed_out: 0,
  });
  assertEquals(summary.errorsByCode, {
    process_lost: 1,
    orphaned_running_run: 2,
    cancelled: 1,
  });
});

test("summarize counts agents by status and running agents without a live run as phantom", () => {
  const summary = summarize(
    {
      runs: [],
      agents: parseAgents(AGENTS),
      liveRuns: parseLiveRuns(LIVE_RUNS),
    },
    NOW,
    HOUR,
  );
  assertEquals(summary.agentsByStatus, { running: 2, idle: 1 });
  assertEquals(summary.liveRuns, 1);
  assertEquals(summary.phantomRunning, 1);
});

test("renderMetrics escapes label values and emits a zero for every terminal status", () => {
  const text = renderMetrics({
    up: true,
    durationSeconds: 0.25,
    windowSeconds: HOUR,
    nowMs: NOW,
    companies: [
      {
        company: { id: ACTIVE, name: 'Acme "Labs"', status: "active" },
        summary: {
          finishedByStatus: {
            succeeded: 0,
            failed: 0,
            interrupted: 0,
            cancelled: 0,
            timed_out: 0,
          },
          errorsByCode: {},
          agentsByStatus: {},
          liveRuns: 0,
          phantomRunning: 0,
        },
        recovery: {
          thresholdPercent: 2,
          breached: false,
          runs: 0,
          recoveryActions: 0,
          ratePercent: 0,
        },
        wakeSweep: {
          openIssues: 65,
          sweptIssues: 65,
          stranded: 10,
          truncated: false,
          sweptAtMs: NOW - 120_000,
        },
      },
    ],
  });
  const labels = `company_id="${ACTIVE}",company="Acme \\"Labs\\""`;
  assertStringIncludes(text, "# TYPE paperclip_up gauge\npaperclip_up 1\n");
  assertStringIncludes(
    text,
    `paperclip_agent_runs_finished{${labels},status="timed_out"} 0\n`,
  );
  assertStringIncludes(text, `paperclip_recovery_breached{${labels}} 0\n`);
  assertStringIncludes(text, "paperclip_agent_runs_window_seconds 3600\n");
  assertStringIncludes(text, `paperclip_issues_wake_stranded{${labels}} 10\n`);
  assertStringIncludes(text, `paperclip_issues_open{${labels}} 65\n`);
  assertStringIncludes(
    text,
    `paperclip_wake_sweep_age_seconds{${labels}} 120\n`,
  );
});

test("renderMetrics reports only paperclip_up 0 when the scrape failed", () => {
  const text = renderMetrics({
    up: false,
    durationSeconds: 1,
    windowSeconds: HOUR,
    nowMs: NOW,
    companies: [],
  });
  assertStringIncludes(text, "paperclip_up 0\n");
  assert(!text.includes("paperclip_agent_runs_finished"));
  // No sweep means no series at all, so the alert cannot read a missing sweep
  // as zero stranded issues.
  assert(!text.includes("paperclip_issues_wake_stranded"));
});

test("collect reads every endpoint of each active company with the bearer key", async () => {
  seenPaths.length = 0;
  const result = await collect(config(), NOW);
  assert(result.up, "expected a successful scrape");
  assertEquals(result.companies.length, 1);
  const [company] = result.companies;
  assertEquals(company?.summary.phantomRunning, 1);
  assertEquals(company?.recovery.breached, true);
  assert(
    seenPaths.includes(`/api/companies/${ACTIVE}/heartbeat-runs?limit=500`),
    `heartbeat-runs not requested with the limit: ${seenPaths.join(", ")}`,
  );
  assert(!seenPaths.some((p) => p.includes(ARCHIVED)));
});

test("collect reports up=false and names the endpoint when the key is rejected", async () => {
  const errors: string[] = [];
  const result = await collect(config({ apiKey: "wrong" }), NOW, (msg) =>
    errors.push(msg),
  );
  assertEquals(result.up, false);
  assertStringIncludes(errors.join("\n"), "/companies");
  assertStringIncludes(errors.join("\n"), "401");
});

test("collect reports up=false without calling the API when no key is set", async () => {
  seenPaths.length = 0;
  const errors: string[] = [];
  const result = await collect(config({ apiKey: "" }), NOW, (msg) =>
    errors.push(msg),
  );
  assertEquals(result.up, false);
  assertEquals(seenPaths, []);
  assertStringIncludes(errors.join("\n"), "PAPERCLIP_API_KEY");
});

test("readConfig applies defaults and rejects a non-numeric window", () => {
  const cfg = readConfig({
    PAPERCLIP_API_URL: "http://paperclip:3100/api/",
    PAPERCLIP_API_KEY: "k",
  });
  assertEquals(cfg.baseUrl, "http://paperclip:3100/api");
  assertEquals(cfg.windowSeconds, HOUR);
  assertEquals(cfg.port, 9464);
  assertThrows(
    () =>
      readConfig({
        PAPERCLIP_API_URL: "http://x/api",
        RUN_WINDOW_SECONDS: "soon",
      }),
    Error,
    "RUN_WINDOW_SECONDS",
  );
  assertThrows(() => readConfig({}), Error, "PAPERCLIP_API_URL");
});

test("startServer serves /metrics and /healthz", async () => {
  const exporter = startServer(config());
  try {
    const base = `http://localhost:${exporter.port}`;
    const health = await fetch(`${base}/healthz`);
    assertEquals(health.status, 200);
    const metrics = await fetch(`${base}/metrics`);
    assertEquals(metrics.status, 200);
    assertStringIncludes(
      metrics.headers.get("content-type") ?? "",
      "text/plain",
    );
    assertStringIncludes(await metrics.text(), "paperclip_up 1\n");
    assertEquals((await fetch(`${base}/other`)).status, 404);
  } finally {
    exporter.stop(true);
  }
});

test("isStrandedByWake flags a dead claimant but not a finished or live one", () => {
  const live = new Set(["live-run-1"]);
  const claimed = (runId: string, claimedAt: string) => [
    {
      kind: "wake_request",
      status: "claimed",
      runId,
      claimedAt,
      finishedAt: null,
    },
  ];
  // Claimed 20h ago by a run that is not live: the ledger record leaked.
  assert(
    isStrandedByWake(
      claimed("dead-run", "2026-09-24T08:00:00Z"),
      live,
      NOW,
      30,
    ),
    "a claim held by a dead run should be stranded",
  );
  // Same age, but the claimant is still running: a long run, not a leak.
  assertEquals(
    isStrandedByWake(
      claimed("live-run-1", "2026-09-24T08:00:00Z"),
      live,
      NOW,
      30,
    ),
    false,
  );
  // Dead claimant, but only 2min old: inside the age floor, so not yet stale.
  assertEquals(
    isStrandedByWake(
      claimed("dead-run", "2026-09-25T03:58:00Z"),
      live,
      NOW,
      30,
    ),
    false,
  );
  // A claim that finished is the healthy case.
  assertEquals(
    isStrandedByWake(
      [
        {
          kind: "wake_request",
          status: "claimed",
          runId: "dead-run",
          claimedAt: "2026-09-24T08:00:00Z",
          finishedAt: "2026-09-24T08:05:00Z",
        },
      ],
      live,
      NOW,
      30,
    ),
    false,
  );
});

test("parseIssues accepts a bare array and an {issues} envelope", () => {
  assertEquals(parseIssues([{ id: "a", identifier: "X-1" }]).length, 1);
  assertEquals(
    parseIssues({ issues: [{ id: "a", identifier: "X-1" }] })[0]?.id,
    "a",
  );
  assertThrows(() => parseIssues({ nope: 1 }), Error, "issues");
});

test("parseWakeEvents reads events and tolerates an empty ledger", () => {
  assertEquals(parseWakeEvents({ events: [] }), []);
  const [event] = parseWakeEvents({
    events: [
      {
        kind: "wake_request",
        status: "claimed",
        runId: "r",
        claimedAt: "2026-09-24T08:00:00Z",
        finishedAt: null,
      },
    ],
  });
  assertEquals(event?.status, "claimed");
  assertEquals(event?.finishedAt, null);
  assertThrows(() => parseWakeEvents([]), Error, "diagnostics/wakes");
});

test("collect counts stranded issues and exposes them as metrics", async () => {
  const result = await collect(config(), NOW, () => {}, new Map());
  const sweep = result.companies[0]?.wakeSweep;
  assertEquals(sweep?.openIssues, 3);
  assertEquals(sweep?.sweptIssues, 3);
  // Only i-stranded: i-clean finished, i-live is held by a live run.
  assertEquals(sweep?.stranded, 1);
  assertEquals(sweep?.truncated, false);
  const text = renderMetrics(result);
  assertStringIncludes(text, "paperclip_issues_wake_stranded{company_id=");
  assertStringIncludes(text, "} 1\n");
  assertStringIncludes(text, "paperclip_issues_open");
  assertStringIncludes(text, "paperclip_wake_sweep_age_seconds");
});

test("collect reuses the cached sweep until the interval elapses", async () => {
  const cache = new Map();
  const wakePaths = () =>
    seenPaths.filter((p) => p.includes("/diagnostics/wakes")).length;
  seenPaths.length = 0;
  await collect(config(), NOW, () => {}, cache);
  const first = wakePaths();
  assert(first > 0, "the first scrape should sweep");
  // Second scrape one minute later, well inside the 300s interval.
  await collect(config(), NOW + 60_000, () => {}, cache);
  assertEquals(wakePaths(), first);
  // Past the interval it sweeps again.
  await collect(config(), NOW + 400_000, () => {}, cache);
  assert(wakePaths() > first, "the sweep should re-run after the interval");
});

test("collect caps the sweep and reports it as truncated", async () => {
  const result = await collect(
    config({ staleWakeMaxIssues: 2 }),
    NOW,
    () => {},
    new Map(),
  );
  const sweep = result.companies[0]?.wakeSweep;
  assertEquals(sweep?.sweptIssues, 2);
  assertEquals(sweep?.truncated, true);
  assertEquals(sweep?.openIssues, 3);
});

test("a failed sweep keeps the previous count instead of reporting zero", async () => {
  const cache = new Map();
  await collect(config(), NOW, () => {}, cache);
  assertEquals(cache.get(ACTIVE)?.stranded, 1);
  const errors: string[] = [];
  // Re-sweep past the interval against an API that now rejects the key, so the
  // sweep throws while the cached result is still present.
  const result = await collect(
    config({ apiKey: "wrong" }),
    NOW + 400_000,
    (msg) => errors.push(msg),
    cache,
  );
  // The whole scrape is down, but the cached sweep survived for the next one.
  assertEquals(result.up, false);
  assertEquals(cache.get(ACTIVE)?.stranded, 1);
  assertEquals(cache.get(ACTIVE)?.sweptAtMs, NOW);
});

test("readConfig applies the stale-wake defaults", () => {
  const cfg = readConfig({
    PAPERCLIP_API_URL: "http://paperclip:3100/api",
    PAPERCLIP_API_KEY: "k",
  });
  assertEquals(cfg.staleWakeMinutes, 30);
  assertEquals(cfg.staleWakeIntervalSeconds, 300);
  assertEquals(cfg.staleWakeMaxIssues, 200);
  assertThrows(
    () =>
      readConfig({
        PAPERCLIP_API_URL: "http://x/api",
        STALE_WAKE_MINUTES: "never",
      }),
    Error,
    "STALE_WAKE_MINUTES",
  );
});
