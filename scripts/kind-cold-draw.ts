#!/usr/bin/env bun

/**
 * kind-cold-draw.ts
 *
 * Guards and evidence capture for .github/workflows/kind-cold-draw.yml, the
 * exact-head cold-cache Kind draw that chases the intermittent argocd-redis
 * ImagePullBackOff (MCAA-852). Self-contained on purpose: the draw job copies
 * this one file out of the workflow's ref and runs it against a checkout of a
 * different commit.
 *
 * Subcommands:
 *   resolve-head --pr <n> --live <sha>
 *               Fail unless <n> is an allowed draw target and <sha> (the PR's
 *               live head) equals the SHA the draw was approved for. Prints the
 *               SHA and writes `sha=` / `pr=` to $GITHUB_OUTPUT when set.
 *   assert-cold --dir <path>
 *               Fail when <path> exists and is not empty: a warm registry cache
 *               would turn the Redis pull into a local read.
 *   capture --out <dir> [--context <ctx>] [--namespace <ns>] [--registry <name>]
 *               Write the Redis pod, its describe, namespace events and the
 *               registry proxy log into <dir>, plus summary.json/summary.md.
 *               Anything absent is recorded in summary.json `missing`. Always
 *               exits 0 so it never masks the step that failed.
 *   verdict --dir <dir> --argocd <outcome> --sync <outcome> --wait <outcome>
 *               Classify the draw from <dir>/summary.json and the cluster step
 *               outcomes. Exits 0 when the draw reproduced the Redis pull
 *               failure or ran clean; exits 1 on incomplete evidence or a
 *               cluster failure that is not the Redis pull. Writes verdict.json.
 *
 * Exit codes: 0 = success; 1 = guard failed; 2 = argument error.
 */

import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { join } from "node:path";

export const ALLOWED_DRAWS: Readonly<Record<string, string>> = {
  "487": "aa8d475f8db5ff9310e62e697adc776d2147e084",
  "536": "427cd3d5fc85a28ee7b3d15c39f84fe02ff147f3",
};

export const DEFAULT_CONTEXT = "kind-homelab-localdev";
export const DEFAULT_NAMESPACE = "argocd";
export const DEFAULT_REGISTRY = "kind-registry-ecr";
export const REDIS_SELECTOR = "app.kubernetes.io/name=argocd-redis";

export class GuardError extends Error {
  override name = "GuardError";
}

export class UsageError extends Error {
  override name = "UsageError";
}

// ============================================================================
// resolve-head
// ============================================================================
export function normalizePr(raw: string): string {
  return raw
    .trim()
    .replace(/^kind-cold-draw-/, "")
    .replace(/^#/, "");
}

export function checkHead(rawPr: string, liveSha: string): string {
  const pr = normalizePr(rawPr);
  const allowed = ALLOWED_DRAWS[pr];
  if (allowed === undefined) {
    throw new GuardError(
      `PR "${rawPr}" is not an allowed draw target; allowed: ${Object.keys(
        ALLOWED_DRAWS,
      )
        .map((n) => `#${n}`)
        .join(", ")}`,
    );
  }
  const live = liveSha.trim();
  if (live !== allowed) {
    throw new GuardError(
      `PR #${pr} head changed: allowed ${allowed}, live ${live || "<empty>"}. This draw does not count; re-approve the new SHA before drawing.`,
    );
  }
  return allowed;
}

// ============================================================================
// assert-cold
// ============================================================================
export async function assertCold(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      return `${dir} is absent: cache is cold`;
    }
    throw e;
  }
  if (entries.length > 0) {
    throw new GuardError(
      `${dir} is not empty (${entries.slice(0, 10).join(", ")}): a registry cache was restored, so this draw would not be cold`,
    );
  }
  return `${dir} exists and is empty: cache is cold`;
}

// ============================================================================
// capture
// ============================================================================
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const COMMAND_TIMEOUT_MS = 10_000;

