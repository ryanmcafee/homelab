#!/usr/bin/env bun
/**
 * Homelab alert triage agent (docs/runbooks/triage-agent.md): receives
 * Alertmanager webhooks, sweeps the firing alerts on an interval and runs one
 * read-only Claude Agent SDK triage per new alert group.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { postToSlack } from "./alertmanager.ts";
import { createApp } from "./app.ts";
import { type Config, readConfig } from "./config.ts";
import { createHandler } from "./server.ts";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

async function main(): Promise<number> {
  let config: Config;
  try {
    config = readConfig(process.env);
  } catch (error) {
    logger.fatal({ err: error }, "cannot start");
    return 1;
  }
  const slackUrl = config.slackWebhookUrl;
  const app = createApp(config, {
    query: (params) => query(params),
    logger,
    env: process.env,
    ...(slackUrl ? { notify: (text) => postToSlack(slackUrl, text) } : {}),
  });
  try {
    await app.start();
  } catch (error) {
    logger.fatal({ err: error }, "cannot prepare the Claude config dir");
    return 1;
  }

  const server = Bun.serve({
    port: config.port,
    fetch: createHandler({
      onAlerts: app.handleAlerts,
      reports: app.reports,
      metrics: app.metrics,
      queueDepth: app.queueDepth,
    }),
  });
  logger.info(
    { port: server.port, dryRun: config.dryRun },
    "triage agent listening",
  );

  if (config.sweepIntervalSeconds > 0) {
    void app.sweep();
    setInterval(() => void app.sweep(), config.sweepIntervalSeconds * 1000);
  }

  return new Promise((resolve) => {
    process.on("SIGTERM", () => {
      logger.info("SIGTERM, shutting down");
      server.stop();
      resolve(0);
    });
  });
}

process.exit(await main());
