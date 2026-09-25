#!/usr/bin/env bun
/**
 * Homelab alert triage agent (docs/runbooks/triage-agent.md).
 *
 *   triage-agent serve         intake: webhook + sweep -> one Workflow per alert group
 *   triage-agent run <stage>   one stage of the triage-fix WorkflowTemplate
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { exec } from "./exec.ts";
import { readIntakeConfig } from "./intake/config.ts";
import { createIntake } from "./intake/intake.ts";
import { inClusterWorkflowClient, type WorkflowClient } from "./intake/kube.ts";
import { createHandler } from "./intake/server.ts";
import { fakeQuery } from "./llm.ts";
import { readStageConfig, Workdir } from "./stages/context.ts";
import { isStageName, runStage, STAGES } from "./stages/index.ts";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const dryRunClient: WorkflowClient = {
  create: async () => "dry-run",
  listActive: async () => [],
};

async function serve(): Promise<number> {
  const config = readIntakeConfig(process.env);
  const client = config.dryRun
    ? dryRunClient
    : inClusterWorkflowClient(process.env);
  const intake = createIntake(config, { client, logger });
  const server = Bun.serve({
    port: config.port,
    fetch: createHandler({
      onAlerts: intake.handleAlerts,
      records: intake.records,
      metrics: intake.metrics,
      queueDepth: intake.queueDepth,
    }),
  });
  logger.info({ port: server.port, dryRun: config.dryRun }, "intake listening");
  if (config.sweepIntervalSeconds > 0) {
    void intake.sweep();
    setInterval(() => void intake.sweep(), config.sweepIntervalSeconds * 1000);
  }
  return new Promise((resolve) => {
    process.on("SIGTERM", () => {
      logger.info("SIGTERM, shutting down");
      server.stop();
      resolve(0);
    });
  });
}

async function run(stage: string | undefined): Promise<number> {
  if (!stage || !isStageName(stage)) {
    logger.fatal(
      { stage, stages: Object.keys(STAGES) },
      "usage: triage-agent run <stage>",
    );
    return 2;
  }
  const config = readStageConfig(process.env);
  await runStage(stage, {
    config,
    work: new Workdir(config.WORK_DIR),
    exec,
    query: (s) =>
      config.TRIAGE_AGENT_FAKE_LLM ? fakeQuery(s) : (params) => query(params),
    logger: logger.child({ stage }),
    env: process.env,
    fetch,
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
  });
  logger.info({ stage }, "stage finished");
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, stage] = argv;
  try {
    if (command === "serve") return await serve();
    if (command === "run") return await run(stage);
    logger.fatal({ argv }, "usage: triage-agent serve | run <stage>");
    return 2;
  } catch (error) {
    logger.fatal({ err: error, command, stage }, "failed");
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
