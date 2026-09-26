import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  writeFileSync,
  lstatSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitAuthArgs,
  linkClaudeDir,
  mcpCommands,
  parseConfig,
  pluginCommands,
  type Command,
} from "../charts/paperclip/files/paperclip-dotfiles.ts";

const baseEnv = {
  HOME: "/paperclip",
  DOTFILES_REPO_URL: "https://github.com/someone/dotfiles.git",
};

describe("parseConfig", () => {
  test("applies defaults for every optional setting", () => {
    const config = parseConfig(baseEnv);
    expect(config).toEqual({
      home: "/paperclip",
      repoUrl: "https://github.com/someone/dotfiles.git",
      ref: "main",
      dir: "/paperclip/.dotfiles",
      claudeDir: "claude",
      profile: "",
      setupCommand: "",
      gitToken: "",
      bunVersion: "",
      codesearch: { repo: "", version: "" },
      mcpServers: {},
    });
  });

  test("reads every setting from the environment", () => {
    const config = parseConfig({
      ...baseEnv,
      DOTFILES_REF: "v2",
      DOTFILES_DIR: "/data/dots",
      DOTFILES_CLAUDE_DIR: ".claude",
      DOTFILES_PROFILE: "personal",
      DOTFILES_SETUP_COMMAND: "bun setup.ts",
      DOTFILES_GIT_TOKEN: "t0k",
      BUN_VERSION: "1.4.2",
      CODESEARCH_REPO: "https://github.com/someone/codesearch",
      CODESEARCH_VERSION: "v1.6.1",
      MCP_SERVERS: '{"codesearch":{"command":"codesearch","args":["mcp"]}}',
    });
    expect(config.ref).toBe("v2");
    expect(config.dir).toBe("/data/dots");
    expect(config.claudeDir).toBe(".claude");
    expect(config.profile).toBe("personal");
    expect(config.setupCommand).toBe("bun setup.ts");
    expect(config.gitToken).toBe("t0k");
    expect(config.bunVersion).toBe("1.4.2");
    expect(config.codesearch).toEqual({
      repo: "https://github.com/someone/codesearch",
      version: "v1.6.1",
    });
    expect(config.mcpServers).toEqual({
      codesearch: { command: "codesearch", args: ["mcp"] },
    });
  });

  test("rejects a missing repository URL", () => {
    expect(() => parseConfig({ HOME: "/paperclip" })).toThrow(
      "DOTFILES_REPO_URL is required",
    );
  });

  test("rejects a missing HOME", () => {
    expect(() => parseConfig({ DOTFILES_REPO_URL: "https://x/y.git" })).toThrow(
      "HOME is required",
    );
  });

  test("rejects a claude directory that escapes the repository", () => {
    expect(() =>
      parseConfig({ ...baseEnv, DOTFILES_CLAUDE_DIR: "../etc" }),
    ).toThrow("DOTFILES_CLAUDE_DIR");
  });

  test("rejects a codesearch version without a repository URL", () => {
    expect(() => parseConfig({ ...baseEnv, CODESEARCH_VERSION: "v1" })).toThrow(
      "CODESEARCH_REPO",
    );
    expect(() =>
      parseConfig({
        ...baseEnv,
        CODESEARCH_REPO: "someone/codesearch",
        CODESEARCH_VERSION: "v1",
      }),
    ).toThrow("CODESEARCH_REPO");
  });

  test("rejects MCP_SERVERS that is not a JSON object", () => {
    expect(() => parseConfig({ ...baseEnv, MCP_SERVERS: "[1]" })).toThrow(
      "MCP_SERVERS",
    );
    expect(() => parseConfig({ ...baseEnv, MCP_SERVERS: "{nope" })).toThrow(
      "MCP_SERVERS",
    );
  });
});

describe("gitAuthArgs", () => {
  test("adds no header without a token", () => {
    expect(gitAuthArgs("")).toEqual([]);
  });

  test("sends the token as a basic auth header, never in the URL", () => {
    const args = gitAuthArgs("t0k");
    expect(args).toEqual([
      "-c",
      `http.extraHeader=Authorization: Basic ${Buffer.from("x-access-token:t0k").toString("base64")}`,
    ]);
  });
});

