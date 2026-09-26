/**
 * paperclip-dotfiles.ts
 *
 * Init container of the Paperclip Instance (charts/paperclip templates/dotfiles.yaml):
 * gives the agents the operator's own Claude Code setup from any dotfiles repository.
 *
 *   1. clone or fast-forward DOTFILES_REPO_URL@DOTFILES_REF into DOTFILES_DIR
 *   2. install pinned tools into ~/.local/bin (bun, codesearch) when asked for
 *   3. run DOTFILES_SETUP_COMMAND in the checkout (e.g. render a settings profile)
 *   4. symlink every entry of DOTFILES_DIR/DOTFILES_CLAUDE_DIR into ~/.claude
 *   5. add the marketplaces and install the plugins ~/.claude/settings.json enables
 *   6. register MCP_SERVERS at user scope (~/.claude.json)
 *
 * HOME is the persistent data volume, so each step is idempotent and cheap on restart.
 * Runs with the Node.js of the Paperclip image (type stripping, no dependencies).
 *
 * Environment:
 *   HOME                    data volume, e.g. /paperclip
 *   DOTFILES_REPO_URL       https clone URL (required)
 *   DOTFILES_REF            branch, tag or commit (default main)
 *   DOTFILES_DIR            checkout path (default $HOME/.dotfiles)
 *   DOTFILES_CLAUDE_DIR     directory in the repository that mirrors ~/.claude (default claude)
 *   DOTFILES_PROFILE        exported to the setup command unchanged
 *   DOTFILES_SETUP_COMMAND  sh command run in the checkout after the tools are installed
 *   DOTFILES_GIT_TOKEN      token for a private repository (sent as a header, never stored)
 *   BUN_VERSION             bun release to install from npm; empty skips it
 *   CODESEARCH_REPO         GitHub repository URL publishing codesearch-linux-x86_64.tar.gz
 *   CODESEARCH_VERSION      release tag; empty skips codesearch
 *   MCP_SERVERS             JSON object name -> Claude Code MCP server config
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
export type Command = string[];

export interface Config {
  home: string;
  repoUrl: string;
  ref: string;
  dir: string;
  claudeDir: string;
  profile: string;
  setupCommand: string;
  gitToken: string;
  bunVersion: string;
  codesearch: { repo: string; version: string };
  mcpServers: JsonObject;
}

export interface Installed {
  marketplaces: string[];
  plugins: string[];
}

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const log = {
  info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  ok: (msg: string) => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`),
  error: (msg: string) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
};

function parseMcpServers(raw: string): JsonObject {
  if (!raw) return {};
  let parsed: Json;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`MCP_SERVERS is not valid JSON: ${String(err)}`);
  }
  if (!isObject(parsed))
    throw new Error(
      "MCP_SERVERS must be a JSON object of name -> server config",
    );
  return parsed;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const home = env.HOME ?? "";
  const repoUrl = env.DOTFILES_REPO_URL ?? "";
  if (!home) throw new Error("HOME is required");
  if (!repoUrl) throw new Error("DOTFILES_REPO_URL is required");
  const claudeDir = env.DOTFILES_CLAUDE_DIR || "claude";
  if (isAbsolute(claudeDir) || normalize(claudeDir).startsWith("..")) {
    throw new Error(
      `DOTFILES_CLAUDE_DIR must be a path inside the repository, got '${claudeDir}'`,
    );
  }
  const codesearch = {
    repo: env.CODESEARCH_REPO ?? "",
    version: env.CODESEARCH_VERSION ?? "",
  };
  if (codesearch.version && !codesearch.repo.startsWith("https://")) {
    throw new Error(
      `CODESEARCH_REPO must be an https repository URL when CODESEARCH_VERSION is set, got '${codesearch.repo}'`,
    );
  }
  return {
    home,
    repoUrl,
    ref: env.DOTFILES_REF || "main",
    dir: env.DOTFILES_DIR || join(home, ".dotfiles"),
    claudeDir,
    profile: env.DOTFILES_PROFILE ?? "",
    setupCommand: env.DOTFILES_SETUP_COMMAND ?? "",
    gitToken: env.DOTFILES_GIT_TOKEN ?? "",
    bunVersion: env.BUN_VERSION ?? "",
    codesearch,
    mcpServers: parseMcpServers(env.MCP_SERVERS ?? ""),
  };
}

export function gitAuthArgs(token: string): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

function marketplaceSource(entry: Json | undefined): string {
  if (!isObject(entry) || !isObject(entry.source)) return "";
  const { repo, url, path } = entry.source;
  const source = repo ?? url ?? path;
  return typeof source === "string" ? source : "";
}

// Marketplaces Claude Code knows without extraKnownMarketplaces; a fresh HOME has none of them.
const builtinMarketplaces: JsonObject = {
  "claude-plugins-official": {
    source: { source: "github", repo: "anthropics/claude-plugins-official" },
  },
};

export function pluginCommands(
  settings: JsonObject,
  installed: Installed,
): Command[] {
  const declared = isObject(settings.extraKnownMarketplaces)
    ? settings.extraKnownMarketplaces
    : {};
  const enabled = isObject(settings.enabledPlugins)
    ? settings.enabledPlugins
    : {};
  const wantedIds = Object.entries(enabled)
    .filter(([, on]) => on === true)
    .map(([id]) => id);
  const neededBuiltins = Object.entries(builtinMarketplaces).filter(([name]) =>
    wantedIds.some((id) => id.endsWith(`@${name}`)),
  );
  const marketplaces = { ...Object.fromEntries(neededBuiltins), ...declared };
  const addMarketplaces = Object.entries(marketplaces)
    .filter(([name]) => !installed.marketplaces.includes(name))
    .map(([, entry]) => marketplaceSource(entry))
    .filter((source) => source !== "")
    .map((source) => ["claude", "plugin", "marketplace", "add", source]);
  const installPlugins = wantedIds
    .filter((id) => !installed.plugins.includes(id))
    .map((id) => ["claude", "plugin", "install", id, "--scope", "user"]);
  return [...addMarketplaces, ...installPlugins];
}

export function mcpCommands(servers: JsonObject): Command[] {
  return Object.entries(servers).flatMap(([name, server]) => [
    ["claude", "mcp", "remove", "--scope", "user", name],
    [
      "claude",
      "mcp",
      "add-json",
      "--scope",
      "user",
      name,
      JSON.stringify(server),
    ],
  ]);
}

export function linkClaudeDir(
  src: string,
  dest: string,
  stamp: string,
): { linked: string[]; backedUp: string[] } {
  mkdirSync(dest, { recursive: true });
  const linked: string[] = [];
  const backedUp: string[] = [];
  for (const name of readdirSync(src)) {
    if (name === ".git") continue;
    const target = join(dest, name);
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) {
      unlinkSync(target);
    } else if (existing) {
      renameSync(target, `${target}.pre-dotfiles-${stamp}`);
      backedUp.push(name);
    }
    symlinkSync(join(src, name), target);
    linked.push(name);
  }
  return { linked, backedUp };
}

function run(
  command: Command,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
  } = {},
) {
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
  if (result.error)
    throw new Error(`${bin} could not start: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `'${command.slice(0, 4).join(" ")}' exited ${result.status}`,
    );
  }
  return result.status;
}

function capture(command: Command, env: NodeJS.ProcessEnv): string {
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, { env, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `'${command.join(" ")}' exited ${result.status}: ${result.stderr}`,
    );
  return result.stdout;
}

function syncRepo(config: Config, env: NodeJS.ProcessEnv) {
  const git = (...args: string[]) =>
    run(["git", ...gitAuthArgs(config.gitToken), "-C", config.dir, ...args], {
      env,
    });
  mkdirSync(config.dir, { recursive: true });
  if (!existsSync(join(config.dir, ".git")))
    run(["git", "init", "-q", config.dir], { env });
  const hasOrigin =
    spawnSync("git", ["-C", config.dir, "remote", "get-url", "origin"], { env })
      .status === 0;
  run(
    [
      "git",
      "-C",
      config.dir,
      "remote",
      hasOrigin ? "set-url" : "add",
      "origin",
      config.repoUrl,
    ],
    { env },
  );
  git("fetch", "-q", "--depth", "1", "origin", config.ref);
  git("checkout", "-q", "--force", "FETCH_HEAD");
  log.ok(`dotfiles at ${config.repoUrl}@${config.ref} in ${config.dir}`);
}

function installBun(config: Config, binDir: string, env: NodeJS.ProcessEnv) {
  const bun = join(binDir, "bun");
  if (
    existsSync(bun) &&
    capture([bun, "--version"], env).trim() === config.bunVersion
  ) {
    log.ok(`bun ${config.bunVersion} already installed`);
    return;
  }
  run(
    [
      "npm",
      "install",
      "--global",
      "--prefix",
      join(config.home, ".local"),
      `bun@${config.bunVersion}`,
    ],
    { env },
  );
  log.ok(`bun ${config.bunVersion} installed in ${binDir}`);
}

async function installCodesearch(
  config: Config,
  binDir: string,
  env: NodeJS.ProcessEnv,
) {
  const { repo, version } = config.codesearch;
  const want = `${repo}@${version}`;
  const marker = join(config.home, ".codesearch", "installed-from");
  const bin = join(binDir, "codesearch");
  if (
    existsSync(bin) &&
    existsSync(marker) &&
    readFileSync(marker, "utf8").trim() === want
  ) {
    log.ok(`codesearch ${want} already installed`);
    return;
  }
  const url = `${repo.replace(/\/+$/, "")}/releases/download/${version}/codesearch-linux-x86_64.tar.gz`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(
      `codesearch download ${url} failed: HTTP ${response.status}`,
    );
  const tmp = mkdtempSync(join(tmpdir(), "codesearch-"));
  try {
    const archive = join(tmp, "codesearch.tar.gz");
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    run(["tar", "xzf", archive, "-C", tmp], { env });
    copyFileSync(join(tmp, "codesearch"), bin);
    chmodSync(bin, 0o755);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  run([bin, "-q", "setup"], { env });
  mkdirSync(join(config.home, ".codesearch"), { recursive: true });
  writeFileSync(marker, `${want}\n`);
  log.ok(`codesearch ${want} installed in ${binDir}`);
}

function installedPlugins(env: NodeJS.ProcessEnv): Installed {
  const names = (raw: string, key: string): string[] => {
    const parsed: Json = JSON.parse(raw);
    if (!Array.isArray(parsed))
      throw new Error(
        `expected a JSON array from claude, got: ${raw.slice(0, 200)}`,
      );
    return parsed.flatMap((item) =>
      isObject(item) && typeof item[key] === "string" ? [item[key]] : [],
    );
  };
  return {
    marketplaces: names(
      capture(["claude", "plugin", "marketplace", "list", "--json"], env),
      "name",
    ),
    plugins: names(capture(["claude", "plugin", "list", "--json"], env), "id"),
  };
}

async function main() {
  const config = parseConfig(process.env);
  const binDir = join(config.home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== "DOTFILES_GIT_TOKEN",
      ),
    ),
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    DOTFILES_DIR: config.dir,
    DOTFILES_PROFILE: config.profile,
  };

  syncRepo(config, env);
  if (config.bunVersion) installBun(config, binDir, env);
  if (config.codesearch.version) await installCodesearch(config, binDir, env);

  if (config.setupCommand) {
    log.info(`running setup command in ${config.dir}`);
    run(["sh", "-c", config.setupCommand], { cwd: config.dir, env });
  }

  const claudeHome = join(config.home, ".claude");
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const { linked, backedUp } = linkClaudeDir(
    join(config.dir, config.claudeDir),
    claudeHome,
    stamp,
  );
  log.ok(`linked into ${claudeHome}: ${linked.join(", ")}`);
  if (backedUp.length > 0)
    log.info(
      `moved aside (suffix .pre-dotfiles-${stamp}): ${backedUp.join(", ")}`,
    );

  const settingsPath = join(claudeHome, "settings.json");
  if (existsSync(settingsPath)) {
    const settings: Json = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!isObject(settings))
      throw new Error(`${settingsPath} is not a JSON object`);
    for (const command of pluginCommands(settings, installedPlugins(env)))
      run(command, { env });
    log.ok("plugins from settings.json installed");
  } else {
    log.info(`no ${settingsPath}; skipping plugin installs`);
  }

  for (const command of mcpCommands(config.mcpServers)) {
    run(command, { env, allowFailure: command[2] === "remove" });
  }
  if (Object.keys(config.mcpServers).length > 0) {
    log.ok(
      `MCP servers registered: ${Object.keys(config.mcpServers).join(", ")}`,
    );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
