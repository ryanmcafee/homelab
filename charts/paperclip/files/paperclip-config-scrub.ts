/**
 * paperclip-config-scrub.ts
 *
 * Init container of the Paperclip Instance (charts/paperclip templates/config-scrub.yaml):
 * removes credentials that the operator's onboard step writes into the instance
 * config.json, which sits on the data volume every agent run can read.
 *
 * The server takes DATABASE_URL from the environment before config.json, so the
 * stored database.connectionString is redundant. The operator runs onboard only
 * while config.json is missing, and this container runs after it, so a fresh
 * install is scrubbed on its first boot and the change persists.
 *
 * Idempotent: a missing file or an already scrubbed one is left untouched.
 * Runs with the Node.js of the Paperclip image (type stripping, no dependencies).
 *
 * Environment:
 *   PAPERCLIP_CONFIG_PATH  instance config.json (required)
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export const SCRUBBED_PATHS: readonly (readonly string[])[] = [
  ["database", "connectionString"],
];

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const log = {
  info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  ok: (msg: string) => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`),
  error: (msg: string) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
};

function withoutPath(
  node: JsonObject,
  [key, ...rest]: readonly string[],
): JsonObject | undefined {
  if (!(key in node)) return undefined;
  if (rest.length === 0) {
    const { [key]: _removed, ...kept } = node;
    return kept;
  }
  const child = node[key];
  if (!isObject(child)) return undefined;
  const scrubbedChild = withoutPath(child, rest);
  return scrubbedChild && { ...node, [key]: scrubbedChild };
}

export function scrubConfig(
  config: JsonObject,
  paths: readonly (readonly string[])[],
): { config: JsonObject; removed: string[] } {
  const initial: { config: JsonObject; removed: string[] } = {
    config,
    removed: [],
  };
  return paths.reduce((acc, path) => {
    const scrubbed = withoutPath(acc.config, path);
    return scrubbed
      ? { config: scrubbed, removed: [...acc.removed, path.join(".")] }
      : acc;
  }, initial);
}

export function scrubFile(path: string): string[] {
  if (!existsSync(path)) return [];
  const parsed: Json = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(parsed)) throw new Error(`${path} is not a JSON object`);
  const { config, removed } = scrubConfig(parsed, SCRUBBED_PATHS);
  if (removed.length === 0) return [];
  const tmp = `${path}.scrub-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(tmp, statSync(path).mode & 0o777);
  renameSync(tmp, path);
  return removed;
}

function main() {
  const path = process.env.PAPERCLIP_CONFIG_PATH ?? "";
  if (!path) throw new Error("PAPERCLIP_CONFIG_PATH is required");
  if (!existsSync(path)) {
    log.info(`${path} does not exist yet; nothing to scrub`);
    return;
  }
  const removed = scrubFile(path);
  if (removed.length === 0) log.ok(`${path} holds no scrubbed fields`);
  else log.ok(`removed from ${path}: ${removed.join(", ")}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
