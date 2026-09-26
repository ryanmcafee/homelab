import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assembleConfigDir,
  configureGit,
  prepareBranch,
  syncRepo,
} from "../../src/workspace.ts";
import {
  commitAll,
  fakeExec,
  git,
  makeRepo,
  realExec,
  tempRoot,
} from "./helpers.ts";

const { root, cleanup } = tempRoot("workspace-");
afterAll(cleanup);

describe("syncRepo", () => {
  test("clones shallowly, then resets to the new upstream head", async () => {
    const upstream = await makeRepo(root, "upstream", { "README.md": "v1\n" });
    const clone = join(root, "clone");
    const opts = { url: `file://${upstream}`, dir: clone, branch: "main" };

    await syncRepo(realExec, opts);
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("v1\n");

    writeFileSync(join(upstream, "README.md"), "v2\n");
    await commitAll(upstream, "v2");
    writeFileSync(join(clone, "README.md"), "local edit\n");
    writeFileSync(join(clone, "stray.txt"), "x\n");

    await syncRepo(realExec, opts);
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("v2\n");
    expect(existsSync(join(clone, "stray.txt"))).toBe(false);
  });

  test("fails with git's message when the repository is missing", async () => {
    await expect(
      syncRepo(realExec, {
        url: `file://${join(root, "nope")}`,
        dir: join(root, "nope-clone"),
        branch: "main",
      }),
    ).rejects.toThrow(/git clone failed/);
  });
});

describe("prepareBranch", () => {
  test("creates the branch from origin/main without tracking", async () => {
    const upstream = await makeRepo(root, "up-branch", { "a.txt": "1\n" });
    const clone = join(root, "clone-branch");
    await syncRepo(realExec, {
      url: `file://${upstream}`,
      dir: clone,
      branch: "main",
    });
    const existed = await prepareBranch(realExec, {
      dir: clone,
      branch: "triage/x-1",
      base: "main",
    });
    expect(existed).toBe(false);
    expect((await git(clone, "branch", "--show-current")).trim()).toBe(
      "triage/x-1",
    );
    const tracking = await realExec(
      ["git", "rev-parse", "--abbrev-ref", "@{upstream}"],
      { cwd: clone },
    );
    expect(tracking.code).not.toBe(0);
  });

  test("checks out the remote branch an earlier run pushed", async () => {
    const upstream = await makeRepo(root, "up-existing", { "a.txt": "1\n" });
    await git(upstream, "switch", "-q", "-c", "triage/x-2");
    writeFileSync(join(upstream, "fix.txt"), "fix\n");
    await commitAll(upstream, "fix");
    await git(upstream, "switch", "-q", "main");

    const clone = join(root, "clone-existing");
    await syncRepo(realExec, {
      url: `file://${upstream}`,
      dir: clone,
      branch: "main",
    });
    const existed = await prepareBranch(realExec, {
      dir: clone,
      branch: "triage/x-2",
      base: "main",
    });
    expect(existed).toBe(true);
    expect(readFileSync(join(clone, "fix.txt"), "utf8")).toBe("fix\n");
  });
});

describe("configureGit", () => {
  test("sets the identity and runs gh auth setup-git only with a token", async () => {
    const { run, calls } = fakeExec();
    await configureGit(run, { name: "bot", email: "bot@example.invalid" }, "t");
    expect(calls).toEqual([
      "git config --global user.name bot",
      "git config --global user.email bot@example.invalid",
      "gh auth setup-git",
    ]);
    const second = fakeExec();
    await configureGit(second.run, { name: "bot", email: "b@x" }, undefined);
    expect(second.calls.length).toBe(2);
  });
});

describe("assembleConfigDir", () => {
  test("writes the baseline settings without dotfiles", () => {
    const configDir = join(root, "config-a");
    const settings = join(root, "settings.json");
    writeFileSync(settings, '{"model":"opus"}\n');
    const installed = assembleConfigDir({ configDir, settingsPath: settings });
    expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe(
      '{"model":"opus"}\n',
    );
    expect(installed).toEqual(["settings.json"]);
  });

  test("installs the global and profile CLAUDE.md with the profile link", async () => {
    const dotfiles = await makeRepo(root, "dotfiles", {
      "claude/CLAUDE.md": "# Global\n@profile/CLAUDE.md\n",
      "claude/profiles/personal/CLAUDE.md": "# Personal\n",
    });
    const configDir = join(root, "config-b");
    const settings = join(root, "settings.json");
    const opts = {
      configDir,
      settingsPath: settings,
      dotfiles: { dir: dotfiles, profile: "personal" },
    };
    expect(assembleConfigDir(opts)).toEqual([
      "settings.json",
      "CLAUDE.md",
      "profiles/personal/CLAUDE.md",
      "profile",
    ]);
    expect(readlinkSync(join(configDir, "profile"))).toBe("profiles/personal");
    expect(readFileSync(join(configDir, "profile", "CLAUDE.md"), "utf8")).toBe(
      "# Personal\n",
    );
    expect(assembleConfigDir(opts).length).toBe(4);
    expect(lstatSync(join(configDir, "profile")).isSymbolicLink()).toBe(true);
  });

  test("rejects a profile name that escapes the profiles directory", () => {
    expect(() =>
      assembleConfigDir({
        configDir: join(root, "config-c"),
        settingsPath: join(root, "settings.json"),
        dotfiles: { dir: root, profile: "../x" },
      }),
    ).toThrow(/profile/);
  });

  test("fails when the dotfiles checkout has no claude/CLAUDE.md", () => {
    const empty = join(root, "empty-dotfiles");
    mkdirSync(empty, { recursive: true });
    expect(() =>
      assembleConfigDir({
        configDir: join(root, "config-d"),
        settingsPath: join(root, "settings.json"),
        dotfiles: { dir: empty, profile: "personal" },
      }),
    ).toThrow(/claude\/CLAUDE.md/);
  });
});
