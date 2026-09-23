#!/usr/bin/env bun

import { stat } from "node:fs/promises";
import { isNotFound } from "./lib/errors.ts";

/**
 * config-export-hook.ts
 *
 * Pre-commit hook that re-exports configuration when config files change.
 *
 * Step 1 (always): regenerate the committed, PII-free localdev values
 *   `charts/addons/values-localdev.yaml` and
 *   `charts/applications/values-localdev.yaml` via
 *   `go run ./cmd/homelab config export --set localdev --format helm-addons|helm-apps`.
 *   Level 0 checks them (`render/localdev/_committed-values`) and fails when
 *   they are stale, so the hook keeps them in sync with configuration/.
 *
 * Step 2 (when configuration/environments/homelab.yaml exists): run
 *   `go run ./cmd/homelab config export --set homelab --all` to regenerate the
 *   gitignored homelab preview outputs. The homelab environment file is PII
 *   and gitignored, so a clone without it warns and skips this step.
 */

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** Run a shell command */
async function run(
  cmd: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const p = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return {
    success: code === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

/** Run `homelab config export` with the given arguments; exit 1 on failure. */
async function configExport(label: string, args: string[]): Promise<void> {
  const result = await run([
    "go",
    "run",
    "./cmd/homelab",
    "config",
    "export",
    ...args,
  ]);

  if (!result.success) {
    console.error(red(`ERROR: Config export failed (${label})`));
    if (result.stderr) console.error(red(result.stderr));
    process.exit(1);
  }

  if (result.stdout) console.log(result.stdout);
}

async function exportLocaldev(): Promise<void> {
  // These files are committed and contain no PII, so they never depend on the
  // gitignored homelab.yaml and are regenerated on every run.
  console.log(cyan("Exporting localdev values..."));

  await configExport("localdev helm-addons", [
    "--set",
    "localdev",
    "--format",
    "helm-addons",
  ]);
  await configExport("localdev helm-apps", [
    "--set",
    "localdev",
    "--format",
    "helm-apps",
  ]);

  console.log(
    green(
      "Regenerated charts/addons/values-localdev.yaml and charts/applications/values-localdev.yaml",
    ),
  );
}

async function exportHomelab(): Promise<void> {
  // The homelab environment file is gitignored (PII). In a clone without it
  // (fresh checkout, worktree, CI) there is nothing to export: warn and skip
  // instead of failing the commit. Level-0 verification covers the same
  // templates with homelab.yaml.example.
  const envFile = "configuration/environments/homelab.yaml";
  try {
    await stat(envFile);
  } catch (err) {
    if (isNotFound(err)) {
      console.log(
        yellow(
          `WARN: ${envFile} not found; skipping homelab config export (nothing to regenerate)`,
        ),
      );
      return;
    }
    throw err;
  }

  console.log(cyan("Exporting homelab configuration..."));

  await configExport("homelab --all", ["--set", "homelab", "--all"]);

  console.log(green("Homelab config exported successfully."));

  // Reminder about 1Password push
  console.log(
    yellow(
      "NOTE: If config values changed, remember to run 'task render:push' to sync with 1Password.",
    ),
  );
}

async function main() {
  await exportLocaldev();
  await exportHomelab();
}

main().catch((err) => {
  console.error(red(`ERROR: ${err.message}`));
  process.exit(1);
});
