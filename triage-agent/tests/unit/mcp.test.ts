import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpServers, readProjectMcpServerNames } from "../../src/mcp.ts";

const ref = (name: string) => "$" + "{" + name + "}";

const config = {
  "sequential-thinking": {
    enabled: true,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
  memory: {
    enabled: true,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: { MEMORY_FILE_PATH: `${ref("MEMORY_DIR")}/memory.jsonl` },
  },
  puppeteer: {
    enabled: false,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
  },
  paperclip: {
    enabled: true,
    command: "uvx",
    args: ["paperclip-mcp"],
    env: {
      PAPERCLIP_API_URL: "http://paperclip.paperclip.svc:3100/api",
      PAPERCLIP_API_KEY: ref("PAPERCLIP_API_KEY"),
    },
  },
  serena: { enabled: true, command: "uvx", args: ["serena"] },
};

describe("loadMcpServers", () => {
  test("keeps enabled servers and expands variable references from the environment", () => {
    const { servers, skipped } = loadMcpServers(
      config,
      { MEMORY_DIR: "/data", PAPERCLIP_API_KEY: "k" },
      new Set(),
    );
    expect(Object.keys(servers)).toEqual([
      "sequential-thinking",
      "memory",
      "paperclip",
      "serena",
    ]);
    expect(servers.memory).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      env: { MEMORY_FILE_PATH: "/data/memory.jsonl" },
    });
    expect(servers.paperclip?.env?.PAPERCLIP_API_KEY).toBe("k");
    expect(skipped).toEqual([{ name: "puppeteer", reason: "disabled" }]);
  });

  test("skips a server whose referenced variable is unset or empty", () => {
    const { servers, skipped } = loadMcpServers(
      config,
      { MEMORY_DIR: "/data", PAPERCLIP_API_KEY: "" },
      new Set(),
    );
    expect(servers.paperclip).toBeUndefined();
    expect(skipped).toContainEqual({
      name: "paperclip",
      reason: "unset: PAPERCLIP_API_KEY",
    });
  });

  test("leaves servers the project .mcp.json registers to the project", () => {
    const { servers, skipped } = loadMcpServers(
      config,
      { MEMORY_DIR: "/data", PAPERCLIP_API_KEY: "k" },
      new Set(["serena"]),
    );
    expect(servers.serena).toBeUndefined();
    expect(skipped).toContainEqual({
      name: "serena",
      reason: "registered by the project .mcp.json",
    });
  });

  test("rejects an invalid config", () => {
    expect(() =>
      loadMcpServers({ x: { enabled: true } }, {}, new Set()),
    ).toThrow();
    expect(() => loadMcpServers([], {}, new Set())).toThrow();
  });
});

describe("readProjectMcpServerNames", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("returns the server names of .mcp.json", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { serena: { command: "uvx" } } }),
    );
    expect([...readProjectMcpServerNames(dir)]).toEqual(["serena"]);
  });

  test("returns nothing when the file is missing", () => {
    expect(readProjectMcpServerNames(join(dir, "missing")).size).toBe(0);
  });
});
