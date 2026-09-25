import { readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { WorkflowClient } from "./kube.ts";

export interface WorkflowState {
  phase: string;
  finishedAt?: string;
}

export interface WorkspaceEntry {
  name: string;
  mtimeMs: number;
}

export type RemoveReason = "succeeded" | "failed" | "orphaned" | "pressure";

export interface Removal {
  name: string;
  reason: RemoveReason;
}

export interface JanitorPolicy {
  failedRetentionMs: number;
  orphanGraceMs: number;
  /** Used/capacity ratio above which retained workspaces and caches go. */
  highWatermark: number;
}

const ACTIVE_PHASES = new Set(["", "Pending", "Running"]);

const isActive = (state: WorkflowState | undefined) =>
  state !== undefined && ACTIVE_PHASES.has(state.phase);

/**
 * Which workspace directories (named after their workflow) to delete. Active
 * workflows keep theirs; a young directory without a workflow may belong to one
 * that is just starting.
 */
export function planCleanup(
  entries: readonly WorkspaceEntry[],
  workflows: ReadonlyMap<string, WorkflowState>,
  now: number,
  policy: JanitorPolicy,
  pressure: boolean,
): Removal[] {
  return entries.flatMap((entry): Removal[] => {
    const state = workflows.get(entry.name);
    if (state === undefined) {
      return now - entry.mtimeMs > policy.orphanGraceMs
        ? [{ name: entry.name, reason: "orphaned" }]
        : [];
    }
    if (isActive(state)) return [];
    if (state.phase === "Succeeded") {
      return [{ name: entry.name, reason: "succeeded" }];
    }
    const finished = state.finishedAt
      ? Date.parse(state.finishedAt)
      : entry.mtimeMs;
    if (now - finished > policy.failedRetentionMs) {
      return [{ name: entry.name, reason: "failed" }];
    }
    return pressure ? [{ name: entry.name, reason: "pressure" }] : [];
  });
}

export interface VolumeUsage {
  capacityBytes: number;
  usedBytes: number;
}

export async function statfsUsage(path: string): Promise<VolumeUsage> {
  const s = await statfs(path);
  return {
    capacityBytes: s.blocks * s.bsize,
    usedBytes: (s.blocks - s.bfree) * s.bsize,
  };
}

const ratio = (u: VolumeUsage) =>
  u.capacityBytes > 0 ? u.usedBytes / u.capacityBytes : 0;

export interface JanitorOptions {
  workspaceRoot: string;
  cacheRoot?: string;
  /** Regenerable cache directories, relative to cacheRoot. */
  cachePruneDirs: readonly string[];
  namespace: string;
  policy: JanitorPolicy;
  client: WorkflowClient;
  logger: Logger;
  usage?: (path: string) => Promise<VolumeUsage>;
  now?: () => number;
}

type Volume = "workspace" | "cache";
type Reason = RemoveReason | "cache";

/**
 * Reclaims the shared workspace volume: each workflow works in
 * <workspaceRoot>/<workflow name>, and this deletes the directories whose
 * workflow finished (or vanished), then reports volume usage for alerting.
 */
export function createJanitor(opts: JanitorOptions) {
  const { logger, policy } = opts;
  const usageOf = opts.usage ?? statfsUsage;
  const now = opts.now ?? Date.now;
  const removed = new Map<Reason, number>();
  const volumes = new Map<Volume, VolumeUsage>();
  const directories = { active: 0, retained: 0 };
  let errors = 0;
  let lastSuccess = 0;
  let running = false;

  const count = (reason: Reason) =>
    removed.set(reason, (removed.get(reason) ?? 0) + 1);

  async function measure(volume: Volume, path: string): Promise<VolumeUsage> {
    const u = await usageOf(path);
    volumes.set(volume, u);
    return u;
  }

  async function listEntries(): Promise<WorkspaceEntry[]> {
    const dirents = await readdir(opts.workspaceRoot, { withFileTypes: true });
    const dirs = dirents.filter((d) => d.isDirectory());
    return Promise.all(
      dirs.map(async (d) => ({
        name: d.name,
        mtimeMs: (await stat(join(opts.workspaceRoot, d.name))).mtimeMs,
      })),
    );
  }

  async function remove(path: string, reason: Reason): Promise<boolean> {
    try {
      await rm(path, { recursive: true, force: true });
      count(reason);
      logger.info({ path, reason }, "workspace reclaimed");
      return true;
    } catch (error) {
      errors++;
      logger.error({ err: error, path, reason }, "workspace removal failed");
      return false;
    }
  }

  async function cleanWorkspaces(
    workflows: ReadonlyMap<string, WorkflowState>,
  ): Promise<boolean> {
    const before = await measure("workspace", opts.workspaceRoot);
    const pressure = ratio(before) >= policy.highWatermark;
    const entries = await listEntries();
    const plan = planCleanup(entries, workflows, now(), policy, pressure);
    const results = await Promise.all(
      plan.map((p) => remove(join(opts.workspaceRoot, p.name), p.reason)),
    );
    const gone = new Set(plan.map((p) => p.name));
    const left = entries.filter((e) => !gone.has(e.name));
    directories.active = left.filter((e) =>
      isActive(workflows.get(e.name)),
    ).length;
    directories.retained = left.length - directories.active;
    if (plan.length > 0) await measure("workspace", opts.workspaceRoot);
    return results.every(Boolean);
  }

  async function cleanCache(anyActive: boolean): Promise<boolean> {
    if (!opts.cacheRoot) return true;
    const cacheRoot = opts.cacheRoot;
    const u = await measure("cache", cacheRoot);
    if (ratio(u) < policy.highWatermark || anyActive) return true;
    const results = await Promise.all(
      opts.cachePruneDirs.map((d) => remove(join(cacheRoot, d), "cache")),
    );
    await measure("cache", cacheRoot);
    return results.every(Boolean);
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      let workflows: ReadonlyMap<string, WorkflowState> | undefined;
      try {
        workflows = await opts.client.listStates(opts.namespace);
      } catch (error) {
        errors++;
        logger.error(
          { err: error },
          "cannot list workflows; no workspace is deleted this round",
        );
      }
      if (!workflows) {
        await measure("workspace", opts.workspaceRoot);
        if (opts.cacheRoot) await measure("cache", opts.cacheRoot);
        return;
      }
      const anyActive = [...workflows.values()].some(isActive);
      const ok = [
        await cleanWorkspaces(workflows),
        await cleanCache(anyActive),
      ].every(Boolean);
      if (ok) lastSuccess = now();
    } catch (error) {
      errors++;
      logger.error({ err: error }, "workspace janitor failed");
    } finally {
      running = false;
    }
  }

  function render(): string {
    const reasons: Reason[] = [
      "succeeded",
      "failed",
      "orphaned",
      "pressure",
      "cache",
    ];
    const volumeLines = (metric: keyof VolumeUsage) =>
      [...volumes].map(
        ([v, u]) =>
          `triage_agent_volume_${metric === "capacityBytes" ? "capacity" : "used"}_bytes{volume="${v}"} ${u[metric]}`,
      );
    return [
      "# TYPE triage_agent_volume_capacity_bytes gauge",
      ...volumeLines("capacityBytes"),
      "# TYPE triage_agent_volume_used_bytes gauge",
      ...volumeLines("usedBytes"),
      "# TYPE triage_agent_workspace_directories gauge",
      `triage_agent_workspace_directories{state="active"} ${directories.active}`,
      `triage_agent_workspace_directories{state="retained"} ${directories.retained}`,
      "# TYPE triage_agent_janitor_removed_total counter",
      ...reasons.map(
        (r) =>
          `triage_agent_janitor_removed_total{reason="${r}"} ${removed.get(r) ?? 0}`,
      ),
      "# TYPE triage_agent_janitor_errors_total counter",
      `triage_agent_janitor_errors_total ${errors}`,
      "# TYPE triage_agent_janitor_last_success_timestamp_seconds gauge",
      `triage_agent_janitor_last_success_timestamp_seconds ${lastSuccess / 1000}`,
      "",
    ].join("\n");
  }

  return { run, render };
}
