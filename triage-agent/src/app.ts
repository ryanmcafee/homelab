import { readFileSync } from "node:fs";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import { type Alert, type AlertGroup, groupAlerts } from "./alerts.ts";
import { fetchActiveAlerts } from "./alertmanager.ts";
import { type AgentConfig, type Config, parseAgentConfig } from "./config.ts";
import { loadMcpServers, readProjectMcpServerNames } from "./mcp.ts";
import { buildPrompt, SYSTEM_PROMPT_APPEND } from "./prompt.ts";
import { TriageQueue } from "./queue.ts";
import { Metrics } from "./server.ts";
import { type QueryFn, type Report, ReportStore, runTriage } from "./triage.ts";
import { assembleConfigDir, syncRepo } from "./workspace.ts";

export interface AppDeps {
  query: QueryFn;
  logger: Logger;
  env: Record<string, string | undefined>;
  notify?: (text: string) => Promise<void>;
}

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

export function formatReport(report: Report): string {
  const scope = report.namespace ? ` (${report.namespace})` : "";
  return [
    `*Triage: ${report.alertname}${scope}* - ${report.status}`,
    report.text,
  ].join("\n");
}

export function createApp(config: Config, deps: AppDeps) {
  const { logger } = deps;
  const reports = new ReportStore(config.maxReports);
  const metrics = new Metrics();
  let agent: AgentConfig | undefined;

  async function prepareConfigDir(): Promise<void> {
    let dotfiles: { dir: string; profile: string } | undefined;
    if (config.dotfilesRepo && config.githubToken) {
      await syncRepo({
        url: `https://github.com/${config.dotfilesRepo}`,
        dir: config.dotfilesDir,
        branch: "main",
        token: config.githubToken,
      });
      dotfiles = { dir: config.dotfilesDir, profile: config.dotfilesProfile };
    } else if (config.dotfilesRepo) {
      logger.warn("DOTFILES_REPO is set without GITHUB_TOKEN; skipping it");
    }
    const installed = assembleConfigDir({
      configDir: config.claudeConfigDir,
      settingsPath: config.settingsPath,
      ...(dotfiles ? { dotfiles } : {}),
    });
    logger.info({ installed }, "Claude config dir ready");
  }

  function sdkOptions(agentConfig: AgentConfig): Options {
    const { servers, skipped } = loadMcpServers(
      readJson(config.mcpConfigPath),
      deps.env,
      readProjectMcpServerNames(config.workspaceDir),
    );
    logger.info(
      { mcpServers: Object.keys(servers), skipped },
      "MCP servers for this run",
    );
    return {
      model: agentConfig.model,
      ...(agentConfig.fallbackModel
        ? { fallbackModel: agentConfig.fallbackModel }
        : {}),
      maxTurns: agentConfig.maxTurns,
      cwd: config.workspaceDir,
      settingSources: ["user", "project"],
      permissionMode: "dontAsk",
      allowedTools: agentConfig.allowedTools,
      disallowedTools: agentConfig.disallowedTools,
      mcpServers: servers,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: SYSTEM_PROMPT_APPEND,
      },
      persistSession: false,
      stderr: (data) => logger.debug({ stderr: data.trimEnd() }, "claude"),
    };
  }

  async function triage(group: AlertGroup): Promise<void> {
    const agentConfig =
      agent ?? parseAgentConfig(readJson(config.agentConfigPath));
    await syncRepo({
      url: config.repoUrl,
      dir: config.workspaceDir,
      branch: config.repoBranch,
      ...(config.githubToken ? { token: config.githubToken } : {}),
    });
    const prompt = buildPrompt(group, {
      alertmanagerUrl: config.alertmanagerUrl,
    });
    const query: QueryFn = config.dryRun
      ? async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: `dry run, prompt not sent:\n${prompt}`,
          };
        }
      : deps.query;

    logger.info(
      { key: group.key, alerts: group.alerts.length },
      "triage started",
    );
    const report = await runTriage(
      group,
      {
        prompt,
        timeoutMs: agentConfig.timeoutSeconds * 1000,
        sdkOptions: sdkOptions(agentConfig),
      },
      query,
    );
    reports.add(report);
    metrics.runFinished(report.status, report.costUsd);
    const log = report.status === "ok" ? logger.info : logger.error;
    log.call(logger, { report }, "triage finished");
    if (deps.notify) {
      await deps
        .notify(formatReport(report))
        .catch((error: unknown) =>
          logger.error({ err: error }, "report delivery failed"),
        );
    }
  }

  const queue = new TriageQueue(triage, {
    cooldownMs: config.cooldownSeconds * 1000,
    onError: (group, error) =>
      logger.error({ err: error, key: group.key }, "triage failed"),
  });

  function handleAlerts(alerts: Alert[]): void {
    for (const group of groupAlerts(alerts, config.ignoredAlerts)) {
      const outcome = queue.offer(group);
      logger.info(
        { key: group.key, alerts: group.alerts.length, outcome },
        "alert group offered",
      );
    }
  }

  async function sweep(): Promise<void> {
    try {
      handleAlerts(await fetchActiveAlerts(config.alertmanagerUrl));
    } catch (error) {
      metrics.sweepFailures++;
      logger.error({ err: error }, "Alertmanager sweep failed");
    }
  }

  return {
    reports,
    metrics,
    handleAlerts,
    sweep,
    queueDepth: () => queue.depth(),
    idle: () => queue.idle(),
    async start(): Promise<void> {
      agent = parseAgentConfig(readJson(config.agentConfigPath));
      await prepareConfigDir();
    },
  };
}
