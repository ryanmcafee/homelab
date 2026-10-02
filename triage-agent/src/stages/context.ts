import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { type AlertGroup, alertGroupSchema } from "../alerts.ts";
import type { Exec } from "../exec.ts";
import type { LlmStage, QueryFn } from "../llm.ts";

const flag = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const count = (d: number) => z.coerce.number().int().positive().default(d);

const envSchema = z.object({
  WORK_DIR: z.string().min(1).default("/work"),
  REPO_URL: z.string().min(1),
  REPO_SLUG: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/name"),
  BASE_BRANCH: z.string().min(1).default("main"),
  BRANCH: optional.refine(
    (v) => v === undefined || /^triage\/[a-z0-9-]+$/.test(v),
    "must be triage/<slug>",
  ),
  ALERT_GROUP: optional,
  ALERTMANAGER_URL: z.string().default(""),
  ATTEMPT: count(1),
  MAX_ATTEMPTS: count(3),
  FEEDBACK: z.enum(["none", "verify", "ci"]).default("none"),
  CLAUDE_CONFIG_DIR: z.string().default("/home/agent/.claude"),
  SETTINGS_PATH: z.string().default("/etc/triage-agent/settings.json"),
  AGENT_CONFIG_PATH: z.string().default("/etc/triage-agent/agent.json"),
  MCP_CONFIG_PATH: z.string().default("/etc/triage-agent/mcp-servers.json"),
  GITHUB_TOKEN: optional,
  DOTFILES_REPO: optional.refine(
    (v) => v === undefined || /^[\w.-]+\/[\w.-]+$/.test(v),
    "must be owner/name",
  ),
  DOTFILES_PROFILE: z.string().default("personal"),
  DOTFILES_DIR: z.string().default("/home/agent/dotfiles"),
  TRIAGE_AGENT_FAKE_LLM: flag,
  GIT_USER_NAME: z.string().min(1).default("homelab-triage-agent"),
  GIT_USER_EMAIL: z
    .string()
    .min(3)
    .default("homelab-triage-agent@users.noreply.github.com"),
  PUSHOVER_TOKEN: optional,
  PUSHOVER_USER_KEY: optional,
  WORKFLOW_NAME: z.string().default(""),
  WORKFLOW_STATUS: z.string().default(""),
  WORKFLOW_FAILURES: z.string().default(""),
  WORKFLOW_UI_URL: optional,
  CI_TIMEOUT_SECONDS: count(3600),
  CI_POLL_SECONDS: count(30),
  ARGOCD_APP: optional.refine(
    (v) => v === undefined || /^[a-z0-9][a-z0-9-]*$/.test(v),
    "must be an Application name",
  ),
  MISE_TOOLS: z
    .string()
    .default("go helm bun kubeconform conftest pluto task yq"),
  PR_LABEL: z.string().default("triage-agent"),
  NEEDS_HUMAN_LABEL: z.string().default("triage-agent/needs-human"),
});

export type StageConfig = z.infer<typeof envSchema>;

export function readStageConfig(
  env: Record<string, string | undefined>,
): StageConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid stage configuration: ${detail}`);
  }
  return parsed.data;
}

export function alertGroupOf(config: StageConfig): AlertGroup {
  if (!config.ALERT_GROUP) throw new Error("ALERT_GROUP is not set");
  return alertGroupSchema.parse(JSON.parse(config.ALERT_GROUP));
}

/** Files one workflow shares between its stages on the workspace volume. */
export class Workdir {
  constructor(readonly root: string) {}

  get repo(): string {
    return join(this.root, "repo");
  }

  path(name: string): string {
    return join(this.root, name);
  }

  has(name: string): boolean {
    return existsSync(this.path(name));
  }

  read(name: string): string {
    return readFileSync(this.path(name), "utf8");
  }

  readIfExists(name: string): string | undefined {
    return this.has(name) ? this.read(name) : undefined;
  }

  readJson(name: string): unknown {
    return JSON.parse(this.read(name));
  }

  write(name: string, content: string): void {
    const path = this.path(name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  writeJson(name: string, value: unknown): void {
    this.write(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** An Argo output parameter (valueFrom.path out/<name>). */
  output(name: string, value: string | number | boolean): void {
    this.write(join("out", name), String(value));
  }
}

export interface StageDeps {
  config: StageConfig;
  work: Workdir;
  exec: Exec;
  query: (stage: LlmStage) => QueryFn;
  logger: Logger;
  env: Record<string, string | undefined>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
