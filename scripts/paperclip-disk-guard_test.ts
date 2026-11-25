import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCaches,
  diskUsage,
  expiredBackups,
  formatBytes,
  largestEntries,
  parseConfig,
  pruneBackups,
} from "../charts/paperclip/files/paperclip-disk-guard.ts";

const tempHome = () => mkdtempSync(join(tmpdir(), "disk-guard-"));

const writeSized = (path: string, bytes: number, mtimeSeconds?: number) => {
  writeFileSync(path, Buffer.alloc(bytes));
  if (mtimeSeconds !== undefined) utimesSync(path, mtimeSeconds, mtimeSeconds);
};

describe("parseConfig", () => {
  test("applies defaults for every optional setting", () => {
    expect(parseConfig({ PAPERCLIP_HOME: "/paperclip" })).toEqual({
      home: "/paperclip",
      backupDir: "/paperclip/backups",
      backupPrefix: "paperclip",
      keepBackups: 3,
      minFreePercent: 10,
      requiredFreeBytes: 512 * 1024 * 1024,
      cacheDirs: [],
      reportSeconds: 60,
    });
  });

  test("reads every setting from the environment", () => {
    const config = parseConfig({
      PAPERCLIP_HOME: "/data",
      PAPERCLIP_DB_BACKUP_DIR: "/data/dumps",
      DISK_GUARD_KEEP_BACKUPS: "1",
      DISK_GUARD_MIN_FREE_PERCENT: "15",
      DISK_GUARD_REQUIRED_FREE_MIB: "1024",
      DISK_GUARD_CACHE_DIRS: ".cache, .npm/_cacache ,,",
      DISK_GUARD_REPORT_SECONDS: "5",
    });
    expect(config).toMatchObject({
      home: "/data",
      backupDir: "/data/dumps",
      keepBackups: 1,
      minFreePercent: 15,
      requiredFreeBytes: 1024 * 1024 * 1024,
      cacheDirs: [".cache", ".npm/_cacache"],
      reportSeconds: 5,
    });
  });

  test("requires PAPERCLIP_HOME", () => {
    expect(() => parseConfig({})).toThrow("PAPERCLIP_HOME is required");
  });

  test("rejects a keep count below one so the newest dump always survives", () => {
    expect(() =>
      parseConfig({ PAPERCLIP_HOME: "/p", DISK_GUARD_KEEP_BACKUPS: "0" }),
    ).toThrow("DISK_GUARD_KEEP_BACKUPS");
  });

  test("rejects cache directories that leave HOME", () => {
    for (const dir of ["../etc", "/tmp", ".", ".cache/../.."])
      expect(() =>
        parseConfig({ PAPERCLIP_HOME: "/p", DISK_GUARD_CACHE_DIRS: dir }),
      ).toThrow("DISK_GUARD_CACHE_DIRS");
  });
});

describe("expiredBackups", () => {
  const dump = (name: string, mtimeMs: number) => ({ name, mtimeMs });

  test("keeps the newest dumps and returns the rest oldest last", () => {
    const entries = [
      dump("paperclip-20261101.sql.gz", 1),
      dump("paperclip-20261103.sql.gz", 3),
      dump("paperclip-20261102.sql", 2),
      dump("paperclip-20261104.sql.gz", 4),
    ];
    expect(expiredBackups(entries, "paperclip", 2)).toEqual([
      "paperclip-20261102.sql",
      "paperclip-20261101.sql.gz",
    ]);
  });

  test("ignores files that are not dumps with the prefix", () => {
    const entries = [
      dump("paperclip-1.sql.gz", 1),
      dump("other-2.sql.gz", 0),
      dump("paperclip-notes.txt", 0),
      dump("paperclip-3.sql.gz.tmp", 0),
    ];
    expect(expiredBackups(entries, "paperclip", 1)).toEqual([]);
  });
});

describe("pruneBackups", () => {
  test("deletes dumps beyond the keep count and reports their size", () => {
    const dir = tempHome();
    writeSized(join(dir, "paperclip-a.sql.gz"), 10, 1_000);
    writeSized(join(dir, "paperclip-b.sql.gz"), 20, 2_000);
    writeSized(join(dir, "paperclip-c.sql.gz"), 30, 3_000);
    writeSized(join(dir, "unrelated.sql.gz"), 40, 500);

    expect(pruneBackups(dir, "paperclip", 1)).toEqual({
      removed: ["paperclip-b.sql.gz", "paperclip-a.sql.gz"],
      bytes: 30,
    });
    expect(existsSync(join(dir, "paperclip-c.sql.gz"))).toBe(true);
    expect(existsSync(join(dir, "unrelated.sql.gz"))).toBe(true);
  });

  test("is a no-op when the backup directory does not exist", () => {
    expect(pruneBackups(join(tempHome(), "missing"), "paperclip", 1)).toEqual({
      removed: [],
      bytes: 0,
    });
  });
});

describe("clearCaches", () => {
  test("removes each existing cache directory and reports the bytes freed", () => {
    const home = tempHome();
    mkdirSync(join(home, ".cache", "go-build"), { recursive: true });
    writeSized(join(home, ".cache", "go-build", "obj"), 100);
    mkdirSync(join(home, "workspaces"));
    writeSized(join(home, "workspaces", "keep"), 5);

    expect(clearCaches(home, [".cache", ".npm/_cacache"])).toEqual({
      removed: [".cache"],
      bytes: 100,
    });
    expect(existsSync(join(home, ".cache"))).toBe(false);
    expect(existsSync(join(home, "workspaces", "keep"))).toBe(true);
  });
});

describe("diskUsage", () => {
  test("sums file sizes recursively without following symlinks", () => {
    const home = tempHome();
    mkdirSync(join(home, "a", "b"), { recursive: true });
    writeSized(join(home, "a", "one"), 7);
    writeSized(join(home, "a", "b", "two"), 11);
    expect(diskUsage(join(home, "a"), Number.POSITIVE_INFINITY)).toEqual({
      bytes: 18,
      complete: true,
    });
  });

  test("stops at the deadline and marks the total incomplete", () => {
    const home = tempHome();
    writeSized(join(home, "file"), 3);
    expect(diskUsage(home, 0).complete).toBe(false);
  });
});

describe("largestEntries", () => {
  test("lists the entries of a directory largest first", () => {
    const home = tempHome();
    mkdirSync(join(home, "big"));
    writeSized(join(home, "big", "f"), 50);
    writeSized(join(home, "small"), 5);
    expect(largestEntries(home, Number.POSITIVE_INFINITY)).toEqual([
      { path: join(home, "big"), bytes: 50, complete: true },
      { path: join(home, "small"), bytes: 5, complete: true },
    ]);
  });
});

describe("formatBytes", () => {
  test("uses binary units with one decimal", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(200 * 1024 ** 3)).toBe("200.0 GiB");
  });
});
