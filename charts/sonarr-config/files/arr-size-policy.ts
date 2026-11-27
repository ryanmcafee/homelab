#!/usr/bin/env bun
/**
 * arr-size-policy.ts
 *
 * Caps the size of every Sonarr episode (docs/runbooks/arr-size-policy.md).
 * Runs from a ConfigMap in the stock oven/bun image next to
 * arr-import-sweep.ts, whose API client it reuses.
 *
 * 1. Caps every quality definition at MAX_MB_PER_MINUTE (Sonarr multiplies it
 *    by the runtime of every episode in a release, so season packs are capped
 *    per episode too).
 * 2. Ensures a custom format OVERSIZE_FORMAT_NAME matching single-episode
 *    releases larger than MAX_EPISODE_GB and scores it OVERSIZE_FORMAT_SCORE
 *    in every quality profile, a hard cap whatever the episode runtime.
 * 3. Removes and blocklists queued downloads larger than the cap per episode;
 *    Sonarr then searches for another release.
 * 4. Replaces up to REPLACE_LIMIT episode files larger than the cap per run:
 *    an interactive search must return a release within the cap that only the
 *    existing file blocks, then the file is deleted and the episode searched.
 *
 * Idempotent: a compliant app gets no write. --dry-run reports and writes nothing.
 *
 * Environment (flags override):
 *   ARR_URL                 e.g. http://sonarr.media.svc.cluster.local:8989 (--url)
 *   ARR_API_KEY             API key; else read from CONFIG_XML (<ApiKey>)
 *   CONFIG_XML              default /app-config/config.xml
 *   DRY_RUN                 true: report, change nothing (--dry-run)
 *   MAX_EPISODE_GB          default 10 (Sonarr's GB: 1024^3 bytes)
 *   MAX_MB_PER_MINUTE       default 170 (10 GB for a 60-minute episode)
 *   OVERSIZE_FORMAT_NAME    default Oversize
 *   OVERSIZE_FORMAT_SCORE   default -10000; must be negative
 *   REPLACE_LIMIT           default 5 files per run; 0 replaces nothing
 *   SEARCH_TIMEOUT_SECONDS  default 300, per interactive search
 */

import { readFileSync } from "node:fs";
import { Client, log } from "./arr-import-sweep.ts";

export interface SizePolicy {
  maxEpisodeGB: number;
  maxMbPerMinute: number;
  formatName: string;
  score: number;
  replaceLimit: number;
  searchTimeoutMs: number;
}

export interface SizeConfig {
  url: string;
  apiKey: string;
  dryRun: boolean;
  policy: SizePolicy;
}

export interface QualityDefinition {
  id: number;
  title: string;
  minSize: number | null;
  maxSize: number | null;
  preferredSize: number | null;
}

export interface QueueRecord {
  id: number;
  downloadId: string;
  episodeId: number;
  title: string;
  size: number;
}

export interface EpisodeFile {
  id: number;
  seriesId: number;
  relativePath: string;
  size: number;
}

export interface Release {
  guid: string;
  title: string;
  size: number;
  fullSeason: boolean;
  rejections: string[];
}

const GIB = 1024 ** 3;
const SIZE_SPEC = "SizeSpecification";
const RELEASE_TYPE_SPEC = "ReleaseTypeSpecification";
const SINGLE_EPISODE = 1;
const SIZE_SPEC_MAX_GB = 1000;

const HELP = `Usage: bun arr-size-policy.ts [--url URL] [--dry-run]

Caps Sonarr episodes at MAX_EPISODE_GB: caps every quality definition per
minute, rejects larger single-episode releases with a custom format, blocklists
larger queued downloads and replaces up to REPLACE_LIMIT larger episode files
for which a release within the cap exists. --dry-run reports the changes and
writes nothing. Environment: see the header of this file.`;

