import { readFileSync } from "node:fs";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentConfig,
  type LlmStage,
  parseAgentConfig,
  runAgent,
  stageOptions,
} from "../llm.ts";
import { loadMcpServers, readProjectMcpServerNames } from "../mcp.ts";
import {
  checkPlan,
  type Feedback,
  implementPrompt,
  planPrompt,
  TRIAGE_JSON_SCHEMA,
  type Triage,
  triagePrompt,
  triageSchema,
} from "../prompt.ts";
import {
  assembleConfigDir,
  configureGit,
  prepareBranch,
  syncRepo,
} from "../workspace.ts";
import { alertGroupOf, type StageDeps } from "./context.ts";
import { installToolchain } from "./verify.ts";

interface AgentSetup {
  agent: AgentConfig;
  mcpServers: Record<string, McpStdioServerConfig>;
}

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

/** Git identity, the Claude config dir and the MCP servers of one stage pod. */
async function setupAgent(deps: StageDeps): Promise<AgentSetup> {
  const { config, exec, logger } = deps;
  await configureGit(
    exec,
    { name: config.GIT_USER_NAME, email: config.GIT_USER_EMAIL },
    config.GITHUB_TOKEN,
  );
  let dotfiles: { dir: string; profile: string } | undefined;
  if (config.DOTFILES_REPO && config.GITHUB_TOKEN) {
    await syncRepo(exec, {
      url: `https://github.com/${config.DOTFILES_REPO}.git`,
      dir: config.DOTFILES_DIR,
      branch: "main",
    });
    dotfiles = { dir: config.DOTFILES_DIR, profile: config.DOTFILES_PROFILE };
  }
  const installed = assembleConfigDir({
    configDir: config.CLAUDE_CONFIG_DIR,
    settingsPath: config.SETTINGS_PATH,
    ...(dotfiles ? { dotfiles } : {}),
  });
  const { servers, skipped } = loadMcpServers(
    readJson(config.MCP_CONFIG_PATH),
    deps.env,
    readProjectMcpServerNames(deps.work.repo),
  );
  logger.info(
    { installed, mcpServers: Object.keys(servers), skipped },
    "agent ready",
  );
  return {
    agent: parseAgentConfig(readJson(config.AGENT_CONFIG_PATH)),
    mcpServers: servers,
  };
}

async function run(
  deps: StageDeps,
  stage: LlmStage,
  setup: AgentSetup,
  prompt: string,
  outputSchema?: Record<string, unknown>,
) {
  if (!deps.config.TRIAGE_AGENT_FAKE_LLM && !deps.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN is not set: create the triage-agent 1Password item (docs/runbooks/triage-agent.md)",
    );
  }
  const options = stageOptions({
    stage,
    agent: setup.agent,
    cwd: deps.work.repo,
    mcpServers: setup.mcpServers,
    writableRoots: [deps.work.root, "/tmp"],
    ...(outputSchema ? { outputSchema } : {}),
    onStderr: (line) => deps.logger.debug({ stderr: line.trimEnd() }, "claude"),
  });
  const result = await runAgent(
    deps.query(stage),
    prompt,
    options,
    setup.agent.stages[stage].timeoutSeconds * 1000,
  );
  deps.logger.info(
    { stage, ok: result.ok, costUsd: result.costUsd, turns: result.turns },
    "agent finished",
  );
  if (!result.ok) throw new Error(result.text);
  return result;
}

/** Stage 1: read-only diagnosis -> triage.json, out/actionable. */
export async function triageStage(deps: StageDeps): Promise<void> {
  const group = alertGroupOf(deps.config);
  await syncRepo(deps.exec, {
    url: deps.config.REPO_URL,
    dir: deps.work.repo,
    branch: deps.config.BASE_BRANCH,
  });
  const setup = await setupAgent(deps);
  const result = await run(
    deps,
    "triage",
    setup,
    triagePrompt(group, deps.config.ALERTMANAGER_URL),
    TRIAGE_JSON_SCHEMA,
  );
  const triage = triageSchema.parse(result.structured);
  deps.work.writeJson("triage.json", triage);
  deps.work.output("actionable", triage.actionable);
}

function readTriage(deps: StageDeps): Triage {
  return triageSchema.parse(deps.work.readJson("triage.json"));
}

/** Stage 2: read-only plan -> plan.md, gated by checkPlan. */
export async function planStage(deps: StageDeps): Promise<void> {
  const group = alertGroupOf(deps.config);
  const setup = await setupAgent(deps);
  const result = await run(
    deps,
    "plan",
    setup,
    planPrompt(group, readTriage(deps)),
  );
  const check = checkPlan(result.text);
  if (!check.ok) {
    throw new Error(`plan rejected: ${check.problems.join("; ")}`);
  }
  deps.work.write("plan.md", result.text);
}

export function feedbackOf(deps: StageDeps): Feedback {
  const kind = deps.config.FEEDBACK;
  if (kind === "none") return undefined;
  const log = deps.work.readIfExists(
    kind === "verify" ? "verify.log" : "ci.log",
  );
  return log ? { kind, log } : undefined;
}

/** Stage 3: edit the branch (fresh from origin/main on the first attempt). */
export async function implementStage(deps: StageDeps): Promise<void> {
  const { config, work } = deps;
  if (!config.BRANCH) throw new Error("BRANCH is not set");
  const group = alertGroupOf(config);
  if (config.ATTEMPT === 1 && config.FEEDBACK === "none") {
    const existed = await prepareBranch(deps.exec, {
      dir: work.repo,
      branch: config.BRANCH,
      base: config.BASE_BRANCH,
    });
    deps.logger.info({ branch: config.BRANCH, existed }, "branch ready");
  }
  await installToolchain(deps.exec, work.repo, config.MISE_TOOLS);
  const setup = await setupAgent(deps);
  const result = await run(
    deps,
    "implement",
    setup,
    implementPrompt({
      group,
      triage: readTriage(deps),
      plan: work.read("plan.md"),
      branch: config.BRANCH,
      attempt: config.ATTEMPT,
      maxAttempts: config.MAX_ATTEMPTS,
      feedback: feedbackOf(deps),
    }),
  );
  work.write(`implement-${config.FEEDBACK}-${config.ATTEMPT}.md`, result.text);
}
