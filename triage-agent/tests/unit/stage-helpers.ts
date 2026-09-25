import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { Exec } from "../../src/exec.ts";
import type { LlmStage, QueryFn } from "../../src/llm.ts";
import {
  readStageConfig,
  type StageDeps,
  Workdir,
} from "../../src/stages/context.ts";
import { group } from "./fixtures.ts";
import { realExec } from "./helpers.ts";

export const AGENT_JSON = {
  model: "opus[1m]",
  stages: {
    triage: { maxTurns: 10, timeoutSeconds: 60 },
    plan: { maxTurns: 10, timeoutSeconds: 60 },
    implement: { maxTurns: 20, timeoutSeconds: 60 },
  },
};

/** Writes the ConfigMap files a stage pod mounts at /etc/triage-agent. */
export function writeEtc(root: string): Record<string, string> {
  const etc = join(root, "etc");
  mkdirSync(etc, { recursive: true });
  writeFileSync(join(etc, "settings.json"), "{}");
  writeFileSync(join(etc, "agent.json"), JSON.stringify(AGENT_JSON));
  writeFileSync(
    join(etc, "mcp-servers.json"),
    JSON.stringify({
      context7: { enabled: true, command: "npx", args: ["x"] },
    }),
  );
  return {
    SETTINGS_PATH: join(etc, "settings.json"),
    AGENT_CONFIG_PATH: join(etc, "agent.json"),
    MCP_CONFIG_PATH: join(etc, "mcp-servers.json"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
  };
}

export interface DepsOptions {
  root: string;
  env?: Record<string, string>;
  exec?: Exec;
  query?: (stage: LlmStage) => QueryFn;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function stageDeps(opts: DepsOptions): StageDeps {
  const env: Record<string, string> = {
    WORK_DIR: join(opts.root, "work"),
    REPO_URL: "https://github.com/example/homelab.git",
    REPO_SLUG: "example/homelab",
    BRANCH: "triage/kubepodcrashlooping-12345678",
    ALERT_GROUP: JSON.stringify(group),
    WORKFLOW_NAME: "triage-kubepodcrashlooping-abcde",
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
    GITHUB_TOKEN: "gh-tok",
    ...opts.env,
  };
  const config = readStageConfig(env);
  return {
    config,
    work: new Workdir(config.WORK_DIR),
    exec: opts.exec ?? realExec,
    query:
      opts.query ??
      (() => {
        throw new Error("no query configured");
      }),
    logger: pino({ level: "silent" }),
    env,
    fetch:
      opts.fetch ??
      (async () => {
        throw new Error("no fetch configured");
      }),
    now: opts.now ?? Date.now,
    sleep: opts.sleep ?? (async () => {}),
  };
}

/** Real git; everything else (gh, mise, task, argocd) answered by `fake`. */
export function gitOnly(fake: Exec): Exec {
  return (cmd, o) => (cmd[0] === "git" ? realExec(cmd, o) : fake(cmd, o));
}
