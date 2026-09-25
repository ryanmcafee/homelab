import { describe, expect, test } from "bun:test";
import type { AlertGroup } from "../../src/alerts.ts";
import { buildPrompt, SYSTEM_PROMPT_APPEND } from "../../src/prompt.ts";

const group: AlertGroup = {
  key: "KubePodCrashLooping/paperclip",
  alertname: "KubePodCrashLooping",
  namespace: "paperclip",
  severity: "warning",
  alerts: [
    {
      fingerprint: "abc",
      name: "KubePodCrashLooping",
      labels: {
        alertname: "KubePodCrashLooping",
        namespace: "paperclip",
        pod: "paperclip-0",
      },
      annotations: { summary: "Pod paperclip-0 is crash looping" },
      startsAt: "2026-09-25T10:00:00Z",
    },
  ],
};

describe("buildPrompt", () => {
  const prompt = buildPrompt(group, {
    alertmanagerUrl: "http://am.monitoring.svc:9093",
  });

  test("names the alert group and scope", () => {
    expect(prompt).toContain("KubePodCrashLooping");
    expect(prompt).toContain("namespace paperclip");
    expect(prompt).toContain("http://am.monitoring.svc:9093");
  });

  test("embeds the alerts as JSON data", () => {
    expect(prompt).toContain('"pod": "paperclip-0"');
    expect(prompt).toContain("```json");
  });

  test("asks for the four report sections", () => {
    for (const heading of [
      "## Summary",
      "## Probable root cause",
      "## Evidence",
      "## Recommended fix",
    ]) {
      expect(prompt).toContain(heading);
    }
  });

  test("caps the number of alerts and the length of long values", () => {
    const many: AlertGroup = {
      ...group,
      alerts: Array.from({ length: 40 }, (_, i) => ({
        ...(group.alerts[0] ?? { fingerprint: "", name: "", labels: {} }),
        fingerprint: `f${i}`,
        annotations: { description: "x".repeat(5000) },
        startsAt: "2026-09-25T10:00:00Z",
      })),
    };
    const long = buildPrompt(many, { alertmanagerUrl: "http://am" });
    expect(long).toContain("20 of 40 alerts");
    expect(long).not.toContain("x".repeat(2001));
  });

  test("describes cluster-scoped groups", () => {
    const { namespace: _omit, ...clusterGroup } = group;
    expect(
      buildPrompt(clusterGroup, { alertmanagerUrl: "http://am" }),
    ).toContain("cluster-scoped");
  });
});

describe("SYSTEM_PROMPT_APPEND", () => {
  test("states the read-only rules", () => {
    expect(SYSTEM_PROMPT_APPEND).toMatch(/read-only/i);
    expect(SYSTEM_PROMPT_APPEND).toMatch(/Secret/);
    expect(SYSTEM_PROMPT_APPEND).toMatch(/exec/);
  });
});
