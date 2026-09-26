import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import type { JanitorPolicy } from "./janitor.ts";

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL");

const list = z.string().transform(
  (s) =>
    new Set(
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
);

const relativeDirs = z.string().transform((s, ctx) => {
  const dirs = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const d of dirs) {
    if (isAbsolute(d) || normalize(d).startsWith("..")) {
      ctx.addIssue({
        code: "custom",
        message: `${d} must stay inside CACHE_ROOT`,
      });
    }
  }
  return dirs;
});

const seconds = (d: number) => z.coerce.number().int().positive().default(d);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  ALERTMANAGER_URL: httpUrl,
  SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
  COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(86400),
  IGNORED_ALERTS: list.default(new Set(["Watchdog", "InfoInhibitor"])),
  MAX_RECORDS: z.coerce.number().int().positive().default(50),
  WORKFLOW_NAMESPACE: z.string().min(1),
  WORKFLOW_TEMPLATE: z.string().min(1).default("triage-fix"),
  WORKSPACE_ROOT: z.string().optional(),
  CACHE_ROOT: z.string().optional(),
  CACHE_PRUNE_DIRS: relativeDirs.default([]),
  JANITOR_INTERVAL_SECONDS: seconds(600),
  FAILED_RETENTION_SECONDS: seconds(86400),
  ORPHAN_GRACE_SECONDS: seconds(3600),
  HIGH_WATERMARK: z.coerce.number().gt(0).max(1).default(0.8),
  DRY_RUN: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export interface JanitorConfig {
  workspaceRoot: string;
  cacheRoot?: string;
  cachePruneDirs: string[];
  intervalSeconds: number;
  policy: JanitorPolicy;
}

export interface IntakeConfig {
  port: number;
  alertmanagerUrl: string;
  sweepIntervalSeconds: number;
  cooldownSeconds: number;
  ignoredAlerts: ReadonlySet<string>;
  maxRecords: number;
  workflowNamespace: string;
  workflowTemplate: string;
  dryRun: boolean;
  /** Unset without WORKSPACE_ROOT: nothing to reclaim. */
  janitor?: JanitorConfig;
}

export function readIntakeConfig(
  env: Record<string, string | undefined>,
): IntakeConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "config"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid configuration: ${detail}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    alertmanagerUrl: e.ALERTMANAGER_URL.replace(/\/+$/, ""),
    sweepIntervalSeconds: e.SWEEP_INTERVAL_SECONDS,
    cooldownSeconds: e.COOLDOWN_SECONDS,
    ignoredAlerts: e.IGNORED_ALERTS,
    maxRecords: e.MAX_RECORDS,
    workflowNamespace: e.WORKFLOW_NAMESPACE,
    workflowTemplate: e.WORKFLOW_TEMPLATE,
    dryRun: e.DRY_RUN,
    ...(e.WORKSPACE_ROOT
      ? {
          janitor: {
            workspaceRoot: e.WORKSPACE_ROOT,
            ...(e.CACHE_ROOT ? { cacheRoot: e.CACHE_ROOT } : {}),
            cachePruneDirs: e.CACHE_PRUNE_DIRS,
            intervalSeconds: e.JANITOR_INTERVAL_SECONDS,
            policy: {
              failedRetentionMs: e.FAILED_RETENTION_SECONDS * 1000,
              orphanGraceMs: e.ORPHAN_GRACE_SECONDS * 1000,
              highWatermark: e.HIGH_WATERMARK,
            },
          },
        }
      : {}),
  };
}