describe("pluginCommands", () => {
  const settings = {
    extraKnownMarketplaces: {
      thedotmack: {
        source: { source: "github", repo: "thedotmack/claude-mem" },
      },
      local: {
        source: { source: "directory", path: "/paperclip/.claude/marketplace" },
      },
      remote: { source: { source: "git", url: "https://example.com/m.git" } },
    },
    enabledPlugins: { "claude-mem@thedotmack": true, "off@local": false },
  };

  test("adds missing marketplaces and installs missing enabled plugins", () => {
    expect(pluginCommands(settings, { marketplaces: [], plugins: [] })).toEqual(
      [
        ["claude", "plugin", "marketplace", "add", "thedotmack/claude-mem"],
        [
          "claude",
          "plugin",
          "marketplace",
          "add",
          "/paperclip/.claude/marketplace",
        ],
        ["claude", "plugin", "marketplace", "add", "https://example.com/m.git"],
        [
          "claude",
          "plugin",
          "install",
          "claude-mem@thedotmack",
          "--scope",
          "user",
        ],
      ],
    );
  });

  test("skips what is already installed", () => {
    expect(
      pluginCommands(settings, {
        marketplaces: ["thedotmack", "local", "remote"],
        plugins: ["claude-mem@thedotmack"],
      }),
    ).toEqual([]);
  });

  test("adds the official marketplace only when an enabled plugin needs it", () => {
    const official = {
      enabledPlugins: { "gopls-lsp@claude-plugins-official": true },
    };
    expect(pluginCommands(official, { marketplaces: [], plugins: [] })).toEqual(
      [
        [
          "claude",
          "plugin",
          "marketplace",
          "add",
          "anthropics/claude-plugins-official",
        ],
        [
          "claude",
          "plugin",
          "install",
          "gopls-lsp@claude-plugins-official",
          "--scope",
          "user",
        ],
      ],
    );
    expect(
      pluginCommands(settings, { marketplaces: [], plugins: [] }).flat(),
    ).not.toContain("anthropics/claude-plugins-official");
  });

  test("tolerates settings without plugin keys", () => {
    expect(pluginCommands({}, { marketplaces: [], plugins: [] })).toEqual([]);
  });
});

describe("mcpCommands", () => {
  test("replaces each server at user scope", () => {
    const server = {
      command: "/paperclip/.local/bin/codesearch",
      args: ["mcp"],
    };
    const commands: Command[] = mcpCommands({ codesearch: server });
    expect(commands).toEqual([
      ["claude", "mcp", "remove", "--scope", "user", "codesearch"],
      [
        "claude",
        "mcp",
        "add-json",
        "--scope",
        "user",
        "codesearch",
        JSON.stringify(server),
      ],
    ]);
  });
});

describe("linkClaudeDir", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "dotfiles-"));
    const src = join(root, "repo", "claude");
    const dest = join(root, "home", ".claude");
    mkdirSync(join(src, "hooks"), { recursive: true });
    mkdirSync(join(src, ".git"), { recursive: true });
    writeFileSync(join(src, "CLAUDE.md"), "# mine");
    writeFileSync(join(src, "settings.json"), "{}");
    mkdirSync(join(dest, "projects"), { recursive: true });
    return { src, dest };
  };

  test("links every entry except .git and leaves runtime state alone", () => {
    const { src, dest } = setup();
    const result = linkClaudeDir(src, dest, "20260926");
    expect(readlinkSync(join(dest, "CLAUDE.md"))).toBe(join(src, "CLAUDE.md"));
    expect(readlinkSync(join(dest, "hooks"))).toBe(join(src, "hooks"));
    expect(lstatSync(join(dest, "projects")).isDirectory()).toBe(true);
    expect(() => lstatSync(join(dest, ".git"))).toThrow();
    expect(result.linked.sort()).toEqual([
      "CLAUDE.md",
      "hooks",
      "settings.json",
    ]);
    expect(result.backedUp).toEqual([]);
  });

  test("backs up a real file before replacing it", () => {
    const { src, dest } = setup();
    writeFileSync(join(dest, "settings.json"), '{"old":true}');
    const result = linkClaudeDir(src, dest, "20260926");
    expect(readlinkSync(join(dest, "settings.json"))).toBe(
      join(src, "settings.json"),
    );
    expect(
      readFileSync(join(dest, "settings.json.pre-dotfiles-20260926"), "utf8"),
    ).toBe('{"old":true}');
    expect(result.backedUp).toEqual(["settings.json"]);
  });

  test("repoints a stale symlink without a backup", () => {
    const { src, dest } = setup();
    symlinkSync("/nowhere", join(dest, "CLAUDE.md"));
    const result = linkClaudeDir(src, dest, "20260926");
    expect(readlinkSync(join(dest, "CLAUDE.md"))).toBe(join(src, "CLAUDE.md"));
    expect(result.backedUp).toEqual([]);
  });
});
