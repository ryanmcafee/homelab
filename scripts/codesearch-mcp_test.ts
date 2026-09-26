import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubUrl, repoRoots } from "../charts/paperclip/files/codesearch-mcp.ts";

const gitInit = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  expect(spawnSync("git", ["init", "-q", dir]).status).toBe(0);
};

const projectDir = () =>
  realpathSync(mkdtempSync(join(tmpdir(), "codesearch-mcp-")));

describe("hubUrl", () => {
  test("defaults to the codesearch serve port on loopback", () => {
    expect(hubUrl(undefined)).toBe("http://127.0.0.1:39725");
    expect(hubUrl("")).toBe("http://127.0.0.1:39725");
  });

  test("uses CODESEARCH_SERVE_PORT when set", () => {
    expect(hubUrl("39799")).toBe("http://127.0.0.1:39799");
  });
});

describe("repoRoots", () => {
  test("returns the enclosing repository from a subdirectory", () => {
    const repo = join(projectDir(), "homelab");
    gitInit(repo);
    mkdirSync(join(repo, "charts", "paperclip"), { recursive: true });
    expect(repoRoots(join(repo, "charts", "paperclip"))).toEqual([repo]);
  });

  test("returns every clone and worktree directly below a project directory", () => {
    const project = projectDir();
    gitInit(join(project, "homelab"));
    gitInit(join(project, "dotfiles"));
    mkdirSync(join(project, "homelab-fix"));
    writeFileSync(
      join(project, "homelab-fix", ".git"),
      `gitdir: ${join(project, "homelab", ".git", "worktrees", "fix")}\n`,
    );
    mkdirSync(join(project, "notes"));
    writeFileSync(join(project, "body.txt"), "not a repository\n");
    expect(repoRoots(project).sort()).toEqual(
      ["dotfiles", "homelab", "homelab-fix"].map((name) => join(project, name)),
    );
  });

  test("returns nothing for a directory without repositories", () => {
    const project = projectDir();
    mkdirSync(join(project, "notes"));
    expect(repoRoots(project)).toEqual([]);
  });
});
