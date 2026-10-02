import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { readIntakeConfig } from "../../src/intake/config.ts";
import {
  createJanitor,
  type JanitorPolicy,
  planCleanup,
  type VolumeUsage,
  type WorkflowState,
} from "../../src/intake/janitor.ts";
import type { WorkflowClient } from "../../src/intake/kube.ts";
import { tempRoot } from "./helpers.ts";

const { root, cleanup } = tempRoot("janitor-");
afterAll(cleanup);

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-25T12:00:00Z");
const policy: JanitorPolicy = {
  failedRetentionMs: 24 * HOUR,
  orphanGraceMs: HOUR,
  highWatermark: 0.8,
};

const states = (
  entries: Record<string, WorkflowState>,
): ReadonlyMap<string, WorkflowState> => new Map(Object.entries(entries));

const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("planCleanup", () => {
  const workflows = states({
    running: { phase: "Running" },
    pending: { phase: "Pending" },
    unstarted: { phase: "" },
    done: { phase: "Succeeded", finishedAt: ago(60_000) },
    "failed-old": { phase: "Failed", finishedAt: ago(25 * HOUR) },
    "failed-new": { phase: "Failed", finishedAt: ago(HOUR) },
    "error-old": { phase: "Error", finishedAt: ago(30 * HOUR) },
  });
  const entry = (name: string, age = 2 * HOUR) => ({
    name,
    mtimeMs: NOW - age,
  });
  const entries = [
    entry("running"),
    entry("pending"),
    entry("unstarted"),
    entry("done"),
    entry("failed-old"),
    entry("failed-new"),
    entry("error-old"),
    entry("gone-old"),
    entry("gone-young", 10 * 60_000),
  ];

  test("removes succeeded, expired failed and stale orphaned workspaces", () => {
    expect(planCleanup(entries, workflows, NOW, policy, false)).toEqual([
      { name: "done", reason: "succeeded" },
      { name: "failed-old", reason: "failed" },
      { name: "error-old", reason: "failed" },
      { name: "gone-old", reason: "orphaned" },
    ]);
  });

  test("under disk pressure also removes failed workspaces still retained", () => {
    const plan = planCleanup(entries, workflows, NOW, policy, true);
    expect(plan).toContainEqual({ name: "failed-new", reason: "pressure" });
    const names = plan.map((p) => p.name);
    expect(names).not.toContain("running");
    expect(names).not.toContain("pending");
    expect(names).not.toContain("unstarted");
    expect(names).not.toContain("gone-young");
  });

  test("falls back to the directory age when a failed workflow has no finishedAt", () => {
    const plan = planCleanup(
      [entry("f", 25 * HOUR)],
      states({ f: { phase: "Failed" } }),
      NOW,
      policy,
      false,
    );
    expect(plan).toEqual([{ name: "f", reason: "failed" }]);
  });
});

interface Fixture {
  workspace: string;
  cache: string;
}

function fixture(name: string): Fixture {
  const workspace = join(root, name, "workspaces");
  const cache = join(root, name, "cache");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(cache, { recursive: true });
  return { workspace, cache };
}

function workspaceDir(dir: string, name: string, ageMs: number): string {
  const path = join(dir, name);
  mkdirSync(join(path, "repo"), { recursive: true });
  writeFileSync(join(path, "repo", "README.md"), "x");
  const at = (NOW - ageMs) / 1000;
  utimesSync(path, at, at);
  return path;
}

function listClient(
  items: Record<string, WorkflowState> | Error,
): WorkflowClient {
  return {
    create: async () => "x",
    listActive: async () => [],
    listStates: async () => {
      if (items instanceof Error) throw items;
      return new Map(Object.entries(items));
    },
  };
}

const usage =
  (ratios: Record<string, number>) =>
  async (path: string): Promise<VolumeUsage> => {
    const ratio = Object.entries(ratios).find(([k]) => path.endsWith(k))?.[1];
    return { capacityBytes: 100, usedBytes: Math.round((ratio ?? 0) * 100) };
  };

const silent = pino({ level: "silent" });

