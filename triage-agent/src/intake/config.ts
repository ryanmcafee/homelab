import { z } from "zod";

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

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  ALERTMANAGER_URL: httpUrl,
  SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
  COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(86400),
  IGNORED_ALERTS: list.default(new Set(["Watchdog", "InfoInhibitor"])),
  MAX_RECORDS: z.coerce.number().int().positive().default(50),
  WORKFLOW_NAMESPACE: z.string().min(1),
  WORKFLOW_TEMPLATE: z.string().min(1).default("triage-fix"),
  DRY_RUN: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

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
  };
}
