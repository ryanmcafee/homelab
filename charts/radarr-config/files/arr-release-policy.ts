#!/usr/bin/env bun
/**
 * arr-release-policy.ts
 *
 * Keeps one banned release type out of Sonarr or Radarr
 * (docs/runbooks/arr-release-policy.md). Runs from a ConfigMap in the stock
 * oven/bun image next to arr-import-sweep.ts, whose API client it reuses; the
 * two chart copies are identical.
 *
 * 1. Ensures a custom format BANNED_FORMAT_NAME with one release title
 *    specification BANNED_TITLE_REGEX (created, or its specifications replaced).
 * 2. In every quality profile: scores that format BANNED_FORMAT_SCORE (below the
 *    profile minimum, so the app rejects matching releases), disallows every
 *    quality whose name matches BANNED_QUALITY_REGEX and moves a cutoff that
 *    pointed at one to the best allowed item below it.
 *
 * Idempotent: a compliant app gets no write. --dry-run reports and writes nothing.
 *
 * Environment (flags override):
 *   ARR_URL               e.g. http://radarr.media.svc.cluster.local:7878 (--url)
 *   ARR_API_KEY           API key; else read from CONFIG_XML (<ApiKey>)
 *   CONFIG_XML            default /app-config/config.xml
 *   DRY_RUN               true: report, change nothing (--dry-run)
 *   BANNED_FORMAT_NAME    default Remux
 *   BANNED_TITLE_REGEX    default remux (the apps match it case-insensitively)
 *   BANNED_QUALITY_REGEX  default remux (case-insensitive, on quality names)
 *   BANNED_FORMAT_SCORE   default -10000; must be negative
 */

import { readFileSync } from "node:fs";
import { Client, log } from "./arr-import-sweep.ts";

export interface BanPolicy {
  formatName: string;
  titlePattern: string;
  qualityPattern: RegExp;
  score: number;
}

export interface PolicyConfig {
  url: string;
  apiKey: string;
  dryRun: boolean;
  policy: BanPolicy;
}

export interface QualityItem {
  quality?: { id: number; name: string };
  id?: number;
  name?: string;
  items: QualityItem[];
  allowed: boolean;
}

export interface FormatItem {
  format: number;
  name: string;
  score: number;
}

export interface QualityProfile {
  id: number;
  name: string;
  cutoff: number;
  items: QualityItem[];
  formatItems: FormatItem[];
}

const HELP = `Usage: bun arr-release-policy.ts [--url URL] [--dry-run]

Bans one release type from Sonarr/Radarr: a custom format matching the release
title, scored below every quality profile's minimum, and the matching qualities
disallowed in every profile. --dry-run reports the changes and writes nothing.
Environment: see the header of this file.`;

