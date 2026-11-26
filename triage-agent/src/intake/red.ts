/**
 * The RED metric family and build info of contracts/observability/metrics.v1.yaml
 * (docs/contracts/metric-contract.md).
 */

export const REQUEST_DURATION = "platform_request_duration_seconds";
export const BUILD_INFO = "platform_build_info";
export const UNMATCHED_ROUTE = "__other__";

export const BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30,
] as const;

const LE_VALUES = [...BUCKETS.map(String), "+Inf"];

export type Kind = "http" | "pubsub" | "request_reply" | "stream";
export type ErrorCode =
  | "internal"
  | "unavailable"
  | "timeout"
  | "throttled"
  | "quota";
export type Outcome =
  | { outcome: "success" }
  | { outcome: "error"; code: ErrorCode };
export type Observation = { kind: Kind; route: string } & Outcome;

export interface BuildIdentity {
  service: string;
  environment: string;
  tenant: string;
  version: string;
  revision: string;
}

interface Series {
  labels: string;
  buckets: number[];
  sum: number;
  count: number;
}

const formatLabels = (pairs: [string, string][]) =>
  pairs.map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "\\$&")}"`).join(",");

export class RedMetrics {
  private readonly series = new Map<string, Series>();

  constructor(private readonly identity: BuildIdentity) {}

  observe(observation: Observation, seconds: number): void {
    const { service, environment, tenant } = this.identity;
    const labels = formatLabels([
      ["service", service],
      ["environment", environment],
      ["tenant", tenant],
      ["kind", observation.kind],
      ["route", observation.route],
      ["outcome", observation.outcome],
      ...(observation.outcome === "error"
        ? [["code", observation.code] satisfies [string, string]]
        : []),
    ]);
    const series = this.series.get(labels) ?? {
      labels,
      buckets: BUCKETS.map(() => 0),
      sum: 0,
      count: 0,
    };
    BUCKETS.forEach((bound, i) => {
      if (seconds <= bound) series.buckets[i] = (series.buckets[i] ?? 0) + 1;
    });
    series.sum += seconds;
    series.count += 1;
    this.series.set(labels, series);
  }

  render(): string {
    const histogram = [...this.series.values()].flatMap((s) => [
      ...[...s.buckets, s.count].map(
        (n, i) =>
          `${REQUEST_DURATION}_bucket{${s.labels},le="${LE_VALUES[i]}"} ${n}`,
      ),
      `${REQUEST_DURATION}_sum{${s.labels}} ${s.sum}`,
      `${REQUEST_DURATION}_count{${s.labels}} ${s.count}`,
    ]);
    const { service, environment, version, revision } = this.identity;
    return [
      `# HELP ${REQUEST_DURATION} Duration of one served request or one handled bus message, in seconds.`,
      `# TYPE ${REQUEST_DURATION} histogram`,
      ...histogram,
      `# HELP ${BUILD_INFO} Always 1. Carries the build identity that must never be a label on the RED family.`,
      `# TYPE ${BUILD_INFO} gauge`,
      `${BUILD_INFO}{${formatLabels([
        ["service", service],
        ["environment", environment],
        ["version", version],
        ["revision", revision],
      ])}} 1`,
      "",
    ].join("\n");
  }
}