export function run(cmd: string[], timeoutMs = COMMAND_TIMEOUT_MS): RunResult {
  try {
    const p = Bun.spawnSync(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return {
      code: p.exitedDueToTimeout ? 124 : (p.exitCode ?? 1),
      stdout: p.stdout.toString(),
      stderr: p.exitedDueToTimeout
        ? `timed out after ${timeoutMs} ms: ${cmd.join(" ")}`
        : p.stderr.toString(),
    };
  } catch (e) {
    return {
      code: 127,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function field(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function items(v: unknown): unknown[] {
  const list = field(v, "items");
  return Array.isArray(list) ? list : [];
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface RedisEvent {
  reason: string;
  message: string;
  count: number;
  lastTimestamp: string;
}

export interface RedisSummary {
  pod: string | null;
  podCount: number;
  phase: string | null;
  image: string | null;
  imageID: string | null;
  ready: boolean | null;
  waitingReason: string | null;
  restartCount: number | null;
  pullEvents: RedisEvent[];
  failureEvents: RedisEvent[];
  missing: string[];
}

const PULL_REASONS = new Set(["Pulling", "Pulled"]);
const FAILURE_REASONS = new Set([
  "Failed",
  "BackOff",
  "ErrImagePull",
  "ImagePullBackOff",
]);

function toEvent(e: unknown): RedisEvent {
  return {
    reason: str(field(e, "reason")) ?? "",
    message: str(field(e, "message")) ?? "",
    count:
      typeof field(e, "count") === "number" ? Number(field(e, "count")) : 1,
    lastTimestamp:
      str(field(e, "lastTimestamp")) ?? str(field(e, "eventTime")) ?? "",
  };
}

export function summarize(
  podsJson: unknown,
  eventsJson: unknown,
): RedisSummary {
  const pods = items(podsJson);
  const missing: string[] = [];
  const pod = pods[0];
  const podName = str(field(pod, "metadata", "name")) ?? null;
  if (podName === null) {
    missing.push(`redis pod: no pod matched ${REDIS_SELECTOR}`);
  }
  const statuses = field(pod, "status", "containerStatuses");
  const redis = Array.isArray(statuses)
    ? statuses.find((c) => str(field(c, "name")) === "redis")
    : undefined;
  if (podName !== null && redis === undefined) {
    missing.push(
      `redis container: pod ${podName} reports no containerStatus named redis`,
    );
  }
  const specContainers = field(pod, "spec", "containers");
  const specImage = Array.isArray(specContainers)
    ? str(
        field(
          specContainers.find((c) => str(field(c, "name")) === "redis"),
          "image",
        ),
      )
    : undefined;
  const podEvents = items(eventsJson)
    .filter(
      (e) =>
        podName !== null && str(field(e, "involvedObject", "name")) === podName,
    )
    .map(toEvent);
  return {
    pod: podName,
    podCount: pods.length,
    phase: str(field(pod, "status", "phase")) ?? null,
    image: str(field(redis, "image")) ?? specImage ?? null,
    imageID: str(field(redis, "imageID")) || null,
    ready:
      typeof field(redis, "ready") === "boolean"
        ? field(redis, "ready") === true
        : null,
    waitingReason: str(field(redis, "state", "waiting", "reason")) ?? null,
    restartCount:
      typeof field(redis, "restartCount") === "number"
        ? Number(field(redis, "restartCount"))
        : null,
    pullEvents: podEvents.filter((e) => PULL_REASONS.has(e.reason)),
    failureEvents: podEvents.filter((e) => FAILURE_REASONS.has(e.reason)),
    missing,
  };
}

export function renderMarkdown(s: RedisSummary): string {
  const row = (k: string, v: unknown) =>
    `| ${k} | ${v === null || v === undefined ? "-" : String(v)} |`;
  const events = (title: string, list: RedisEvent[]) =>
    list.length === 0
      ? [`**${title}:** none recorded`]
      : [
          `**${title}:**`,
          "",
          ...list.map(
            (e) =>
              `- \`${e.reason}\` x${e.count} ${e.lastTimestamp}: ${e.message}`,
          ),
        ];
  return [
    "| Field | Value |",
    "|---|---|",
    row("Redis pod", s.pod),
    row("Pods matched", s.podCount),
    row("Phase", s.phase),
    row("Image", s.image),
    row("Image ID", s.imageID),
    row("Ready", s.ready),
    row("Waiting reason", s.waitingReason),
    row("Restarts", s.restartCount),
    "",
    ...events("Pull events (timing)", s.pullEvents),
    "",
    ...events("Failure events", s.failureEvents),
    "",
    ...(s.missing.length === 0
      ? ["**Missing evidence:** none"]
      : ["**Missing evidence:**", "", ...s.missing.map((m) => `- ${m}`)]),
    "",
  ].join("\n");
}

export interface CaptureOptions {
  out: string;
  context: string;
  namespace: string;
  registry: string;
}

function commandText(label: string, cmd: string[], r: RunResult): string {
  return [
    `$ ${cmd.join(" ")}`,
    `# ${label}: exit ${r.code}`,
    r.stdout,
    r.stderr,
  ].join("\n");
}

export async function capture(
  opts: CaptureOptions,
  runCommand: (cmd: string[]) => RunResult = run,
): Promise<RedisSummary> {
  await mkdir(opts.out, { recursive: true });
  const kubectl = ["kubectl", "--context", opts.context, "-n", opts.namespace];
  const record = async (
    file: string,
    label: string,
    cmd: string[],
  ): Promise<RunResult> => {
    const r = runCommand(cmd);
    await writeFile(join(opts.out, file), commandText(label, cmd, r));
    return r;
  };

  const pods = runCommand([
    ...kubectl,
    "get",
    "pods",
    "-l",
    REDIS_SELECTOR,
    "-o",
    "json",
  ]);
  await writeFile(
    join(opts.out, "redis-pods.json"),
    pods.code === 0
      ? pods.stdout
      : commandText(
          "get redis pods",
          [...kubectl, "get", "pods", "-l", REDIS_SELECTOR, "-o", "json"],
          pods,
        ),
  );
  await record("redis-pods-wide.txt", "get redis pods", [
    ...kubectl,
    "get",
    "pods",
    "-l",
    REDIS_SELECTOR,
    "-o",
    "wide",
  ]);
  const events = runCommand([...kubectl, "get", "events", "-o", "json"]);
  await writeFile(
    join(opts.out, "argocd-events.json"),
    events.code === 0
      ? events.stdout
      : commandText(
          "get events",
          [...kubectl, "get", "events", "-o", "json"],
          events,
        ),
  );
  await record("argocd-events.txt", "argocd namespace events", [
    ...kubectl,
    "get",
    "events",
    "--sort-by=.lastTimestamp",
  ]);

  const summary = summarize(parseJson(pods.stdout), parseJson(events.stdout));
  if (pods.code !== 0) {
    summary.missing.push(
      `redis pod: kubectl get pods exited ${pods.code}: ${pods.stderr.trim()}`,
    );
  }
  if (events.code !== 0) {
    summary.missing.push(
      `argocd events: kubectl get events exited ${events.code}: ${events.stderr.trim()}`,
    );
  }
  if (summary.pod !== null) {
    const d = await record("redis-describe.txt", "describe redis pod", [
      ...kubectl,
      "describe",
      "pod",
      summary.pod,
    ]);
    if (d.code !== 0)
      summary.missing.push(
        `redis describe: exited ${d.code}: ${d.stderr.trim()}`,
      );
  } else {
    await writeFile(
      join(opts.out, "redis-describe.txt"),
      `MISSING: no pod matched ${REDIS_SELECTOR} in ${opts.namespace} (context ${opts.context})\n`,
    );
  }

  const logs = await record(`${opts.registry}.log`, "registry proxy log", [
    "docker",
    "logs",
    "--timestamps",
    opts.registry,
  ]);
  if (logs.code !== 0) {
    summary.missing.push(
      `container ${opts.registry}: docker logs exited ${logs.code}: ${logs.stderr.trim()}`,
    );
  }
  await record("docker-ps.txt", "docker containers", ["docker", "ps", "-a"]);

  await writeFile(
    join(opts.out, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await writeFile(join(opts.out, "summary.md"), renderMarkdown(summary));
  return summary;
}

// ============================================================================
// verdict
// ============================================================================
export interface StepOutcomes {
  argocd: string;
  sync: string;
  wait: string;
}

export type VerdictKind =
  | "reproduced"
  | "recovered"
  | "not-reproduced"
  | "incomplete-evidence"
  | "other-failure";

export interface Verdict {
  kind: VerdictKind;
  pass: boolean;
  reason: string;
}

const PULL_FAILURE_WAITING = new Set(["ErrImagePull", "ImagePullBackOff"]);
const PULL_FAILURE_MESSAGE =
  /ErrImagePull|ImagePullBackOff|Failed to pull image/;

export function redisPullFailed(s: RedisSummary): boolean {
  return (
    (s.waitingReason !== null && PULL_FAILURE_WAITING.has(s.waitingReason)) ||
    s.failureEvents.some((e) => PULL_FAILURE_MESSAGE.test(e.message))
  );
}

export function classify(s: RedisSummary, steps: StepOutcomes): Verdict {
  if (s.missing.length > 0) {
    return {
      kind: "incomplete-evidence",
      pass: false,
      reason: `evidence is incomplete: ${s.missing.join("; ")}`,
    };
  }
  const failed = Object.entries(steps)
    .filter(([, outcome]) => outcome !== "success")
    .map(([name, outcome]) => `localdev:${name}=${outcome || "<none>"}`);
  const pullFailed = redisPullFailed(s);
  if (failed.length > 0) {
    return pullFailed
      ? {
          kind: "reproduced",
          pass: true,
          reason: `Redis pull failure reproduced (${failed.join(", ")}; waiting ${s.waitingReason ?? "-"})`,
        }
      : {
          kind: "other-failure",
          pass: false,
          reason: `${failed.join(", ")} but Redis shows no pull failure (waiting ${s.waitingReason ?? "-"}, ready ${String(s.ready)})`,
        };
  }
  if (s.ready !== true) {
    return {
      kind: "other-failure",
      pass: false,
      reason: `every cluster step succeeded but Redis is not ready (phase ${s.phase ?? "-"}, waiting ${s.waitingReason ?? "-"})`,
    };
  }
  return pullFailed
    ? {
        kind: "recovered",
        pass: true,
        reason:
          "Redis pull failed at least once, then recovered before localdev:wait finished",
      }
    : {
        kind: "not-reproduced",
        pass: true,
        reason: "Redis pulled and became ready; the failure did not recur",
      };
}

export function isRedisSummary(v: unknown): v is RedisSummary {
  return (
    isRecord(v) &&
    Array.isArray(v.missing) &&
    Array.isArray(v.failureEvents) &&
    "waitingReason" in v &&
    "ready" in v
  );
}

export async function readSummary(dir: string): Promise<RedisSummary> {
  const file = join(dir, "summary.json");
  const parsed = parseJson(await readFile(file, "utf8"));
  if (!isRedisSummary(parsed)) {
    throw new GuardError(`${file} is not a capture summary`);
  }
  return parsed;
}

// ============================================================================
// CLI
// ============================================================================
export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      throw new UsageError(
        `expected --flag value pairs, got: ${args.join(" ")}`,
      );
    }
    flags[key.slice(2)] = value;
  }
  return flags;
}

function required(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (v === undefined) throw new UsageError(`--${name} is required`);
  return v;
}

async function writeOutputs(pairs: Record<string, string>): Promise<void> {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  await appendFile(
    file,
    Object.entries(pairs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
}

async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    const flags = parseFlags(rest);
    switch (sub) {
      case "resolve-head": {
        const pr = required(flags, "pr");
        const sha = checkHead(pr, required(flags, "live"));
        console.log(
          `OK    PR #${normalizePr(pr)} live head matches the allowed SHA ${sha}`,
        );
        await writeOutputs({ sha, pr: normalizePr(pr) });
        return 0;
      }
      case "assert-cold":
        console.log(`OK    ${await assertCold(required(flags, "dir"))}`);
        return 0;
      case "capture": {
        const summary = await capture({
          out: required(flags, "out"),
          context: flags.context ?? DEFAULT_CONTEXT,
          namespace: flags.namespace ?? DEFAULT_NAMESPACE,
          registry: flags.registry ?? DEFAULT_REGISTRY,
        });
        console.log(renderMarkdown(summary));
        return 0;
      }
      case "verdict": {
        const dir = required(flags, "dir");
        const verdict = classify(await readSummary(dir), {
          argocd: required(flags, "argocd"),
          sync: required(flags, "sync"),
          wait: required(flags, "wait"),
        });
        await writeFile(
          join(dir, "verdict.json"),
          `${JSON.stringify(verdict, null, 2)}\n`,
        );
        const line = `${verdict.kind}: ${verdict.reason}`;
        console.log(verdict.pass ? `::notice::${line}` : `::error::${line}`);
        return verdict.pass ? 0 : 1;
      }
      default:
        throw new UsageError(
          `unknown subcommand "${sub ?? ""}"; expected resolve-head, assert-cold, capture or verdict`,
        );
    }
  } catch (e) {
    if (e instanceof GuardError) {
      console.error(`::error::${e.message}`);
      return 1;
    }
    if (e instanceof UsageError) {
      console.error(`ERROR ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
