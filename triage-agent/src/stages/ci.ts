import { z } from "zod";
import { prRecordSchema } from "./github.ts";
import type { StageDeps } from "./context.ts";
import { loopDecision } from "./loop.ts";

const LOG_TAIL_PER_RUN = 60_000;
const NO_CHECKS_GRACE_MS = 180_000;

const checksSchema = z.array(
  z.object({
    name: z.string(),
    bucket: z.string(),
    link: z.string().default(""),
  }),
);

export type Check = z.infer<typeof checksSchema>[number];
export type CiState = "green" | "red" | "pending" | "timeout";

export function classifyChecks(checks: readonly Check[]): CiState {
  if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) {
    return "red";
  }
  if (checks.some((c) => c.bucket === "pending")) return "pending";
  return "green";
}

export function runIdsOf(checks: readonly Check[]): string[] {
  const ids = checks
    .filter((c) => c.bucket === "fail" || c.bucket === "cancel")
    .map((c) => /\/actions\/runs\/(\d+)/.exec(c.link)?.[1])
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

async function readChecks(deps: StageDeps, pr: number): Promise<Check[]> {
  // gh pr checks exits non-zero while checks fail or are pending; the JSON is still printed.
  const result = await deps.exec([
    "gh",
    "pr",
    "checks",
    String(pr),
    "--repo",
    deps.config.REPO_SLUG,
    "--json",
    "name,bucket,link",
  ]);
  if (!result.stdout.trim().startsWith("[")) {
    if (/no checks reported/i.test(result.stderr)) return [];
    throw new Error(`gh pr checks failed: ${result.stderr.trim()}`);
  }
  return checksSchema.parse(JSON.parse(result.stdout));
}

/**
 * Stage 7, deterministic: poll the PR's checks until they settle or the
 * timeout passes. On red, the failing runs' logs go to ci.log for the fix loop.
 */
export async function ciWatchStage(deps: StageDeps): Promise<CiState> {
  const { config, work } = deps;
  const pr = prRecordSchema.parse(work.readJson("pr.json"));
  const start = deps.now();
  const deadline = start + config.CI_TIMEOUT_SECONDS * 1000;
  let state: CiState = "pending";
  let checks: Check[] = [];

  while (deps.now() < deadline) {
    checks = await readChecks(deps, pr.number);
    const settled =
      checks.length > 0 || deps.now() - start > NO_CHECKS_GRACE_MS;
    state = settled ? classifyChecks(checks) : "pending";
    if (state !== "pending") break;
    await deps.sleep(config.CI_POLL_SECONDS * 1000);
  }
  if (state === "pending") state = "timeout";

  if (state === "red") {
    const logs: string[] = [
      `failing checks: ${checks
        .filter((c) => c.bucket === "fail" || c.bucket === "cancel")
        .map((c) => c.name)
        .join(", ")}`,
    ];
    for (const id of runIdsOf(checks)) {
      const log = await deps.exec([
        "gh",
        "run",
        "view",
        id,
        "--repo",
        config.REPO_SLUG,
        "--log-failed",
      ]);
      logs.push(`--- run ${id} ---\n${log.stdout.slice(-LOG_TAIL_PER_RUN)}`);
    }
    work.write("ci.log", logs.join("\n"));
  }
  const next =
    state === "timeout"
      ? "exhausted"
      : loopDecision(state === "green", config.ATTEMPT, config.MAX_ATTEMPTS);
  work.writeJson("ci.json", { state, next, checks });
  work.output("ci-state", state);
  work.output("next", next);
  deps.logger.info({ pr: pr.number, state }, "CI settled");
  return state;
}
