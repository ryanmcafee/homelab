#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";

/**
 * cmp-version-bump.ts
 *
 * Auto-bumps the CMP image patch version when CMP-related files are staged.
 * Intended for use as a pre-commit hook or manual invocation.
 *
 * Checks staged files — skips if no CMP-related files are staged, or if the
 * tag already differs from HEAD (the bump for this commit happened on an
 * earlier pre-commit pass, so a second pass must not bump again).
 * Reads current version from configuration/versions.yaml.
 * Increments patch: 0.1.0 -> 0.1.1
 * Updates versions.yaml and hardcoded CMP image tags.
 * Re-exports the committed localdev parent values (the tag is part of them)
 * and regenerates the golden snapshots, then stages all modified files.
 */

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

/** Run a shell command and return stdout */
async function run(cmd: string[]): Promise<string> {
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
  if (code !== 0) {
    throw new Error(`Command failed: ${cmd.join(" ")}\n${stderr}`);
  }
  return stdout.trim();
}

/** Check if any CMP-related files are staged (excluding versions.yaml itself) */
async function hasStagedCmpFiles(): Promise<boolean> {
  const staged = await run(["git", "diff", "--cached", "--name-only"]);
  if (!staged) return false;

  const cmpPrefixes = ["cmd/", "internal/", "cmp/", "Dockerfile.cmp"];
  const excludeFiles = ["configuration/versions.yaml"];

  return staged.split("\n").some((file) => {
    if (excludeFiles.includes(file)) return false;
    return cmpPrefixes.some((prefix) => file.startsWith(prefix));
  });
}

/** Read current CMP version from versions.yaml */
async function readCurrentVersion(): Promise<string> {
  return await run([
    "yq",
    ".images.homelab-cmp",
    "configuration/versions.yaml",
  ]);
}

/**
 * Read the CMP version committed at HEAD, or null when there is none (fresh
 * repository). Used to detect a bump that already happened for this commit.
 */
async function readHeadVersion(): Promise<string | null> {
  try {
    const head = await run(["git", "show", "HEAD:configuration/versions.yaml"]);
    const p = Bun.spawn(["yq", ".images.homelab-cmp", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    p.stdin.write(head);
    await p.stdin.end();
    const [stdout, , code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) return null;
    return stdout.trim();
  } catch {
    return null;
  }
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
    const content = await readFile(filePath, "utf8");
    const pattern = `ghcr.io/ryanmcafee/homelab-cmp:${oldVersion}`;
    const replacement = `ghcr.io/ryanmcafee/homelab-cmp:${newVersion}`;
    if (!content.includes(pattern)) return false;
    const updated = content.replaceAll(pattern, replacement);
    await writeFile(filePath, updated);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Check for --force flag (skip staged file check)
  const force = process.argv.slice(2).includes("--force");

  if (!force) {
    const hasCmpChanges = await hasStagedCmpFiles();
    if (!hasCmpChanges) {
      console.log(
        cyan("INFO: No CMP-related files staged, skipping version bump."),
      );
      process.exit(0);
    }
  }

  const currentVersion = await readCurrentVersion();

  // pre-commit aborts the commit when a hook modifies files, so a bump is
  // always followed by a second pass with the same CMP files staged. If the
  // working tree already carries a tag HEAD does not have, that second pass
  // must leave it alone or every commit would bump twice.
  if (!force) {
    const headVersion = await readHeadVersion();
    if (headVersion !== null && headVersion !== currentVersion) {
      console.log(
        cyan(
          `INFO: CMP version already bumped in this commit (${headVersion} -> ${currentVersion}), skipping.`,
        ),
      );
      process.exit(0);
    }
  }

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

  // charts/bootstrap/values.yaml carries the CMP image tag and is covered by
  // the golden snapshots, so bumping the tag invalidates them. Regenerating
  // them here is not a convenience: without it every commit touching cmd/ or
  // internal/ left the branch with stale snapshots, and the level-0
  // pre-commit hook could not catch it because charts/** was not part of the
  // originally staged set. CI then failed on a commit that passed locally.
  if (updatedFiles.length > 1) {
    // The committed charts/*/values-localdev.yaml are rendered from the same
    // templates that carry the CMP tag, and level 0 fails (and so does
    // `verify snapshot`) while they are stale, so they come before snapshots.
    console.log(cyan("Re-exporting the committed localdev values..."));
    for (const format of ["helm-addons", "helm-apps"]) {
      try {
        await run([
          "go",
          "run",
          "./cmd/homelab",
          "config",
          "export",
          "--set",
          "localdev",
          "--format",
          format,
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          red(
            `ERROR: config export --set localdev --format ${format} failed after the version bump.\n` +
              "Fix the export, then run: task config:export:localdev\n" +
              message,
          ),
        );
        process.exit(1);
      }
    }
    updatedFiles.push(
      "charts/addons/values-localdev.yaml",
      "charts/applications/values-localdev.yaml",
    );

    console.log(cyan("Regenerating golden snapshots for the new image tag..."));
    try {
      await run([
        "go",
        "run",
        "./cmd/homelab",
        "verify",
        "snapshot",
        "--update",
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        red(
          "ERROR: snapshots could not be regenerated after the version bump.\n" +
            "The image tag changed but tests/snapshots did not, which fails CI.\n" +
            "Fix the render, then run: task test:snapshot -- --update\n" +
            message,
        ),
      );
      process.exit(1);
    }
    updatedFiles.push("tests/snapshots");
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
  process.exit(1);
});
