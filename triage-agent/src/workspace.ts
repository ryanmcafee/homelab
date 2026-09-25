import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface SyncOptions {
  url: string;
  dir: string;
  branch: string;
  token?: string;
}

/**
 * Git config passed through the environment so the token never appears in
 * argv, the remote URL or .git/config.
 */
export function gitAuthEnv(token: string | undefined): Record<string, string> {
  if (!token) return {};
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${btoa(`x-access-token:${token}`)}`,
  };
}

export async function runGit(
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`);
  }
  return stdout;
}

/** Shallow clone on first use; afterwards fetch and hard-reset to upstream. */
export async function syncRepo(opts: SyncOptions): Promise<void> {
  const env = gitAuthEnv(opts.token);
  if (!existsSync(join(opts.dir, ".git"))) {
    mkdirSync(dirname(opts.dir), { recursive: true });
    await runGit(
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        opts.branch,
        opts.url,
        opts.dir,
      ],
      dirname(opts.dir),
      env,
    );
    return;
  }
  await runGit(
    ["fetch", "--quiet", "--depth", "1", "origin", opts.branch],
    opts.dir,
    env,
  );
  await runGit(["reset", "--quiet", "--hard", "FETCH_HEAD"], opts.dir);
  await runGit(["clean", "--quiet", "-fd"], opts.dir);
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
