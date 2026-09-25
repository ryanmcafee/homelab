import { z } from "zod";

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL");

const repoUrl = z
  .string()
  .url()
  .refine(
    (u) => /^(https?|file):\/\//.test(u),
    "must be an http(s) or file URL",
  );

const list = z.string().transform(
  (s) =>
    new Set(
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
);

const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8080),
    ALERTMANAGER_URL: httpUrl,
    SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
    COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(86400),
    IGNORED_ALERTS: list.default(new Set(["Watchdog", "InfoInhibitor"])),
    MAX_REPORTS: z.coerce.number().int().positive().default(50),
    REPO_URL: repoUrl,
    REPO_BRANCH: z.string().min(1).default("main"),
    WORKSPACE_DIR: z.string().min(1).default("/workspace/homelab"),
    CLAUDE_CONFIG_DIR: z.string().min(1),
    SETTINGS_PATH: z.string().default("/etc/triage-agent/settings.json"),
    AGENT_CONFIG_PATH: z.string().default("/etc/triage-agent/agent.json"),
    MCP_CONFIG_PATH: z.string().default("/etc/triage-agent/mcp-servers.json"),
    GITHUB_TOKEN: optional,
    DOTFILES_REPO: optional.refine(
      (v) => v === undefined || /^[\w.-]+\/[\w.-]+$/.test(v),
      "must be owner/name",
    ),
    DOTFILES_PROFILE: z.string().default("personal"),
    DOTFILES_DIR: z.string().default("/workspace/dotfiles"),
    SLACK_WEBHOOK_URL: optional,
    CLAUDE_CODE_OAUTH_TOKEN: optional,
    DRY_RUN: flag,
  })
  .refine((e) => e.DRY_RUN || e.CLAUDE_CODE_OAUTH_TOKEN, {
    message:
      "CLAUDE_CODE_OAUTH_TOKEN is not set: create the triage-agent 1Password item (docs/runbooks/triage-agent.md) or set DRY_RUN=true",
    path: ["CLAUDE_CODE_OAUTH_TOKEN"],
  });

export interface Config {
  port: number;
  alertmanagerUrl: string;
  sweepIntervalSeconds: number;
  cooldownSeconds: number;
  ignoredAlerts: ReadonlySet<string>;
  maxReports: number;
  repoUrl: string;
  repoBranch: string;
  workspaceDir: string;
  claudeConfigDir: string;
  settingsPath: string;
  agentConfigPath: string;
  mcpConfigPath: string;
  githubToken?: string;
  dotfilesRepo?: string;
  dotfilesProfile: string;
  dotfilesDir: string;
  slackWebhookUrl?: string;
  dryRun: boolean;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "config"}: ${i.message}`)
    .join("; ");
}

export function readConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${describeIssues(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    alertmanagerUrl: e.ALERTMANAGER_URL.replace(/\/+$/, ""),
    sweepIntervalSeconds: e.SWEEP_INTERVAL_SECONDS,
    cooldownSeconds: e.COOLDOWN_SECONDS,
    ignoredAlerts: e.IGNORED_ALERTS,
    maxReports: e.MAX_REPORTS,
    repoUrl: e.REPO_URL,
    repoBranch: e.REPO_BRANCH,
    workspaceDir: e.WORKSPACE_DIR,
    claudeConfigDir: e.CLAUDE_CONFIG_DIR,
    settingsPath: e.SETTINGS_PATH,
    agentConfigPath: e.AGENT_CONFIG_PATH,
    mcpConfigPath: e.MCP_CONFIG_PATH,
    ...(e.GITHUB_TOKEN ? { githubToken: e.GITHUB_TOKEN } : {}),
    ...(e.DOTFILES_REPO ? { dotfilesRepo: e.DOTFILES_REPO } : {}),
    dotfilesProfile: e.DOTFILES_PROFILE,
    dotfilesDir: e.DOTFILES_DIR,
    ...(e.SLACK_WEBHOOK_URL ? { slackWebhookUrl: e.SLACK_WEBHOOK_URL } : {}),
    dryRun: e.DRY_RUN,
  };
}

const agentSchema = z.object({
  model: z.string().min(1),
  fallbackModel: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().default(60),
  timeoutSeconds: z.number().int().positive().default(1200),
  allowedTools: z.array(z.string().min(1)).default([]),
  disallowedTools: z.array(z.string().min(1)).default([]),
});

export type AgentConfig = z.infer<typeof agentSchema>;

export function parseAgentConfig(raw: unknown): AgentConfig {
  return agentSchema.parse(raw);
}
