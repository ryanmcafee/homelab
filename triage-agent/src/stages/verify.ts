import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Exec, must } from "../exec.ts";
import type { StageDeps } from "./context.ts";
import { type LoopDecision, loopDecision } from "./loop.ts";

const LOG_TAIL = 20_000;

export interface VerifyStep {
  name: string;
  cmd: string[];
  /** Regenerators rewrite files; checks only judge. */
  kind: "regenerate" | "check";
}

const task = (...args: string[]): string[] => ["task", ...args];

const touches = (files: readonly string[], ...prefixes: string[]) =>
  files.some((f) => prefixes.some((p) => f.startsWith(p)));

/** The repository's own checks for the files a fix changed, in run order. */
export function verifySteps(files: readonly string[]): VerifyStep[] {
  const steps: VerifyStep[] = [];
  const regen = (name: string, cmd: string[]) =>
    steps.push({ name, cmd, kind: "regenerate" });
  const check = (name: string, cmd: string[]) =>
    steps.push({ name, cmd, kind: "check" });

  if (touches(files, "configuration/")) {
    regen("localdev values", task("config:export:localdev"));
  }
  if (touches(files, "charts/", "configuration/")) {
    regen("golden snapshots", task("test:snapshot", "--", "--update"));
  }
  regen("docs counts", task("docs:check", "--", "--fix"));

  check("level 0", task("verify:text"));
  check("PII guard", task("config:guard"));
  if (
    touches(
      files,
      "scripts/",
      "package.json",
      "bun.lock",
      "biome.json",
      "tsconfig.json",
    )
  ) {
    check("scripts lint", task("scripts:lint"));
    check("scripts tests", task("test:scripts"));
  }
  if (touches(files, "triage-agent/")) {
    check("triage-agent lint", task("triage-agent:lint"));
    check("triage-agent tests", task("test:triage-agent"));
  }
  if (
    files.some((f) => f.endsWith(".go") || f === "go.mod" || f === "go.sum")
  ) {
    check("go tests", ["go", "test", "./..."]);
  }
  if (touches(files, "tests/policy/")) {
    check("policy tests", task("test:policy"));
  }
  return steps;
}

/** Files that differ from origin/<base>, committed or not, plus untracked ones. */
export async function changedFiles(
  run: Exec,
  repo: string,
  base: string,
): Promise<string[]> {
  const diff = await must(
    run,
    ["git", "diff", "--name-only", `origin/${base}`],
    {
      cwd: repo,
    },
  );
  const untracked = await must(
    run,
    ["git", "ls-files", "--others", "--exclude-standard"],
    { cwd: repo },
  );
  const all = `${diff}\n${untracked}`.split("\n").filter(Boolean);
  return [...new Set(all)].sort();
}

/** Installs the pinned toolchain from the repository's mise.toml (cached). */
export async function installToolchain(
  run: Exec,
  repo: string,
  tools: string,
): Promise<void> {
  // mise.toml loads .envrc, which only exists on workstations; keep the empty stand-in out of commits.
  const envrc = join(repo, ".envrc");
  if (!existsSync(envrc)) {
    writeFileSync(envrc, "");
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    appendFileSync(join(repo, ".git", "info", "exclude"), "\n/.envrc\n");
  }
  await must(run, ["mise", "trust", "--yes", join(repo, "mise.toml")], {
    cwd: repo,
  });
  await must(run, ["mise", "install", ...tools.split(/\s+/).filter(Boolean)], {
    cwd: repo,
  });
}

export interface VerifyResult {
  passed: boolean;
  next: LoopDecision;
  files: string[];
  failed: string[];
}

/**
 * Stage 4, deterministic: regenerate what the repository generates, then run
 * its checks. Check failures are a result (out/passed=false), not an error, so
 * the fix loop can feed verify.log back to the implement stage.
 */
export async function verifyStage(deps: StageDeps): Promise<VerifyResult> {
  const { exec, work, config } = deps;
  await installToolchain(exec, work.repo, config.MISE_TOOLS);
  const files = await changedFiles(exec, work.repo, config.BASE_BRANCH);
  const log: string[] = [`changed files:\n${files.join("\n") || "(none)"}\n`];
  const failed: string[] = [];

  for (const step of verifySteps(files)) {
    const result = await exec(["mise", "exec", "--", ...step.cmd], {
      cwd: work.repo,
    });
    const output = `${result.stdout}${result.stderr}`.slice(-LOG_TAIL);
    log.push(`$ ${step.cmd.join(" ")}\n${output}\n[exit ${result.code}]\n`);
    if (result.code !== 0) failed.push(step.name);
    deps.logger.info({ step: step.name, code: result.code }, "verify step");
  }

  const passed = failed.length === 0;
  const verdict: VerifyResult = {
    passed,
    next: loopDecision(passed, config.ATTEMPT, config.MAX_ATTEMPTS),
    files,
    failed,
  };
  work.write("verify.log", log.join("\n"));
  work.writeJson("verify.json", verdict);
  work.output("passed", verdict.passed);
  work.output("next", verdict.next);
  return verdict;
}