describe("createJanitor", () => {
  test("removes finished workspaces, keeps active ones and reports metrics", async () => {
    const f = fixture("basic");
    const done = workspaceDir(f.workspace, "wf-done", 2 * HOUR);
    const running = workspaceDir(f.workspace, "wf-running", 2 * HOUR);
    const orphan = workspaceDir(f.workspace, "wf-orphan", 2 * HOUR);
    writeFileSync(join(f.workspace, "stray-file"), "not a directory");
    const janitor = createJanitor({
      workspaceRoot: f.workspace,
      cacheRoot: f.cache,
      cachePruneDirs: ["go/build"],
      namespace: "triage-agent",
      policy,
      client: listClient({
        "wf-done": { phase: "Succeeded", finishedAt: ago(HOUR) },
        "wf-running": { phase: "Running" },
      }),
      usage: usage({ workspaces: 0.3, cache: 0.1 }),
      logger: silent,
      now: () => NOW,
    });

    await janitor.run();

    expect(existsSync(done)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(running)).toBe(true);
    expect(existsSync(join(f.workspace, "stray-file"))).toBe(true);
    const text = janitor.render();
    expect(text).toContain(
      'triage_agent_janitor_removed_total{reason="succeeded"} 1',
    );
    expect(text).toContain(
      'triage_agent_janitor_removed_total{reason="orphaned"} 1',
    );
    expect(text).toContain(
      'triage_agent_volume_capacity_bytes{volume="workspace"} 100',
    );
    expect(text).toContain(
      'triage_agent_volume_used_bytes{volume="workspace"} 30',
    );
    expect(text).toContain('triage_agent_volume_used_bytes{volume="cache"} 10');
    expect(text).toContain(
      'triage_agent_workspace_directories{state="active"} 1',
    );
    expect(text).toContain(
      'triage_agent_workspace_directories{state="retained"} 0',
    );
    expect(text).toContain(
      `triage_agent_janitor_last_success_timestamp_seconds ${NOW / 1000}`,
    );
    expect(text).toContain("triage_agent_janitor_errors_total 0");
  });

  test("deletes nothing when the workflow list fails, but still reports usage", async () => {
    const f = fixture("api-down");
    const done = workspaceDir(f.workspace, "wf-done", 48 * HOUR);
    const janitor = createJanitor({
      workspaceRoot: f.workspace,
      cacheRoot: f.cache,
      cachePruneDirs: [],
      namespace: "triage-agent",
      policy,
      client: listClient(new Error("Kubernetes API GET returned 503")),
      usage: usage({ workspaces: 0.95 }),
      logger: silent,
      now: () => NOW,
    });

    await janitor.run();

    expect(existsSync(done)).toBe(true);
    const text = janitor.render();
    expect(text).toContain("triage_agent_janitor_errors_total 1");
    expect(text).toContain(
      'triage_agent_volume_used_bytes{volume="workspace"} 95',
    );
    expect(text).toContain(
      "triage_agent_janitor_last_success_timestamp_seconds 0",
    );
  });

  test("prunes the regenerable caches above the watermark only while no workflow runs", async () => {
    const f = fixture("cache");
    for (const dir of ["go/build", "npm", "memory"]) {
      mkdirSync(join(f.cache, dir), { recursive: true });
      writeFileSync(join(f.cache, dir, "blob"), "x");
    }
    const options = {
      workspaceRoot: f.workspace,
      cacheRoot: f.cache,
      cachePruneDirs: ["go/build", "npm"],
      namespace: "triage-agent",
      policy,
      usage: usage({ cache: 0.9 }),
      logger: silent,
      now: () => NOW,
    };

    const busy = createJanitor({
      ...options,
      client: listClient({ "wf-running": { phase: "Running" } }),
    });
    await busy.run();
    expect(existsSync(join(f.cache, "go/build/blob"))).toBe(true);

    const idle = createJanitor({ ...options, client: listClient({}) });
    await idle.run();
    expect(existsSync(join(f.cache, "go/build"))).toBe(false);
    expect(existsSync(join(f.cache, "npm"))).toBe(false);
    expect(existsSync(join(f.cache, "memory/blob"))).toBe(true);
    expect(idle.render()).toContain(
      'triage_agent_janitor_removed_total{reason="cache"} 2',
    );
  });
});

describe("readIntakeConfig janitor settings", () => {
  const base = {
    ALERTMANAGER_URL: "http://am:9093",
    WORKFLOW_NAMESPACE: "triage-agent",
  };

  test("is off without a workspace root", () => {
    expect(readIntakeConfig(base).janitor).toBeUndefined();
  });

  test("reads the roots, intervals and watermark", () => {
    expect(
      readIntakeConfig({
        ...base,
        WORKSPACE_ROOT: "/workspaces",
        CACHE_ROOT: "/cache",
        CACHE_PRUNE_DIRS: "go/build, npm",
        JANITOR_INTERVAL_SECONDS: "120",
        FAILED_RETENTION_SECONDS: "3600",
        ORPHAN_GRACE_SECONDS: "600",
        HIGH_WATERMARK: "0.75",
      }).janitor,
    ).toEqual({
      workspaceRoot: "/workspaces",
      cacheRoot: "/cache",
      cachePruneDirs: ["go/build", "npm"],
      intervalSeconds: 120,
      policy: {
        failedRetentionMs: 3_600_000,
        orphanGraceMs: 600_000,
        highWatermark: 0.75,
      },
    });
  });

  test("rejects a watermark outside (0, 1] and prune paths that escape the cache", () => {
    expect(() =>
      readIntakeConfig({
        ...base,
        WORKSPACE_ROOT: "/w",
        HIGH_WATERMARK: "1.5",
      }),
    ).toThrow("HIGH_WATERMARK");
    expect(() =>
      readIntakeConfig({
        ...base,
        WORKSPACE_ROOT: "/w",
        CACHE_ROOT: "/cache",
        CACHE_PRUNE_DIRS: "../etc",
      }),
    ).toThrow("CACHE_PRUNE_DIRS");
  });
});
