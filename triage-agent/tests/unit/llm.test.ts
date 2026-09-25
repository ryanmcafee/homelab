import { describe, expect, test } from "bun:test";
import {
  type AgentConfig,
  type AgentMessage,
  fakeQuery,
  parseAgentConfig,
  type QueryFn,
  runAgent,
  stageOptions,
} from "../../src/llm.ts";

const agent: AgentConfig = parseAgentConfig({
  model: "opus[1m]",
  stages: {
    triage: { maxTurns: 40, timeoutSeconds: 900 },
    plan: { maxTurns: 20, timeoutSeconds: 600 },
    implement: { maxTurns: 120, timeoutSeconds: 2700 },
  },
});

const base = {
  agent,
  cwd: "/work/repo",
  mcpServers: {},
  writableRoots: ["/work"],
};

describe("stageOptions", () => {
  test("read-only stages never prompt and add no tools", () => {
    const options = stageOptions({ ...base, stage: "triage" });
    expect(options).toMatchObject({
      model: "opus[1m]",
      maxTurns: 40,
      cwd: "/work/repo",
      settingSources: ["user", "project"],
      permissionMode: "dontAsk",
      allowedTools: [],
      persistSession: false,
    });
    expect(options.hooks?.PreToolUse?.length).toBe(1);
  });

  test("implement may edit and run Bash, with more turns", () => {
    const options = stageOptions({ ...base, stage: "implement" });
    expect(options.allowedTools).toContain("Edit");
    expect(options.allowedTools).toContain("Bash");
    expect(options.maxTurns).toBe(120);
  });

  test("passes a JSON schema as the output format", () => {
    const options = stageOptions({
      ...base,
      stage: "triage",
      outputSchema: { type: "object" },
    });
    expect(options.outputFormat).toEqual({
      type: "json_schema",
      schema: { type: "object" },
    });
  });

  test("the deny hook blocks gh pr merge", async () => {
    const options = stageOptions({ ...base, stage: "implement" });
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    const out = await hook?.(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 3 --squash" },
        tool_use_id: "t",
        session_id: "s",
        transcript_path: "/tmp/t",
        cwd: "/work/repo",
      },
      "t",
      { signal: new AbortController().signal },
    );
    expect(JSON.stringify(out)).toContain('"permissionDecision":"deny"');
  });

  test("parseAgentConfig requires every stage", () => {
    expect(() =>
      parseAgentConfig({ model: "opus", stages: { triage: {} } }),
    ).toThrow();
  });
});

function fake(messages: AgentMessage[], seen: unknown[] = []): QueryFn {
  return async function* (params) {
    seen.push(params);
    for (const m of messages) yield m;
  };
}

describe("runAgent", () => {
  test("returns text, structured output, cost and turns", async () => {
    const seen: unknown[] = [];
    const run = await runAgent(
      fake(
        [
          { type: "system", subtype: "init" },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            structured_output: { a: 1 },
            total_cost_usd: 0.4,
            num_turns: 7,
          },
        ],
        seen,
      ),
      "p",
      { model: "opus" },
      5000,
    );
    expect(run).toEqual({
      ok: true,
      text: "done",
      structured: { a: 1 },
      costUsd: 0.4,
      turns: 7,
    });
    expect(seen[0]).toMatchObject({ prompt: "p", options: { model: "opus" } });
  });

  test("reports error results, thrown errors and missing results", async () => {
    const errored = await runAgent(
      fake([
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: ["max turns"],
        },
      ]),
      "p",
      {},
      5000,
    );
    expect(errored.ok).toBe(false);
    expect(errored.text).toContain("error_max_turns");

    const thrown: QueryFn = async function* () {
      yield { type: "system" };
      throw new Error("spawn failed");
    };
    expect((await runAgent(thrown, "p", {}, 5000)).text).toContain(
      "spawn failed",
    );
    expect((await runAgent(fake([]), "p", {}, 5000)).text).toContain(
      "no result",
    );
  });

  test("aborts a run that exceeds its timeout", async () => {
    const slow: QueryFn = async function* (params) {
      await new Promise<void>((resolve) =>
        params.options.abortController?.signal.addEventListener("abort", () =>
          resolve(),
        ),
      );
      throw new Error("aborted");
    };
    const run = await runAgent(slow, "p", {}, 10);
    expect(run.ok).toBe(false);
    expect(run.text).toContain("timed out");
  });
});

describe("fakeQuery", () => {
  test("answers triage with a non-actionable structured result", async () => {
    const run = await runAgent(fakeQuery("triage"), "p", {}, 1000);
    expect(run.structured).toMatchObject({ actionable: false });
  });
});
