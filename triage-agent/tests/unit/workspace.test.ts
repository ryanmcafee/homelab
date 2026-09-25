import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleConfigDir,
  gitAuthEnv,
  runGit,
  syncRepo,
} from "../../src/workspace.ts";

const root = mkdtempSync(join(tmpdir(), "workspace-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function makeRepo(name: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  await runGit(["init", "-q", "-b", "main"], dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  await commitAll(dir, "init");
  return dir;
}

async function commitAll(dir: string, message: string) {
  await runGit(["add", "-A"], dir);
  await runGit(
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    ],
    dir,
  );
}

describe("gitAuthEnv", () => {
  test("is empty without a token", () => {
    expect(gitAuthEnv(undefined)).toEqual({});
    expect(gitAuthEnv("")).toEqual({});
  });

  test("passes the token as an extra header, never in the URL", () => {
    const env = gitAuthEnv("tok");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${btoa("x-access-token:tok")}`,
    );
  });
});

describe("syncRepo", () => {
  test("clones shallowly, then resets to the new upstream head", async () => {
    const upstream = await makeRepo("upstream", { "README.md": "v1\n" });
    const clone = join(root, "clone");

    await syncRepo({ url: `file://${upstream}`, dir: clone, branch: "main" });
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("v1\n");
    const depth = await runGit(["rev-list", "--count", "HEAD"], clone);
    expect(depth.trim()).toBe("1");

    writeFileSync(join(upstream, "README.md"), "v2\n");
    await commitAll(upstream, "v2");
    writeFileSync(join(clone, "README.md"), "local edit\n");
    writeFileSync(join(clone, "stray.txt"), "x\n");

    await syncRepo({ url: `file://${upstream}`, dir: clone, branch: "main" });
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("v2\n");
    expect(existsSync(join(clone, "stray.txt"))).toBe(false);
  });

  test("fails with git's message when the repository is missing", async () => {
    await expect(
      syncRepo({
        url: `file://${join(root, "nope")}`,
        dir: join(root, "nope-clone"),
        branch: "main",
      }),
    ).rejects.toThrow(/git clone failed/);
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
    const dotfiles = await makeRepo("dotfiles", {
      "claude/CLAUDE.md": "# Global\n@profile/CLAUDE.md\n",
      "claude/profiles/personal/CLAUDE.md": "# Personal\n",
    });
    const configDir = join(root, "config-b");
    const settings = join(root, "settings.json");
    const installed = assembleConfigDir({
      configDir,
      settingsPath: settings,
      dotfiles: { dir: dotfiles, profile: "personal" },
    });
    expect(installed).toEqual([
      "settings.json",
      "CLAUDE.md",
      "profiles/personal/CLAUDE.md",
      "profile",
    ]);
    expect(readlinkSync(join(configDir, "profile"))).toBe("profiles/personal");
    expect(readFileSync(join(configDir, "profile", "CLAUDE.md"), "utf8")).toBe(
      "# Personal\n",
    );

    const again = assembleConfigDir({
      configDir,
      settingsPath: settings,
      dotfiles: { dir: dotfiles, profile: "personal" },
    });
    expect(again.length).toBe(4);
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