function positive(
  env: Record<string, string | undefined>,
  name: string,
  fallback: string,
  integer: boolean,
  allowZero = false,
): number {
  const raw = env[name] || fallback;
  const value = Number(raw);
  const valid =
    Number.isFinite(value) &&
    (allowZero ? value >= 0 : value > 0) &&
    (!integer || Number.isInteger(value));
  if (!valid) {
    throw new Error(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} ${integer ? "integer" : "number"}, got "${raw}"`,
    );
  }
  return value;
}

export function readSizeConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): SizeConfig | "help" {
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
  const rawScore = env.OVERSIZE_FORMAT_SCORE || "-10000";
  const score = Number(rawScore);
  if (!Number.isInteger(score) || score >= 0) {
    throw new Error(
      `OVERSIZE_FORMAT_SCORE must be a negative integer, got "${rawScore}"`,
    );
  }
  const maxEpisodeGB = positive(env, "MAX_EPISODE_GB", "10", false);
  if (maxEpisodeGB >= SIZE_SPEC_MAX_GB) {
    throw new Error(`MAX_EPISODE_GB must be below ${SIZE_SPEC_MAX_GB}`);
  }
  return {
    url: url.replace(/\/+$/, ""),
    apiKey,
    dryRun,
    policy: {
      maxEpisodeGB,
      maxMbPerMinute: positive(env, "MAX_MB_PER_MINUTE", "170", false),
      formatName: env.OVERSIZE_FORMAT_NAME || "Oversize",
      score,
      replaceLimit: positive(env, "REPLACE_LIMIT", "5", true, true),
      searchTimeoutMs:
        positive(env, "SEARCH_TIMEOUT_SECONDS", "300", true) * 1000,
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

const optionalNum = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

export function parseDefinition(
  raw: Record<string, unknown>,
): QualityDefinition & Record<string, unknown> {
  return {
    ...raw,
    id: num(raw.id, "qualitydefinition.id"),
    title: String(raw.title ?? ""),
    minSize: optionalNum(raw.minSize),
    maxSize: optionalNum(raw.maxSize),
    preferredSize: optionalNum(raw.preferredSize),
  };
}

/** The definition with maxSize capped and a line per change; throws when minSize exceeds the cap. */
export function capDefinition<T extends QualityDefinition>(
  raw: T,
  cap: number,
): { definition: T; changes: string[] } {
  const definition = structuredClone(raw);
  const changes: string[] = [];
  if (definition.minSize !== null && definition.minSize > cap) {
    throw new Error(
      `quality ${definition.title} minimum ${definition.minSize} MB/min exceeds the cap ${cap}`,
    );
  }
  if (definition.maxSize === null || definition.maxSize > cap) {
    changes.push(`max ${definition.maxSize ?? "unlimited"} -> ${cap} MB/min`);
    definition.maxSize = cap;
  }
  if (definition.preferredSize !== null && definition.preferredSize > cap) {
    changes.push(`preferred ${definition.preferredSize} -> ${cap} MB/min`);
    definition.preferredSize = cap;
  }
  return { definition, changes };
}

function fieldValue(spec: Record<string, unknown>, name: string): unknown {
  return records(spec.fields).find((field) => field.name === name)?.value;
}

/** True when the format is exactly the size and single-episode specifications of the policy. */
export function formatMatches(
  format: Record<string, unknown>,
  policy: SizePolicy,
): boolean {
  const specs = records(format.specifications);
  const size = specs.find((spec) => spec.implementation === SIZE_SPEC);
  const type = specs.find((spec) => spec.implementation === RELEASE_TYPE_SPEC);
  const strict = (spec: Record<string, unknown> | undefined) =>
    spec?.negate === false && spec.required === true;
  return (
    specs.length === 2 &&
    strict(size) &&
    strict(type) &&
    size !== undefined &&
    type !== undefined &&
    fieldValue(size, "min") === policy.maxEpisodeGB &&
    fieldValue(size, "max") === SIZE_SPEC_MAX_GB &&
    fieldValue(type, "value") === SINGLE_EPISODE
  );
}

export function desiredSpecifications(
  policy: SizePolicy,
): Record<string, unknown>[] {
  return [
    {
      name: `Larger than ${policy.maxEpisodeGB} GB`,
      implementation: SIZE_SPEC,
      negate: false,
      required: true,
      fields: [
        { name: "min", value: policy.maxEpisodeGB },
        { name: "max", value: SIZE_SPEC_MAX_GB },
      ],
    },
    {
      name: "Single episode",
      implementation: RELEASE_TYPE_SPEC,
      negate: false,
      required: true,
      fields: [{ name: "value", value: SINGLE_EPISODE }],
    },
  ];
}

/** The profile with the format scored and a line per change. */
export function scoreProfile<T extends Record<string, unknown>>(
  raw: T,
  formatId: number,
  policy: SizePolicy,
): { profile: T; changes: string[] } {
  const profile = structuredClone(raw);
  const formatItems = records(profile.formatItems);
  const existing = formatItems.find((item) => item.format === formatId);
  if (existing?.score === policy.score) return { profile, changes: [] };
  const was = existing ? String(existing.score) : "unset";
  const next = existing
    ? formatItems.map((item) =>
        item === existing ? { ...item, score: policy.score } : item,
      )
    : [
        ...formatItems,
        { format: formatId, name: policy.formatName, score: policy.score },
      ];
  return {
    profile: { ...profile, formatItems: next },
    changes: [`score format ${policy.formatName} ${policy.score} (was ${was})`],
  };
}

export const capBytes = (policy: SizePolicy, episodes = 1): number =>
  policy.maxEpisodeGB * GIB * Math.max(1, episodes);

export function parseQueue(raw: unknown): QueueRecord[] {
  const list = isRecord(raw) ? records(raw.records) : [];
  return list.map((record) => ({
    id: num(record.id, "queue.id"),
    downloadId: String(record.downloadId ?? record.id),
    episodeId: typeof record.episodeId === "number" ? record.episodeId : -1,
    title: String(record.title ?? ""),
    size: typeof record.size === "number" ? record.size : 0,
  }));
}

/** One queue record per download whose size per episode exceeds the cap. */
export function oversizedDownloads(
  queue: QueueRecord[],
  policy: SizePolicy,
): QueueRecord[] {
  const byDownload = Map.groupBy(queue, (record) => record.downloadId);
  return [...byDownload.values()].flatMap((group) => {
    const first = group[0];
    return first && first.size > capBytes(policy, group.length) ? [first] : [];
  });
}

export function parseEpisodeFile(raw: Record<string, unknown>): EpisodeFile {
  return {
    id: num(raw.id, "episodefile.id"),
    seriesId: num(raw.seriesId, "episodefile.seriesId"),
    relativePath: String(raw.relativePath ?? ""),
    size: num(raw.size, "episodefile.size"),
  };
}

export function parseRelease(raw: Record<string, unknown>): Release {
  return {
    guid: String(raw.guid ?? ""),
    title: String(raw.title ?? ""),
    size: typeof raw.size === "number" ? raw.size : 0,
    fullSeason: raw.fullSeason === true,
    rejections: Array.isArray(raw.rejections) ? raw.rejections.map(String) : [],
  };
}

const EXISTING_FILE = /^Existing file/i;

/**
 * The largest release within the cap that only the existing file rejects:
 * once that file is deleted, Sonarr's own search can grab it.
 */
export function replacementFor(
  releases: Release[],
  policy: SizePolicy,
  episodes: number,
): Release | undefined {
  const cap = capBytes(policy, episodes);
  return releases
    .filter(
      (release) =>
        !release.fullSeason &&
        release.size > 0 &&
        release.size <= cap &&
        release.rejections.every((reason) => EXISTING_FILE.test(reason)),
    )
    .sort((a, b) => b.size - a.size)[0];
}

const gb = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Tally {
  updated: number;
  failed: number;
}

async function enforceDefinitions(
  client: Client,
  config: SizeConfig,
  tally: Tally,
): Promise<void> {
  const definitions = records(
    await client.request("GET", "/qualitydefinition"),
  ).map(parseDefinition);
  for (const raw of definitions) {
    try {
      const { definition, changes } = capDefinition(
        raw,
        config.policy.maxMbPerMinute,
      );
      if (changes.length === 0) continue;
      const summary = `quality ${definition.title}: ${changes.join("; ")}`;
      if (config.dryRun) {
        log("INFO", `would update ${summary}`);
        continue;
      }
      await client.request(
        "PUT",
        `/qualitydefinition/${definition.id}`,
        definition,
      );
      tally.updated++;
      log("OK", `updated ${summary}`);
    } catch (error) {
      tally.failed++;
      log("ERROR", message(error));
    }
  }
}

async function ensureFormat(
  client: Client,
  config: SizeConfig,
): Promise<number | null> {
  const { policy, dryRun } = config;
  const formats = records(await client.request("GET", "/customformat"));
  const current = formats.find((format) => format.name === policy.formatName);
  if (current && formatMatches(current, policy)) {
    return num(current.id, "customformat.id");
  }
  const verb = current ? "update" : "create";
  const what = `custom format ${policy.formatName} (single episode > ${policy.maxEpisodeGB} GB)`;
  if (dryRun) {
    log("INFO", `would ${verb} ${what}`);
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
  log("OK", `${verb}d ${what}`);
  return num(saved.id, "customformat.id");
}

async function enforceProfiles(
  client: Client,
  config: SizeConfig,
  formatId: number,
  tally: Tally,
): Promise<void> {
  const profiles = records(await client.request("GET", "/qualityprofile"));
  for (const raw of profiles) {
    const { profile, changes } = scoreProfile(raw, formatId, config.policy);
    if (changes.length === 0) continue;
    const summary = `profile ${String(profile.name)}: ${changes.join("; ")}`;
    if (config.dryRun) {
      log("INFO", `would update ${summary}`);
      continue;
    }
    try {
      await client.request(
        "PUT",
        `/qualityprofile/${num(profile.id, "profile.id")}`,
        profile,
      );
      tally.updated++;
      log("OK", `updated ${summary}`);
    } catch (error) {
      tally.failed++;
      log("ERROR", `profile ${String(raw.name)}: ${message(error)}`);
    }
  }
}

async function enforceQueue(
  client: Client,
  config: SizeConfig,
  queue: QueueRecord[],
  tally: Tally,
): Promise<void> {
  for (const record of oversizedDownloads(queue, config.policy)) {
    const summary = `queued ${record.title} (${gb(record.size)})`;
    if (config.dryRun) {
      log("INFO", `would remove and blocklist ${summary}`);
      continue;
    }
    try {
      await client.request(
        "DELETE",
        `/queue/${record.id}?removeFromClient=true&blocklist=true&skipRedownload=false`,
        undefined,
        { once: true },
      );
      tally.updated++;
      log("OK", `removed and blocklisted ${summary}`);
    } catch (error) {
      tally.failed++;
      log("ERROR", `${summary}: ${message(error)}`);
    }
  }
}

async function searchReleases(
  config: SizeConfig,
  fetcher: typeof fetch,
  episodeId: number,
): Promise<Release[]> {
  const response = await fetcher(
    `${config.url}/api/v3/release?episodeId=${episodeId}`,
    {
      headers: { "X-Api-Key": config.apiKey },
      signal: AbortSignal.timeout(config.policy.searchTimeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(
      `GET /release?episodeId=${episodeId} failed: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  return records(await response.json()).map(parseRelease);
}

async function oversizedFiles(
  client: Client,
  policy: SizePolicy,
): Promise<EpisodeFile[]> {
  const series = records(await client.request("GET", "/series")).filter(
    (entry) =>
      isRecord(entry.statistics) &&
      typeof entry.statistics.episodeFileCount === "number" &&
      entry.statistics.episodeFileCount > 0,
  );
  const files: EpisodeFile[] = [];
  for (const entry of series) {
    const id = num(entry.id, "series.id");
    const list = records(
      await client.request("GET", `/episodefile?seriesId=${id}`),
    ).map(parseEpisodeFile);
    files.push(...list.filter((file) => file.size > capBytes(policy)));
  }
  return files.sort((a, b) => b.size - a.size);
}

async function replaceFiles(
  client: Client,
  config: SizeConfig,
  fetcher: typeof fetch,
  queuedEpisodes: Set<number>,
  tally: Tally,
): Promise<void> {
  const { policy, dryRun } = config;
  const files = await oversizedFiles(client, policy);
  log(
    "INFO",
    `${files.length} episode files larger than ${policy.maxEpisodeGB} GB`,
  );
  const episodesBySeries = new Map<number, Record<string, unknown>[]>();
  let searched = 0;
  for (const file of files) {
    if (searched >= policy.replaceLimit) break;
    const name = `${file.relativePath} (${gb(file.size)})`;
    try {
      let episodes = episodesBySeries.get(file.seriesId);
      if (!episodes) {
        episodes = records(
          await client.request("GET", `/episode?seriesId=${file.seriesId}`),
        );
        episodesBySeries.set(file.seriesId, episodes);
      }
      const episodeIds = episodes
        .filter((episode) => episode.episodeFileId === file.id)
        .map((episode) => num(episode.id, "episode.id"));
      const first = episodeIds[0];
      if (first === undefined) {
        log("WARN", `${name}: no episode references this file, skipped`);
        continue;
      }
      if (file.size <= capBytes(policy, episodeIds.length)) continue;
      if (episodeIds.some((id) => queuedEpisodes.has(id))) {
        log("INFO", `${name}: a download is queued, skipped`);
        continue;
      }
      searched++;
      const release = replacementFor(
        await searchReleases(config, fetcher, first),
        policy,
        episodeIds.length,
      );
      if (!release) {
        log("WARN", `${name}: no release within the cap, file kept`);
        continue;
      }
      const plan = `${name} with a search (e.g. ${release.title}, ${gb(release.size)})`;
      if (dryRun) {
        log("INFO", `would replace ${plan}`);
        continue;
      }
      await client.request("DELETE", `/episodefile/${file.id}`, undefined, {
        once: true,
      });
      await client.request(
        "POST",
        "/command",
        { name: "EpisodeSearch", episodeIds },
        { once: true },
      );
      tally.updated++;
      log("OK", `replacing ${plan}`);
    } catch (error) {
      tally.failed++;
      log("ERROR", `${name}: ${message(error)}`);
    }
  }
}

export async function enforce(
  config: SizeConfig,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const client = new Client(
    `${config.url}/api/v3`,
    { "X-Api-Key": config.apiKey },
    fetcher,
  );
  const tally: Tally = { updated: 0, failed: 0 };
  await enforceDefinitions(client, config, tally);
  const formatId = await ensureFormat(client, config);
  await enforceProfiles(client, config, formatId ?? -1, tally);
  const queue = parseQueue(
    await client.request(
      "GET",
      "/queue?page=1&pageSize=1000&includeUnknownSeriesItems=false",
    ),
  );
  await enforceQueue(client, config, queue, tally);
  if (config.policy.replaceLimit > 0) {
    await replaceFiles(
      client,
      config,
      fetcher,
      new Set(queue.map((record) => record.episodeId)),
      tally,
    );
  }
  log(
    tally.failed ? "ERROR" : "OK",
    `done: ${tally.updated} changes, ${tally.failed} failed${config.dryRun ? " (dry run)" : ""}`,
  );
  return tally.failed > 0 ? 1 : 0;
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  try {
    const config = readSizeConfig(argv, env, (path) =>
      readFileSync(path, "utf8"),
    );
    if (config === "help") {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    return await enforce(config, fetcher);
  } catch (error) {
    log("ERROR", message(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2), process.env));
}
