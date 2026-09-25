import { describe, expect, test } from "bun:test";
import type { AlertGroup } from "../../src/alerts.ts";
import {
  type AgentMessage,
  type QueryFn,
  ReportStore,
  runTriage,
  type TriageOptions,
} from "../../src/triage.ts";

const group: AlertGroup = {
  key: "KubePodCrashLooping/paperclip",
  alertname: "KubePodCrashLooping",
  namespace: "paperclip",
  severity: "warning",
  alerts: [
    {
      fingerprint: "abc",
      name: "KubePodCrashLooping",
      labels: { alertname: "KubePodCrashLooping" },
      annotations: {},
      startsAt: "2026-09-25T10:00:00Z",
    },
  ],
};

const options: TriageOptions = {
  prompt: "triage it",
  timeoutMs: 5000,
  sdkOptions: { model: "opus", maxTurns: 3 },
};

function fakeQuery(messages: AgentMessage[], seen: unknown[] = []): QueryFn {
  return async function* (params) {
    seen.push(params);
    for (const m of messages) yield m;
  };
}

let clock = 0;
const now = () => new Date(Date.UTC(2026, 8, 25, 10, 0, clock++));

describe("runTriage", () => {
  test("returns the result text, cost and turns of a successful run", async () => {
    const seen: unknown[] = [];
    const report = await runTriage(
      group,
      options,
      fakeQuery(
        [
          { type: "system", subtype: "init" },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "## Summary\nok",
            total_cost_usd: 0.42,
            num_turns: 7,
          },
        ],
        seen,
      ),
      now,
    );
    expect(report).toMatchObject({
      key: group.key,
      alertname: "KubePodCrashLooping",
      namespace: "paperclip",
      status: "ok",
      text: "## Summary\nok",
      costUsd: 0.42,
      turns: 7,
      fingerprints: ["abc"],
    });
    expect(seen[0]).toMatchObject({
      prompt: "triage it",
      options: { model: "opus", maxTurns: 3 },
    });
  });

  test("reports an error result with its errors", async () => {
    const report = await runTriage(
      group,
      options,
      fakeQuery([
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: ["max turns reached"],
          num_turns: 3,
          total_cost_usd: 1,
        },
      ]),
      now,
    );
    expect(report.status).toBe("error");
    expect(report.text).toContain("error_max_turns");
    expect(report.text).toContain("max turns reached");
  });

  test("reports a thrown SDK error", async () => {
    const failing: QueryFn = async function* () {
      yield { type: "system" };
      throw new Error("spawn failed");
    };
    const report = await runTriage(group, options, failing, now);
    expect(report.status).toBe("error");
    expect(report.text).toContain("spawn failed");
  });

  test("reports a run that ends without a result", async () => {
    const report = await runTriage(group, options, fakeQuery([]), now);
    expect(report.status).toBe("error");
    expect(report.text).toContain("no result");
  });

  test("aborts a run that exceeds its timeout", async () => {
    const slow: QueryFn = async function* (params) {
      await new Promise<void>((resolve) => {
        params.options.abortController?.signal.addEventListener("abort", () =>
          resolve(),
        );
      });
      throw new Error("aborted");
    };
    const report = await runTriage(
      group,
      { ...options, timeoutMs: 10 },
      slow,
      now,
    );
    expect(report.status).toBe("error");
    expect(report.text).toContain("timed out");
  });
});

describe("ReportStore", () => {
  test("keeps the newest reports first up to its capacity", () => {
    const store = new ReportStore(2);
    for (const id of ["a", "b", "c"]) {
      store.add({
        id,
        key: id,
        alertname: id,
        fingerprints: [],
        startedAt: "",
        finishedAt: "",
        status: "ok",
        text: "",
        costUsd: 0,
        turns: 0,
      });
    }
    expect(store.list().map((r) => r.id)).toEqual(["c", "b"]);
  });
});
