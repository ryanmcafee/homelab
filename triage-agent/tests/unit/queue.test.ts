import { describe, expect, test } from "bun:test";
import type { AlertGroup } from "../../src/alerts.ts";
import { TriageQueue } from "../../src/intake/queue.ts";

const group = (key: string, ...fingerprints: string[]): AlertGroup => ({
  key,
  alertname: key.split("/")[0] ?? key,
  alerts: fingerprints.map((fingerprint) => ({
    fingerprint,
    name: key,
    labels: { alertname: key },
    annotations: {},
    startsAt: "2026-09-25T10:00:00Z",
  })),
});

function deferred() {
  let release = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { done, release };
}

describe("TriageQueue", () => {
  test("runs one triage at a time in arrival order", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const queue = new TriageQueue(
      async (g) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(g.key);
        await Bun.sleep(5);
        active--;
      },
      { cooldownMs: 60_000 },
    );
    expect(queue.offer(group("A/ns", "1"))).toBe("queued");
    expect(queue.offer(group("B/ns", "2"))).toBe("queued");
    await queue.idle();
    expect(order).toEqual(["A/ns", "B/ns"]);
    expect(maxActive).toBe(1);
  });

  test("merges new fingerprints into a group that is still waiting", async () => {
    const gate = deferred();
    const seen: string[][] = [];
    const queue = new TriageQueue(
      async (g) => {
        seen.push(g.alerts.map((a) => a.fingerprint));
        await gate.done;
      },
      { cooldownMs: 60_000 },
    );
    queue.offer(group("A/ns", "1"));
    queue.offer(group("B/ns", "2"));
    expect(queue.offer(group("B/ns", "2", "3"))).toBe("merged");
    expect(queue.offer(group("A/ns", "1"))).toBe("running");
    gate.release();
    await queue.idle();
    expect(seen).toEqual([["1"], ["2", "3"]]);
  });

  test("skips a group inside its cooldown unless a new fingerprint fires", async () => {
    let now = 0;
    const runs: string[] = [];
    const queue = new TriageQueue(
      async (g) => {
        runs.push(g.alerts.map((a) => a.fingerprint).join(","));
      },
      { cooldownMs: 1000, now: () => now },
    );
    queue.offer(group("A/ns", "1"));
    await queue.idle();
    now = 500;
    expect(queue.offer(group("A/ns", "1"))).toBe("cooldown");
    expect(queue.offer(group("A/ns", "1", "2"))).toBe("queued");
    await queue.idle();
    now = 2000;
    expect(queue.offer(group("A/ns", "1", "2"))).toBe("queued");
    await queue.idle();
    expect(runs).toEqual(["1", "1,2", "1,2"]);
  });

  test("refuses groups beyond maxQueued", async () => {
    const gate = deferred();
    const queue = new TriageQueue(() => gate.done, {
      cooldownMs: 0,
      maxQueued: 1,
    });
    queue.offer(group("A/ns", "1"));
    queue.offer(group("B/ns", "2"));
    expect(queue.offer(group("C/ns", "3"))).toBe("full");
    expect(queue.depth()).toBe(1);
    gate.release();
    await queue.idle();
  });

  test("keeps going after a triage run throws", async () => {
    const runs: string[] = [];
    const errors: unknown[] = [];
    const queue = new TriageQueue(
      async (g) => {
        runs.push(g.key);
        if (g.key === "A/ns") throw new Error("boom");
      },
      { cooldownMs: 0, onError: (_g, e) => errors.push(e) },
    );
    queue.offer(group("A/ns", "1"));
    queue.offer(group("B/ns", "2"));
    await queue.idle();
    expect(runs).toEqual(["A/ns", "B/ns"]);
    expect(errors.length).toBe(1);
  });
});
