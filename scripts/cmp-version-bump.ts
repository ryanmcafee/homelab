#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * cmp-version-bump.ts
 *
 * Auto-bumps the CMP image patch version when CMP-related files are staged.
 * Intended for use as a pre-commit hook or manual invocation.
 *
 * Checks staged files — skips if no CMP-related files are staged.
 * Reads current version from configuration/versions.yaml.
 * Increments patch: 0.1.0 -> 0.1.1
 * Updates versions.yaml and hardcoded CMP image tags.
 * Stages all modified files.
 */

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

/** Run a shell command and return stdout */
async function run(cmd: string[]): Promise<string> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await p.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`Command failed: ${cmd.join(" ")}\n${stderr}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

/** Check if any CMP-related files are staged (excluding versions.yaml itself) */
async function hasStagedCmpFiles(): Promise<boolean> {
  const staged = await run(["git", "diff", "--cached", "--name-only"]);
  if (!staged) return false;

  const cmpPrefixes = ["cmd/", "internal/", "cmp/", "Dockerfile.cmp", "configuration/"];
  const excludeFiles = ["configuration/versions.yaml"];

  return staged.split("\n").some((file) => {
    if (excludeFiles.includes(file)) return false;
    return cmpPrefixes.some((prefix) => file.startsWith(prefix));
  });
}

/** Read current CMP version from versions.yaml */
async function readCurrentVersion(): Promise<string> {
  return await run(["yq", ".images.homelab-cmp", "configuration/versions.yaml"]);
}

/** Increment patch version: 0.1.0 -> 0.1.1 */
function bumpPatch(version: string): string {
  const parts = version.replace(/^"/, "").replace(/"$/, "").split(".");
  if (parts.length !== 3) throw new Error(`Invalid semver: ${version}`);
  parts[2] = String(parseInt(parts[2], 10) + 1);
  return parts.join(".");
}

/** Update CMP image version in a file using sed-like replacement */
async function updateFileVersion(
  filePath: string,
  oldVersion: string,
  newVersion: string,
): Promise<boolean> {
  try {
    const content = await Deno.readTextFile(filePath);
    const pattern = `ghcr.io/ryanmcafee/homelab-cmp:${oldVersion}`;
    const replacement = `ghcr.io/ryanmcafee/homelab-cmp:${newVersion}`;
    if (!content.includes(pattern)) return false;
    const updated = content.replaceAll(pattern, replacement);
    await Deno.writeTextFile(filePath, updated);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Check for --force flag (skip staged file check)
  const force = Deno.args.includes("--force");

  if (!force) {
    const hasCmpChanges = await hasStagedCmpFiles();
    if (!hasCmpChanges) {
      console.log(cyan("INFO: No CMP-related files staged, skipping version bump."));
      Deno.exit(0);
    }
  }

  const currentVersion = await readCurrentVersion();
  const newVersion = bumpPatch(currentVersion);

  console.log(cyan(`CMP version bump: ${currentVersion} -> ${newVersion}`));

  // Update versions.yaml
  await run([
    "yq",
    "-i",
    `.images.homelab-cmp = "${newVersion}"`,
    "configuration/versions.yaml",
  ]);

  // Update hardcoded CMP image tags in chart files
  const filesToUpdate = [
    "charts/bootstrap/values.yaml",
    "charts/addons/values.yaml",
    "charts/applications/values.yaml",
  ];

  const updatedFiles = ["configuration/versions.yaml"];
  for (const file of filesToUpdate) {
    const updated = await updateFileVersion(file, currentVersion, newVersion);
    if (updated) {
      updatedFiles.push(file);
    }
  }

  // Stage all modified files
  if (updatedFiles.length > 0) {
    await run(["git", "add", ...updatedFiles]);
  }

  console.log(green(`CMP version bumped: ${currentVersion} -> ${newVersion}`));
  console.log(cyan(`Staged files: ${updatedFiles.join(", ")}`));
}

main().catch((err) => {
  console.error(red(`ERROR: ${err.message}`));
  Deno.exit(1);
});
