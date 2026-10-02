import type {
  McpStdioServerConfig,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { preToolUseHook } from "./policy.ts";
import { SYSTEM_PROMPT_APPEND } from "./prompt.ts";

/** The fields of an SDK message this service reads. */
export interface AgentMessage {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  errors?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
}

export type QueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<AgentMessage>;

export type LlmStage = "triage" | "plan" | "implement";

const stageLimits = z.object({
  maxTurns: z.number().int().positive(),
  timeoutSeconds: z.number().int().positive(),
});

const agentConfigSchema = z.object({
  model: z.string().min(1),
  fallbackModel: z.string().min(1).optional(),
  stages: z.object({
    triage: stageLimits,
    plan: stageLimits,
    implement: stageLimits,
  }),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export function parseAgentConfig(raw: unknown): AgentConfig {
  return agentConfigSchema.parse(raw);
}

/** Tools the implement stage adds to the read-only allow list of settings.json. */
export const WRITE_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
];

export interface StageOptionsInput {
  stage: LlmStage;
  agent: AgentConfig;
  cwd: string;
  mcpServers: Record<string, McpStdioServerConfig>;
  writableRoots: readonly string[];
  outputSchema?: Record<string, unknown>;
  onStderr?: (line: string) => void;
}

/**
 * SDK options for one stage. Every stage runs in dontAsk mode (never prompts)
 * behind the PreToolUse deny hook; only implement may edit and run any Bash.
 */
export function stageOptions(input: StageOptionsInput): Options {
  const limits = input.agent.stages[input.stage];
  return {
    model: input.agent.model,
    ...(input.agent.fallbackModel
      ? { fallbackModel: input.agent.fallbackModel }
      : {}),
    maxTurns: limits.maxTurns,
    cwd: input.cwd,
    settingSources: ["user", "project"],
    permissionMode: "dontAsk",
    allowedTools: input.stage === "implement" ? WRITE_TOOLS : [],
    mcpServers: input.mcpServers,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: SYSTEM_PROMPT_APPEND,
    },
    hooks: {
      PreToolUse: [
        { hooks: [preToolUseHook({ writableRoots: input.writableRoots })] },
      ],
    },
    ...(input.outputSchema
      ? { outputFormat: { type: "json_schema", schema: input.outputSchema } }
      : {}),
    persistSession: false,
    ...(input.onStderr ? { stderr: input.onStderr } : {}),
  };
}

export interface AgentRun {
  ok: boolean;
  text: string;
  structured?: unknown;
  costUsd: number;
  turns: number;
}

const asNumber = (v: unknown): number => (typeof v === "number" ? v : 0);

function fromResult(result: AgentMessage): AgentRun {
  const costUsd = asNumber(result.total_cost_usd);
  const turns = asNumber(result.num_turns);
  if (
    result.subtype === "success" &&
    !result.is_error &&
    typeof result.result === "string"
  ) {
    return {
      ok: true,
      text: result.result,
      ...(result.structured_output !== undefined
        ? { structured: result.structured_output }
        : {}),
      costUsd,
      turns,
    };
  }
  const errors = Array.isArray(result.errors) ? result.errors.join("; ") : "";
  const detail = typeof result.result === "string" ? result.result : errors;
  return {
    ok: false,
    text: `agent ended with ${result.subtype ?? "unknown"}: ${detail}`,
    costUsd,
    turns,
  };
}

export async function runAgent(
  query: QueryFn,
  prompt: string,
  options: Options,
  timeoutMs: number,
): Promise<AgentRun> {
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);
  try {
    let result: AgentMessage | undefined;
    for await (const m of query({
      prompt,
      options: { ...options, abortController },
    })) {
      if (m.type === "result") result = m;
    }
    return result
      ? fromResult(result)
      : { ok: false, text: "agent ended with no result", costUsd: 0, turns: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text: timedOut
        ? `agent timed out after ${timeoutMs} ms`
        : `agent failed: ${message}`,
      costUsd: 0,
      turns: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** TRIAGE_AGENT_FAKE_LLM: canned answers so the DAG runs without Claude. */
export function fakeQuery(stage: LlmStage): QueryFn {
  const answers: Record<LlmStage, AgentMessage> = {
    triage: {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "fake triage",
      structured_output: {
        actionable: false,
        summary: "fake triage (TRIAGE_AGENT_FAKE_LLM)",
        rootCause: "none: the model was not called",
        evidence: [],
        confidence: "low",
        recommendedFix: "none",
      },
    },
    plan: {
      type: "result",
      subtype: "success",
      is_error: false,
      result:
        "## Why\nfake\n\n## Commit message\nchore(triage): fake plan\n\n## Files\nnone\n\n## Change\nnone\n\n## Tests\nnone\n\n## Risk\nnone\n",
    },
    implement: {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "fake implement: no changes",
    },
  };
  return async function* () {
    yield answers[stage];
  };
}
