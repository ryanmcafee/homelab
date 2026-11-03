import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCRUBBED_PATHS,
  scrubConfig,
  scrubFile,
} from "../charts/paperclip/files/paperclip-config-scrub.ts";

const onboardedConfig = {
  $meta: { version: 1 },
  database: {
    mode: "postgres",
    connectionString: "postgres://user:pw@db:5432/paperclip",
    backup: { enabled: true },
  },
  server: { port: 3100 },
};

const tempConfig = (content: string, mode = 0o660) => {
  const dir = mkdtempSync(join(tmpdir(), "config-scrub-"));
  const path = join(dir, "config.json");
  writeFileSync(path, content);
  chmodSync(path, mode);
  return { dir, path };
};

describe("scrubConfig", () => {
  test("removes database.connectionString and keeps every other field", () => {
    const { config, removed } = scrubConfig(onboardedConfig, SCRUBBED_PATHS);
    expect(removed).toEqual(["database.connectionString"]);
    expect(config).toEqual({
      $meta: { version: 1 },
      database: { mode: "postgres", backup: { enabled: true } },
      server: { port: 3100 },
    });
  });

  test("does not mutate its input", () => {
    scrubConfig(onboardedConfig, SCRUBBED_PATHS);
    expect(onboardedConfig.database.connectionString).toBeDefined();
  });

  test("reports nothing when the field is already absent", () => {
    const { removed } = scrubConfig(
      { database: { mode: "postgres" } },
      SCRUBBED_PATHS,
    );
    expect(removed).toEqual([]);
  });

  test("reports nothing when the parent object is absent", () => {
    expect(scrubConfig({ server: {} }, SCRUBBED_PATHS).removed).toEqual([]);
  });
});

describe("scrubFile", () => {
  test("rewrites the file without the connection string and keeps its mode", () => {
    const { path } = tempConfig(JSON.stringify(onboardedConfig, null, 2));
    expect(scrubFile(path)).toEqual(["database.connectionString"]);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.database).toEqual({
      mode: "postgres",
      backup: { enabled: true },
    });
    expect(statSync(path).mode & 0o777).toBe(0o660);
  });

  test("leaves no temporary file behind", () => {
    const { dir, path } = tempConfig(JSON.stringify(onboardedConfig));
    scrubFile(path);
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  test("is a no-op on a second run", () => {
    const { path } = tempConfig(JSON.stringify(onboardedConfig));
    scrubFile(path);
    const before = readFileSync(path, "utf8");
    const mtime = statSync(path).mtimeMs;
    expect(scrubFile(path)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });

  test("is a no-op when the file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-scrub-"));
    const path = join(dir, "config.json");
    expect(scrubFile(path)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  test("fails with the path when the file is not a JSON object", () => {
    const { path } = tempConfig("[1, 2]");
    expect(() => scrubFile(path)).toThrow(`${path} is not a JSON object`);
  });
});
