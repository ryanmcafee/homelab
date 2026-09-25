import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type Exec, must } from "./exec.ts";

export interface SyncOptions {
  url: string;
  dir: string;
  branch: string;
}

/** Shallow clone on first use; afterwards fetch and hard-reset to upstream. */
export async function syncRepo(run: Exec, opts: SyncOptions): Promise<void> {
  if (!existsSync(join(opts.dir, ".git"))) {
    mkdirSync(dirname(opts.dir), { recursive: true });
    await must(run, [
      "git",
      "clone",
      "--quiet",
      "--depth",
      "50",
      "--branch",
      opts.branch,
      opts.url,
      opts.dir,
    ]);
    return;
  }
  const git = (...args: string[]) =>
    must(run, ["git", ...args], { cwd: opts.dir });
  await git("fetch", "--quiet", "--depth", "50", "origin", opts.branch);
  await git("reset", "--quiet", "--hard", "FETCH_HEAD");
  await git("clean", "--quiet", "-fd");
}

export interface BranchOptions {
  dir: string;
  branch: string;
  base: string;
}

/**
 * Checks out the fix branch: the remote branch when an earlier run pushed it
 * (so an open PR is updated), otherwise a new branch from origin/<base>.
 * Returns true when the remote branch already existed.
 */
export async function prepareBranch(
  run: Exec,
  opts: BranchOptions,
): Promise<boolean> {
  const git = (...args: string[]) =>
    must(run, ["git", ...args], { cwd: opts.dir });
  await git(
    "fetch",
    "--quiet",
    "--depth",
    "50",
    "origin",
    `+refs/heads/${opts.base}:refs/remotes/origin/${opts.base}`,
  );
  const remote = `refs/remotes/origin/${opts.branch}`;
  const fetched = await run(
    [
      "git",
      "fetch",
      "--quiet",
      "--depth",
      "50",
      "origin",
      `+refs/heads/${opts.branch}:${remote}`,
    ],
    { cwd: opts.dir },
  );
  if (fetched.code === 0) {
    await git("switch", "--quiet", "--no-track", "-C", opts.branch, remote);
    return true;
  }
  await git(
    "switch",
    "--quiet",
    "--no-track",
    "-C",
    opts.branch,
    `origin/${opts.base}`,
  );
  return false;
}

export interface GitIdentity {
  name: string;
  email: string;
}

/** Global git identity and, with a GitHub token, gh as credential helper. */
export async function configureGit(
  run: Exec,
  identity: GitIdentity,
  githubToken: string | undefined,
): Promise<void> {
  await must(run, ["git", "config", "--global", "user.name", identity.name]);
  await must(run, ["git", "config", "--global", "user.email", identity.email]);
  if (githubToken) {
    await must(run, ["gh", "auth", "setup-git"], {
      env: { GH_TOKEN: githubToken },
    });
  }
}

export interface ConfigDirOptions {
  configDir: string;
  settingsPath: string;
  dotfiles?: { dir: string; profile: string };
}

const PROFILE_NAME = /^[a-z0-9-]+$/;

/**
 * Builds CLAUDE_CONFIG_DIR: the baseline settings.json and, from a dotfiles
 * checkout, claude/CLAUDE.md plus the profile it imports as @profile/CLAUDE.md.
 * Returns the paths it installed, relative to the config dir.
 */
export function assembleConfigDir(opts: ConfigDirOptions): string[] {
  mkdirSync(opts.configDir, { recursive: true });
  copyFileSync(opts.settingsPath, join(opts.configDir, "settings.json"));
  const installed = ["settings.json"];
  if (!opts.dotfiles) return installed;

  const { dir, profile } = opts.dotfiles;
  if (!PROFILE_NAME.test(profile)) {
    throw new Error(`invalid dotfiles profile name: ${profile}`);
  }
  const globalMd = join(dir, "claude", "CLAUDE.md");
  if (!existsSync(globalMd)) {
    throw new Error(`dotfiles checkout ${dir} has no claude/CLAUDE.md`);
  }
  copyFileSync(globalMd, join(opts.configDir, "CLAUDE.md"));
  installed.push("CLAUDE.md");

  const profileRel = join("profiles", profile);
  const profileMd = join(dir, "claude", profileRel, "CLAUDE.md");
  if (existsSync(profileMd)) {
    mkdirSync(join(opts.configDir, profileRel), { recursive: true });
    copyFileSync(profileMd, join(opts.configDir, profileRel, "CLAUDE.md"));
    const link = join(opts.configDir, "profile");
    rmSync(link, { force: true, recursive: true });
    symlinkSync(profileRel, link);
    installed.push(join(profileRel, "CLAUDE.md"), "profile");
  }
  return installed;
}