export function readPolicyConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): PolicyConfig | "help" {
  let dryRun = env.DRY_RUN === "true";
  let url = env.ARR_URL ?? "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--url" && argv[i + 1] !== undefined) {
      url = argv[++i] ?? "";
    } else {
      throw new Error(`unknown or incomplete argument ${arg} (see --help)`);
    }
  }
  if (!url) throw new Error("ARR_URL/--url is required");
  let apiKey = env.ARR_API_KEY ?? "";
  if (!apiKey) {
    const configXml = env.CONFIG_XML || "/app-config/config.xml";
    apiKey = /<ApiKey>([^<]+)<\/ApiKey>/.exec(readFile(configXml))?.[1] ?? "";
    if (!apiKey)
      throw new Error(`no ARR_API_KEY and no <ApiKey> in ${configXml}`);
  }
  const rawScore = env.BANNED_FORMAT_SCORE || "-10000";
  const score = Number(rawScore);
  if (!Number.isInteger(score) || score >= 0) {
    throw new Error(
      `BANNED_FORMAT_SCORE must be a negative integer, got "${rawScore}"`,
    );
  }
  return {
    url: url.replace(/\/+$/, ""),
    apiKey,
    dryRun,
    policy: {
      formatName: env.BANNED_FORMAT_NAME || "Remux",
      titlePattern: env.BANNED_TITLE_REGEX || "remux",
      qualityPattern: new RegExp(env.BANNED_QUALITY_REGEX || "remux", "i"),
      score,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function num(value: unknown, what: string): number {
  if (typeof value !== "number") throw new Error(`${what} is not a number`);
  return value;
}

function parseItem(
  raw: Record<string, unknown>,
): QualityItem & Record<string, unknown> {
  const quality = isRecord(raw.quality)
    ? {
        ...raw.quality,
        id: num(raw.quality.id, "quality.id"),
        name: String(raw.quality.name ?? ""),
      }
    : undefined;
  return {
    ...raw,
    ...(quality ? { quality } : {}),
    ...(typeof raw.id === "number" ? { id: raw.id } : {}),
    items: records(raw.items).map(parseItem),
    allowed: raw.allowed === true,
  };
}

export function parseProfile(
  raw: Record<string, unknown>,
): QualityProfile & Record<string, unknown> {
  return {
    ...raw,
    id: num(raw.id, "profile.id"),
    name: String(raw.name ?? ""),
    cutoff: num(raw.cutoff, "profile.cutoff"),
    items: records(raw.items).map(parseItem),
    formatItems: records(raw.formatItems).map((item) => ({
      ...item,
      format: num(item.format, "formatItems.format"),
      name: String(item.name ?? ""),
      score: num(item.score, "formatItems.score"),
    })),
  };
}

const itemId = (item: QualityItem): number | undefined =>
  item.quality ? item.quality.id : item.id;

const itemName = (item: QualityItem): string =>
  item.quality?.name ?? item.name ?? `#${itemId(item)}`;

/** The profile with the policy applied and a line per change; throws when nothing stays allowed. */
export function enforceProfile<T extends QualityProfile>(
  raw: T,
  formatId: number,
  policy: BanPolicy,
): { profile: T; changes: string[] } {
  const profile = structuredClone(raw);
  const changes: string[] = [];
  const banned = (item: QualityItem) =>
    item.quality !== undefined && policy.qualityPattern.test(item.quality.name);

  for (const item of profile.items) {
    if (item.items.length > 0) {
      for (const member of item.items) {
        if (member.allowed && banned(member)) {
          member.allowed = false;
          changes.push(
            `disallow quality ${itemName(member)} in group ${itemName(item)}`,
          );
        }
      }
      if (item.allowed && !item.items.some((member) => member.allowed)) {
        item.allowed = false;
        changes.push(`disallow group ${itemName(item)}`);
      }
    } else if (item.allowed && banned(item)) {
      item.allowed = false;
      changes.push(`disallow quality ${itemName(item)}`);
    }
  }

  const allowed = profile.items.filter((item) => item.allowed);
  if (allowed.length === 0) {
    throw new Error(`profile ${profile.name} would have no allowed quality`);
  }
  const cutoffIndex = profile.items.findIndex(
    (item) => itemId(item) === profile.cutoff,
  );
  const cutoffItem = profile.items[cutoffIndex];
  if (cutoffItem && !cutoffItem.allowed) {
    const below = profile.items
      .slice(0, cutoffIndex)
      .filter((item) => item.allowed);
    const next = below.at(-1) ?? allowed.at(-1);
    const nextId = next && itemId(next);
    if (next && nextId !== undefined) {
      profile.cutoff = nextId;
      changes.push(`cutoff ${itemName(cutoffItem)} -> ${itemName(next)}`);
    }
  }

  const existing = profile.formatItems.find((item) => item.format === formatId);
  if (!existing) {
    profile.formatItems.push({
      format: formatId,
      name: policy.formatName,
      score: policy.score,
    });
    changes.push(
      `score format ${policy.formatName} ${policy.score} (was unset)`,
    );
  } else if (existing.score !== policy.score) {
    changes.push(
      `score format ${policy.formatName} ${policy.score} (was ${existing.score})`,
    );
    existing.score = policy.score;
  }
  return { profile, changes };
}

const TITLE_SPEC = "ReleaseTitleSpecification";

/** True when the custom format is exactly one release title spec with the policy regex. */
export function formatMatches(
  format: Record<string, unknown>,
  policy: BanPolicy,
): boolean {
  const specs = records(format.specifications);
  const spec = specs[0];
  if (specs.length !== 1 || !spec) return false;
  const value = records(spec.fields).find((field) => field.name === "value");
  return (
    spec.implementation === TITLE_SPEC &&
    spec.negate === false &&
    value?.value === policy.titlePattern
  );
}

function desiredSpecifications(policy: BanPolicy): Record<string, unknown>[] {
  return [
    {
      name: policy.formatName,
      implementation: TITLE_SPEC,
      negate: false,
      required: true,
      fields: [{ name: "value", value: policy.titlePattern }],
    },
  ];
}

async function ensureFormat(
  client: Client,
  config: PolicyConfig,
): Promise<number | null> {
  const { policy, dryRun } = config;
  const formats = records(await client.request("GET", "/customformat"));
  const current = formats.find((format) => format.name === policy.formatName);
  if (current && formatMatches(current, policy)) {
    return num(current.id, "customformat.id");
  }
  const verb = current ? "update" : "create";
  if (dryRun) {
    log(
      "INFO",
      `would ${verb} custom format ${policy.formatName} /${policy.titlePattern}/`,
    );
    return current ? num(current.id, "customformat.id") : null;
  }
  const body = {
    ...(current ?? { includeCustomFormatWhenRenaming: false }),
    name: policy.formatName,
    specifications: desiredSpecifications(policy),
  };
  const saved = current
    ? await client.request(
        "PUT",
        `/customformat/${num(current.id, "customformat.id")}`,
        body,
      )
    : await client.request("POST", "/customformat", body);
  if (!isRecord(saved))
    throw new Error(`${verb} custom format returned no object`);
  log(
    "OK",
    `${verb}d custom format ${policy.formatName} /${policy.titlePattern}/`,
  );
  return num(saved.id, "customformat.id");
}

export async function enforce(
  config: PolicyConfig,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const client = new Client(
    `${config.url}/api/v3`,
    { "X-Api-Key": config.apiKey },
    fetcher,
  );
  const formatId = await ensureFormat(client, config);
  const profiles = records(await client.request("GET", "/qualityprofile")).map(
    parseProfile,
  );
  let failed = 0;
  let updated = 0;
  for (const raw of profiles) {
    try {
      const { profile, changes } = enforceProfile(
        raw,
        formatId ?? -1,
        config.policy,
      );
      if (changes.length === 0) continue;
      const summary = `profile ${profile.name}: ${changes.join("; ")}`;
      if (config.dryRun) {
        log("INFO", `would update ${summary}`);
        continue;
      }
      await client.request("PUT", `/qualityprofile/${profile.id}`, profile);
      updated++;
      log("OK", `updated ${summary}`);
    } catch (error) {
      failed++;
      log(
        "ERROR",
        `profile ${raw.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  log(
    failed ? "ERROR" : "OK",
    `done: ${profiles.length} profiles, ${updated} updated, ${failed} failed${config.dryRun ? " (dry run)" : ""}`,
  );
  return failed > 0 ? 1 : 0;
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  try {
    const config = readPolicyConfig(argv, env, (path) =>
      readFileSync(path, "utf8"),
    );
    if (config === "help") {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    return await enforce(config, fetcher);
  } catch (error) {
    log("ERROR", error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2), process.env));
}
