/**
 * codesearch-mcp.ts
 *
 * MCP server command for the Paperclip agents (installed by paperclip-dotfiles.ts next to
 * the codesearch binary). A bare `codesearch mcp` only serves the git repository it starts
 * in, but agents start in a project directory holding several clones and worktrees. So:
 *
 *   1. start a `codesearch serve` hub on 127.0.0.1 unless one answers /health
 *   2. register the repository containing the working directory, or every git repository
 *      directly below it, with the hub (it indexes them in the background)
 *   3. run `codesearch mcp`, which proxies every tool call to the hub
 *
 * Runs with the Node.js of the Paperclip image (type stripping, no dependencies).
 *
 * Environment:
 *   CODESEARCH_BIN         codesearch binary (default: next to this file)
 *   CODESEARCH_SERVE_PORT  hub port, shared with codesearch itself (default 39725)
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const hubUrl = (port: string | undefined): string =>
  `http://127.0.0.1:${port || "39725"}`;

export function repoRoots(cwd: string): string[] {
  const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  if (toplevel.status === 0) return [toplevel.stdout.trim()];
  return readdirSync(cwd, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(cwd, entry.name))
    .filter((dir) => existsSync(join(dir, ".git")));
}

async function hubUp(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureHub(bin: string, url: string) {
  if (await hubUp(url)) return;
  spawn(bin, ["serve", "--quiet", "true", "--no-tui"], {
    detached: true,
    stdio: "ignore",
  }).unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await hubUp(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`codesearch serve did not answer ${url}/health within 30s`);
}

async function register(url: string, repo: string) {
  const response = await fetch(`${url}/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: repo }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 202 && response.status !== 409) {
    throw new Error(
      `registering ${repo} with ${url} failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
  }
}

async function main() {
  const bin =
    process.env.CODESEARCH_BIN ||
    join(dirname(import.meta.filename), "codesearch");
  const url = hubUrl(process.env.CODESEARCH_SERVE_PORT);
  await ensureHub(bin, url);
  for (const repo of repoRoots(process.cwd())) await register(url, repo);
  const mcp = spawn(bin, ["mcp", "--mode", "client"], { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => mcp.kill(signal));
  mcp.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `codesearch-mcp: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
