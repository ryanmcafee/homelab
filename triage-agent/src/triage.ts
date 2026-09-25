import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AlertGroup } from "./alerts.ts";

/** The fields of an SDK message this service reads. */
export interface AgentMessage {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  errors?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
}

export type QueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<AgentMessage>;

export interface TriageOptions {
  prompt: string;
  timeoutMs: number;
  sdkOptions: Options;
}

export interface Report {
  id: string;
  key: string;
  alertname: string;
  namespace?: string;
  severity?: string;
  fingerprints: string[];
  startedAt: string;
  finishedAt: string;
  status: "ok" | "error";
  text: string;
  costUsd: number;
  turns: number;
}

interface Outcome {
  status: Report["status"];
  text: string;
  costUsd: number;
  turns: number;
}

const asNumber = (v: unknown): number => (typeof v === "number" ? v : 0);

function outcomeOf(result: AgentMessage): Outcome {
  const costUsd = asNumber(result.total_cost_usd);
  const turns = asNumber(result.num_turns);
  if (
    result.subtype === "success" &&
    !result.is_error &&
    typeof result.result === "string"
  ) {
    return { status: "ok", text: result.result, costUsd, turns };
  }
  const errors = Array.isArray(result.errors) ? result.errors.join("; ") : "";
  const detail = typeof result.result === "string" ? result.result : errors;
  return {
    status: "error",
    text: `triage ended with ${result.subtype ?? "unknown"}: ${detail}`,
    costUsd,
    turns,
  };
}

async function collect(
  messages: AsyncIterable<AgentMessage>,
): Promise<AgentMessage | undefined> {
  let result: AgentMessage | undefined;
  for await (const message of messages) {
    if (message.type === "result") result = message;
  }
  return result;
}

export async function runTriage(
  group: AlertGroup,
  options: TriageOptions,
  query: QueryFn,
  now: () => Date = () => new Date(),
): Promise<Report> {
  const startedAt = now().toISOString();
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, options.timeoutMs);

  let outcome: Outcome;
  try {
    const result = await collect(
      query({
        prompt: options.prompt,
        options: { ...options.sdkOptions, abortController },
      }),
    );
    outcome = result
      ? outcomeOf(result)
      : {
          status: "error",
          text: "triage ended with no result message",
          costUsd: 0,
          turns: 0,
        };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome = {
      status: "error",
      text: timedOut
        ? `triage timed out after ${options.timeoutMs} ms`
        : `triage failed: ${message}`,
      costUsd: 0,
      turns: 0,
    };
  } finally {
    clearTimeout(timer);
  }

  return {
    id: crypto.randomUUID(),
    key: group.key,
    alertname: group.alertname,
    ...(group.namespace ? { namespace: group.namespace } : {}),
    ...(group.severity ? { severity: group.severity } : {}),
    fingerprints: group.alerts.map((a) => a.fingerprint),
    startedAt,
    finishedAt: now().toISOString(),
    ...outcome,
  };
}

export class ReportStore {
  private readonly reports: Report[] = [];

  constructor(private readonly capacity: number) {}

  add(report: Report): void {
    this.reports.unshift(report);
    this.reports.length = Math.min(this.reports.length, this.capacity);
  }

  list(): readonly Report[] {
    return this.reports;
  }
}
