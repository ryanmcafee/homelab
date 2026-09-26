import { describe, expect, test } from "bun:test";
import type { AlertGroup } from "../../src/alerts.ts";
import { goodPlan, group, triage } from "./fixtures.ts";
import {
  checkPlan,
  implementPrompt,
  planPrompt,
  SYSTEM_PROMPT_APPEND,
  triagePrompt,
  triageSchema,
} from "../../src/prompt.ts";

describe("triagePrompt", () => {
  const prompt = triagePrompt(group, "http://am.monitoring.svc:9093");

  test("names the group, scope and Alertmanager", () => {
    expect(prompt).toContain("KubePodCrashLooping");
    expect(prompt).toContain("namespace paperclip");
    expect(prompt).toContain("http://am.monitoring.svc:9093");
    expect(prompt).toContain('"pod": "paperclip-0"');
  });

  test("caps the number of alerts and long values", () => {
    const many: AlertGroup = {
      ...group,
      alerts: Array.from({ length: 40 }, (_, i) => ({
        fingerprint: `f${i}`,
        name: "A",
        labels: { alertname: "A" },
        annotations: { description: "x".repeat(5000) },
        startsAt: "2026-09-25T10:00:00Z",
      })),
    };
    const long = triagePrompt(many, "http://am");
    expect(long).toContain("20 of 40 alerts");
    expect(long).not.toContain("x".repeat(2001));
  });

  test("describes cluster-scoped groups", () => {
    const { namespace: _omit, ...clusterGroup } = group;
    expect(triagePrompt(clusterGroup, "http://am")).toContain("cluster-scoped");
  });
});

describe("triageSchema", () => {
  test("accepts a triage and rejects a partial one", () => {
    expect(triageSchema.parse(triage)).toEqual(triage);
    expect(() => triageSchema.parse({ actionable: true })).toThrow();
  });
});

describe("planPrompt and checkPlan", () => {
  test("asks for every plan section", () => {
    const prompt = planPrompt(group, triage);
    for (const h of ["## Why", "## Commit message", "## Files", "## Risk"]) {
      expect(prompt).toContain(h);
    }
  });

  test("accepts a complete plan and extracts the commit message and why", () => {
    const check = checkPlan(goodPlan);
    expect(check.ok).toBe(true);
    expect(check.commitMessage).toBe(
      "fix(paperclip): raise the memory limit above the working set",
    );
    expect(check.why).toContain("OOMKilled");
  });

  test("rejects an empty plan", () => {
    const check = checkPlan("");
    expect(check.ok).toBe(false);
    expect(check.problems.length).toBe(6);
  });

  test("rejects a commit message that is not conventional", () => {
    const check = checkPlan(
      goodPlan.replace(
        "fix(paperclip): raise the memory limit above the working set",
        "Raise memory",
      ),
    );
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toContain("conventional");
  });

  test("accepts a backticked commit message", () => {
    const check = checkPlan(
      goodPlan.replace(
        "fix(paperclip): raise the memory limit above the working set",
        "`fix(paperclip): raise the memory limit`",
      ),
    );
    expect(check.commitMessage).toBe("fix(paperclip): raise the memory limit");
  });
});

describe("implementPrompt", () => {
  test("names the branch and attempt and forbids committing", () => {
    const prompt = implementPrompt({
      group,
      triage,
      plan: goodPlan,
      branch: "triage/kubepodcrashlooping-1a2b3c4d",
      attempt: 1,
      maxAttempts: 3,
      feedback: undefined,
    });
    expect(prompt).toContain("attempt 1 of 3");
    expect(prompt).toContain("triage/kubepodcrashlooping-1a2b3c4d");
    expect(prompt).toContain("Do not commit");
    expect(prompt).not.toContain("failed");
  });

  test("feeds the tail of a failure log back", () => {
    const prompt = implementPrompt({
      group,
      triage,
      plan: goodPlan,
      branch: "b",
      attempt: 2,
      maxAttempts: 3,
      feedback: { kind: "ci", log: `${"y".repeat(100_000)}FINAL ERROR` },
    });
    expect(prompt).toContain("CI failed");
    expect(prompt).toContain("FINAL ERROR");
    expect(prompt.length).toBeLessThan(70_000);
  });
});

describe("SYSTEM_PROMPT_APPEND", () => {
  test("states the hard rules", () => {
    expect(SYSTEM_PROMPT_APPEND).toMatch(/GitOps pull requests/);
    expect(SYSTEM_PROMPT_APPEND).toMatch(/Never merge/);
    expect(SYSTEM_PROMPT_APPEND).toMatch(/Secrets/);
  });
});
