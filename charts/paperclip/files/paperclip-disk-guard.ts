/**
 * paperclip-disk-guard.ts
 *
 * First init container of the Paperclip Instance (charts/paperclip templates/disk-guard.yaml):
 * keeps the data volume (HOME) from filling up and says why when it is full.
 *
 *   1. delete app-native database dumps beyond the newest DISK_GUARD_KEEP_BACKUPS;
 *      the server prunes only after a successful dump, which a full volume prevents
 *   2. below DISK_GUARD_MIN_FREE_PERCENT free: remove the regenerable tool caches in
 *      DISK_GUARD_CACHE_DIRS and log the largest directories of HOME
 *   3. below DISK_GUARD_REQUIRED_FREE_MIB free: exit 1 with that report, so the pod
 *      shows a disk-full error instead of a later init step's misleading one
 *
 * Runs with the Node.js of the Paperclip image (type stripping, no dependencies).
 *
 * Environment:
 *   PAPERCLIP_HOME                data volume mount, e.g. /paperclip (required)
 *   PAPERCLIP_DB_BACKUP_DIR       app-native dump directory (default $PAPERCLIP_HOME/backups)
 *   DISK_GUARD_KEEP_BACKUPS       newest dumps kept, at least 1 (default 3)
 *   DISK_GUARD_MIN_FREE_PERCENT   free share below which caches are cleared (default 10)
 *   DISK_GUARD_REQUIRED_FREE_MIB  free space below which the container fails (default 512)
 *   DISK_GUARD_CACHE_DIRS         comma-separated directories relative to HOME
 *   DISK_GUARD_REPORT_SECONDS     time budget of the usage report (default 60)
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export interface Config {
  home: string;
  backupDir: string;
  backupPrefix: string;
  keepBackups: number;
  minFreePercent: number;
  requiredFreeBytes: number;
  cacheDirs: string[];
  reportSeconds: number;
}

export interface Removal {
  removed: string[];
  bytes: number;
}

export interface Usage {
  bytes: number;
  complete: boolean;
}

const MIB = 1024 * 1024;

const log = {
  info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  ok: (msg: string) => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`),
  error: (msg: string) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
};

function numberSetting(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min)
    throw new Error(`${key} must be a number >= ${min}, got '${raw}'`);
  return value;
}

function relativeCacheDir(dir: string): string {
  const normalized = normalize(dir);
  if (
    isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  )
    throw new Error(
      `DISK_GUARD_CACHE_DIRS entries must stay inside HOME, got '${dir}'`,
    );
  return normalized;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const home = env.PAPERCLIP_HOME ?? "";
  if (!home) throw new Error("PAPERCLIP_HOME is required");
  return {
    home,
    backupDir: env.PAPERCLIP_DB_BACKUP_DIR || join(home, "backups"),
    backupPrefix: "paperclip",
    keepBackups: numberSetting(env, "DISK_GUARD_KEEP_BACKUPS", 3, 1),
    minFreePercent: numberSetting(env, "DISK_GUARD_MIN_FREE_PERCENT", 10, 0),
    requiredFreeBytes:
      numberSetting(env, "DISK_GUARD_REQUIRED_FREE_MIB", 512, 0) * MIB,
    cacheDirs: (env.DISK_GUARD_CACHE_DIRS ?? "")
      .split(",")
      .map((dir) => dir.trim())
      .filter((dir) => dir !== "")
      .map(relativeCacheDir),
    reportSeconds: numberSetting(env, "DISK_GUARD_REPORT_SECONDS", 60, 0),
  };
}

export function formatBytes(bytes: number): string {
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return unit === "B" ? `${bytes} B` : `${value.toFixed(1)} ${unit}`;
}

export function expiredBackups(
  entries: { name: string; mtimeMs: number }[],
  prefix: string,
  keep: number,
): string[] {
  return entries
    .filter(
      ({ name }) =>
        name.startsWith(`${prefix}-`) &&
        (name.endsWith(".sql") || name.endsWith(".sql.gz")),
    )
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(keep)
    .map(({ name }) => name);
}

export function pruneBackups(
  dir: string,
  prefix: string,
  keep: number,
): Removal {
  if (!existsSync(dir)) return { removed: [], bytes: 0 };
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map(({ name }) => ({ name, ...statSync(join(dir, name)) }));
  const sizes = new Map(entries.map(({ name, size }) => [name, size]));
  const removed = expiredBackups(entries, prefix, keep);
  for (const name of removed) unlinkSync(join(dir, name));
  return {
    removed,
    bytes: removed.reduce((sum, name) => sum + (sizes.get(name) ?? 0), 0),
  };
}

export function diskUsage(path: string, deadline: number): Usage {
  let bytes = 0;
  const pending = [path];
  while (pending.length > 0) {
    if (Date.now() >= deadline) return { bytes, complete: false };
    const current = pending.pop() ?? path;
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    bytes += stat.isDirectory() ? 0 : stat.size;
    if (stat.isDirectory())
      for (const name of readdirSync(current))
        pending.push(join(current, name));
  }
  return { bytes, complete: true };
}

export function clearCaches(home: string, dirs: string[]): Removal {
  const present = dirs.filter((dir) => existsSync(join(home, dir)));
  const sizes = present.map(
    (dir) => diskUsage(join(home, dir), Number.POSITIVE_INFINITY).bytes,
  );
  for (const dir of present)
    rmSync(join(home, dir), { recursive: true, force: true });
  return {
    removed: present,
    bytes: sizes.reduce((sum, size) => sum + size, 0),
  };
}

export function largestEntries(
  dir: string,
  deadline: number,
): ({ path: string } & Usage)[] {
  return readdirSync(dir)
    .map((name) => ({
      path: join(dir, name),
      ...diskUsage(join(dir, name), deadline),
    }))
    .toSorted((a, b) => b.bytes - a.bytes);
}

function freeSpace(path: string): { free: number; total: number } {
  const stats = statfsSync(path);
  return {
    free: stats.bavail * stats.bsize,
    total: stats.blocks * stats.bsize,
  };
}

function report(config: Config) {
  const deadline = Date.now() + config.reportSeconds * 1000;
  const top = largestEntries(config.home, deadline).slice(0, 10);
  const instance = join(config.home, "instances", "default");
  const nested = existsSync(instance)
    ? largestEntries(instance, deadline).slice(0, 10)
    : [];
  for (const { path, bytes, complete } of [...top, ...nested])
    log.info(`${complete ? "" : ">= "}${formatBytes(bytes)}\t${path}`);
  if (Date.now() >= deadline)
    log.info(
      `usage report stopped after ${config.reportSeconds}s; sizes marked >= are partial`,
    );
}

function main() {
  const config = parseConfig(process.env);
  const before = freeSpace(config.home);
  log.info(
    `${config.home}: ${formatBytes(before.free)} free of ${formatBytes(before.total)}`,
  );

  const dumps = pruneBackups(
    config.backupDir,
    config.backupPrefix,
    config.keepBackups,
  );
  if (dumps.removed.length > 0)
    log.ok(
      `deleted ${dumps.removed.length} database dump(s) beyond the newest ${config.keepBackups} (${formatBytes(dumps.bytes)}): ${dumps.removed.join(", ")}`,
    );

  const lowWater = (config.minFreePercent / 100) * before.total;
  if (freeSpace(config.home).free < lowWater) {
    const caches = clearCaches(config.home, config.cacheDirs);
    if (caches.removed.length > 0)
      log.ok(
        `cleared tool caches (${formatBytes(caches.bytes)}): ${caches.removed.join(", ")}`,
      );
    log.info(`largest entries of ${config.home}:`);
    report(config);
  }

  const after = freeSpace(config.home);
  if (after.free < config.requiredFreeBytes)
    throw new Error(
      `${config.home} is full: ${formatBytes(after.free)} free, ${formatBytes(config.requiredFreeBytes)} required to start. ` +
        "Free space on the volume (see the largest entries above) or raise persistence.size",
    );
  log.ok(`${config.home}: ${formatBytes(after.free)} free`);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
