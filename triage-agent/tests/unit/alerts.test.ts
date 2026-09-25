import { describe, expect, test } from "bun:test";
import { groupAlerts, parseApiAlerts, parseWebhook } from "../../src/alerts.ts";

const webhookAlert = (overrides: Record<string, unknown> = {}) => ({
  status: "firing",
  labels: { alertname: "KubePodCrashLooping", namespace: "paperclip" },
  annotations: { summary: "Pod is crash looping" },
  startsAt: "2026-09-25T10:00:00Z",
  endsAt: "0001-01-01T00:00:00Z",
  generatorURL: "http://prometheus/graph",
  fingerprint: "aaa",
  ...overrides,
});

const webhook = (alerts: unknown[]) => ({
  version: "4",
  groupKey: '{}:{alertname="KubePodCrashLooping"}',
  truncatedAlerts: 0,
  status: "firing",
  receiver: "triage-agent",
  groupLabels: {},
  commonLabels: {},
  commonAnnotations: {},
  externalURL: "http://alertmanager",
  alerts,
});

describe("parseWebhook", () => {
  test("returns the firing alerts of a v4 payload", () => {
    const alerts = parseWebhook(
      webhook([
        webhookAlert(),
        webhookAlert({ status: "resolved", fingerprint: "bbb" }),
      ]),
    );
    expect(alerts).toEqual([
      {
        fingerprint: "aaa",
        name: "KubePodCrashLooping",
        labels: { alertname: "KubePodCrashLooping", namespace: "paperclip" },
        annotations: { summary: "Pod is crash looping" },
        startsAt: "2026-09-25T10:00:00Z",
        generatorURL: "http://prometheus/graph",
      },
    ]);
  });

  test("rejects a payload of another version", () => {
    expect(() =>
      parseWebhook({ ...webhook([webhookAlert()]), version: "3" }),
    ).toThrow();
  });

  test("rejects an alert without a fingerprint", () => {
    expect(() =>
      parseWebhook(webhook([webhookAlert({ fingerprint: "" })])),
    ).toThrow();
  });

  test("rejects an alert without an alertname label", () => {
    expect(() =>
      parseWebhook(webhook([webhookAlert({ labels: { namespace: "x" } })])),
    ).toThrow(/alertname/);
  });

  test("rejects non-object input", () => {
    expect(() => parseWebhook("not json")).toThrow();
    expect(() => parseWebhook(null)).toThrow();
  });
});

describe("parseApiAlerts", () => {
  const apiAlert = (state: string, fingerprint: string) => ({
    annotations: { description: "d" },
    endsAt: "2026-09-25T11:00:00Z",
    fingerprint,
    receivers: [{ name: "null" }],
    startsAt: "2026-09-25T10:00:00Z",
    status: { inhibitedBy: [], silencedBy: [], state },
    updatedAt: "2026-09-25T10:01:00Z",
    labels: { alertname: "HomelabNodeNotReady", node: "worker-1" },
  });

  test("keeps active alerts only", () => {
    const alerts = parseApiAlerts([
      apiAlert("active", "a1"),
      apiAlert("suppressed", "a2"),
    ]);
    expect(alerts.map((a) => a.fingerprint)).toEqual(["a1"]);
    expect(alerts[0]?.name).toBe("HomelabNodeNotReady");
    expect(alerts[0]?.generatorURL).toBeUndefined();
  });

  test("rejects a non-array body", () => {
    expect(() => parseApiAlerts({ alerts: [] })).toThrow();
  });
});

describe("groupAlerts", () => {
  const alert = (name: string, fingerprint: string, namespace?: string) => ({
    fingerprint,
    name,
    labels: {
      alertname: name,
      severity: "warning",
      ...(namespace ? { namespace } : {}),
    },
    annotations: {},
    startsAt: "2026-09-25T10:00:00Z",
  });

  test("groups by alertname and namespace and drops ignored names", () => {
    const groups = groupAlerts(
      [
        alert("KubePodCrashLooping", "1", "paperclip"),
        alert("KubePodCrashLooping", "2", "paperclip"),
        alert("KubePodCrashLooping", "3", "plex"),
        alert("Watchdog", "4"),
        alert("HomelabNodeNotReady", "5"),
      ],
      new Set(["Watchdog", "InfoInhibitor"]),
    );
    expect(groups.map((g) => [g.key, g.alerts.length])).toEqual([
      ["KubePodCrashLooping/paperclip", 2],
      ["KubePodCrashLooping/plex", 1],
      ["HomelabNodeNotReady/_cluster", 1],
    ]);
    expect(groups[0]?.severity).toBe("warning");
    expect(groups[2]?.namespace).toBeUndefined();
  });

  test("dedupes repeated fingerprints inside a group", () => {
    const groups = groupAlerts(
      [alert("A", "1", "ns"), alert("A", "1", "ns")],
      new Set(),
    );
    expect(groups[0]?.alerts.length).toBe(1);
  });
});
