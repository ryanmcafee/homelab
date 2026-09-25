import type { AlertGroup } from "./alerts.ts";

export type OfferResult = "queued" | "merged" | "running" | "cooldown" | "full";

export interface QueueOptions {
  cooldownMs: number;
  maxQueued?: number;
  now?: () => number;
  onError?: (group: AlertGroup, error: unknown) => void;
}

interface LastRun {
  at: number;
  fingerprints: ReadonlySet<string>;
}

/**
 * Serial triage queue: one run at a time, one pending entry per group key, and
 * a cooldown that skips a group again until a new fingerprint fires in it.
 */
export class TriageQueue {
  private readonly pending = new Map<string, AlertGroup>();
  private readonly lastRuns = new Map<string, LastRun>();
  private running: string | undefined;
  private worker: Promise<void> = Promise.resolve();
  private readonly maxQueued: number;
  private readonly now: () => number;

  constructor(
    private readonly run: (group: AlertGroup) => Promise<void>,
    private readonly options: QueueOptions,
  ) {
    this.maxQueued = options.maxQueued ?? 20;
    this.now = options.now ?? Date.now;
  }

  offer(group: AlertGroup): OfferResult {
    if (this.running === group.key) return "running";
    const waiting = this.pending.get(group.key);
    if (waiting) {
      this.pending.set(group.key, mergeGroups(waiting, group));
      return "merged";
    }
    if (this.inCooldown(group)) return "cooldown";
    if (this.pending.size >= this.maxQueued) return "full";
    this.pending.set(group.key, group);
    this.start();
    return "queued";
  }

  depth(): number {
    return this.pending.size;
  }

  idle(): Promise<void> {
    return this.worker;
  }

  private inCooldown(group: AlertGroup): boolean {
    this.pruneLastRuns();
    const last = this.lastRuns.get(group.key);
    if (!last) return false;
    return group.alerts.every((a) => last.fingerprints.has(a.fingerprint));
  }

  private pruneLastRuns(): void {
    const cutoff = this.now() - this.options.cooldownMs;
    for (const [key, last] of this.lastRuns) {
      if (last.at <= cutoff) this.lastRuns.delete(key);
    }
  }

  private start(): void {
    if (this.running !== undefined) return;
    this.worker = this.drain();
  }

  private async drain(): Promise<void> {
    for (let next = this.shift(); next; next = this.shift()) {
      this.running = next.key;
      try {
        await this.run(next);
      } catch (error) {
        this.options.onError?.(next, error);
      } finally {
        this.lastRuns.set(next.key, {
          at: this.now(),
          fingerprints: new Set(next.alerts.map((a) => a.fingerprint)),
        });
        this.running = undefined;
      }
    }
  }

  private shift(): AlertGroup | undefined {
    const first = this.pending.entries().next();
    if (first.done) return undefined;
    const [key, group] = first.value;
    this.pending.delete(key);
    return group;
  }
}

function mergeGroups(a: AlertGroup, b: AlertGroup): AlertGroup {
  const known = new Set(a.alerts.map((x) => x.fingerprint));
  return {
    ...a,
    alerts: [...a.alerts, ...b.alerts.filter((x) => !known.has(x.fingerprint))],
  };
}
