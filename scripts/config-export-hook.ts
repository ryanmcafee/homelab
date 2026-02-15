#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env

/**
 * config-export-hook.ts
 *
 * Pre-commit hook that re-exports configuration when config files change.
 * Runs `go run ./cmd/homelab config export --set homelab --all` to regenerate
 * local gitignored output files so they stay in sync with config sources.
 */

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** Run a shell command */
async function run(cmd: string[]): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await p.output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

async function main() {
  console.log(cyan("Exporting configuration..."));

  // Run config export
  const result = await run([
    "go",
    "run",
    "./cmd/homelab",
    "config",
    "export",
    "--set",
    "homelab",
    "--all",
  ]);

  if (!result.success) {
    console.error(red("ERROR: Config export failed"));
    if (result.stderr) console.error(red(result.stderr));
    Deno.exit(1);
  }

  if (result.stdout) console.log(result.stdout);

  console.log(green("Config exported successfully."));

  // Reminder about 1Password push
  console.log(
    yellow(
      "NOTE: If config values changed, remember to run 'task render:push' to sync with 1Password.",
    ),
  );
}

main().catch((err) => {
  console.error(red(`ERROR: ${err.message}`));
  Deno.exit(1);
});
