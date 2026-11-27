#!/usr/bin/env -S bun test
/**
 * Unit tests for charts/sonarr-config/files/arr-size-policy.ts. The API side is
 * an in-process fetch stand-in; nothing talks to a cluster.
 *
 *   bun test scripts/arr-size-policy_test.ts
 */

import { test } from "bun:test";
import {
  capDefinition,
  desiredSpecifications,
  formatMatches,
  main,
  oversizedDownloads,
  parseDefinition,
  readSizeConfig,
  replacementFor,
  type SizePolicy,
  scoreProfile,
} from "../charts/sonarr-config/files/arr-size-policy.ts";
import { assert, assertEquals, assertThrows } from "./lib/assert.ts";

const GIB = 1024 ** 3;

const policy: SizePolicy = {
  maxEpisodeGB: 10,
  maxMbPerMinute: 170,
  formatName: "Oversize",
  score: -10000,
  replaceLimit: 5,
  searchTimeoutMs: 1000,
};

const env = { ARR_URL: "http://sonarr:8989", ARR_API_KEY: "k" };

test("readSizeConfig applies the defaults", () => {
  const config = readSizeConfig([], env, () => "");
  assert(config !== "help");
  assertEquals(config.policy, { ...policy, searchTimeoutMs: 300_000 });
  assertEquals(config.dryRun, false);
});

test("readSizeConfig reads the API key from config.xml", () => {
  const config = readSizeConfig(
    ["--dry-run"],
    { ARR_URL: "http://sonarr:8989/" },
    () => "<Config><ApiKey>abc</ApiKey></Config>",
  );
  assert(config !== "help");
  assertEquals(
    [config.apiKey, config.url, config.dryRun],
    ["abc", "http://sonarr:8989", true],
  );
});

test("readSizeConfig rejects invalid numbers", () => {
  for (const bad of [
    { MAX_EPISODE_GB: "0" },
    { MAX_EPISODE_GB: "1000" },
    { MAX_MB_PER_MINUTE: "x" },
    { REPLACE_LIMIT: "-1" },
    { REPLACE_LIMIT: "1.5" },
    { OVERSIZE_FORMAT_SCORE: "5" },
  ]) {
    assertThrows(() => readSizeConfig([], { ...env, ...bad }, () => ""));
  }
  const config = readSizeConfig([], { ...env, REPLACE_LIMIT: "0" }, () => "");
  assert(config !== "help" && config.policy.replaceLimit === 0);
});

const definition = (maxSize: number | null, preferredSize = 95) =>
  parseDefinition({
    id: 21,
    title: "Bluray-2160p",
    quality: { id: 19, name: "Bluray-2160p" },
    minSize: 35,
    maxSize,
    preferredSize,
  });

test("capDefinition caps an unlimited or larger maximum and the preferred size", () => {
  assertEquals(capDefinition(definition(null), 170).changes, [
    "max unlimited -> 170 MB/min",
  ]);
  const { definition: capped, changes } = capDefinition(
    definition(400, 300),
    170,
  );
  assertEquals(changes, [
    "max 400 -> 170 MB/min",
    "preferred 300 -> 170 MB/min",
  ]);
  assertEquals(
    [capped.maxSize, capped.preferredSize, capped.quality],
    [170, 170, { id: 19, name: "Bluray-2160p" }],
  );
});

test("capDefinition leaves a compliant definition alone and refuses a minimum above the cap", () => {
  assertEquals(capDefinition(definition(130), 170).changes, []);
  assertThrows(() => capDefinition(definition(130), 30));
});

test("formatMatches only accepts the exact size and single-episode specifications", () => {
  const format = {
    name: "Oversize",
    specifications: desiredSpecifications(policy),
  };
  assert(formatMatches(format, policy));
  assert(!formatMatches(format, { ...policy, maxEpisodeGB: 8 }));
  const negated = structuredClone(format);
  const first = negated.specifications[0];
  assert(first !== undefined);
  first.negate = true;
  assert(!formatMatches(negated, policy));
  assert(
    !formatMatches(
      { specifications: desiredSpecifications(policy).slice(0, 1) },
      policy,
    ),
  );
});

test("scoreProfile sets the score once", () => {
  const profile = {
    id: 7,
    name: "4K",
    formatItems: [{ format: 3, name: "Not English", score: -10000 }],
  };
  const added = scoreProfile(profile, 6, policy);
  assertEquals(added.changes, ["score format Oversize -10000 (was unset)"]);
  assertEquals(added.profile.formatItems.length, 2);
  assertEquals(scoreProfile(added.profile, 6, policy).changes, []);
  const zero = {
    ...profile,
    formatItems: [{ format: 6, name: "Oversize", score: 0 }],
  };
  assertEquals(scoreProfile(zero, 6, policy).changes, [
    "score format Oversize -10000 (was 0)",
  ]);
});

test("oversizedDownloads judges a season pack per episode", () => {
  const record = (id: number, downloadId: string, size: number) => ({
    id,
    downloadId,
    episodeId: id,
    title: downloadId,
    size,
  });
  const result = oversizedDownloads(
    [
      record(1, "single", 37 * GIB),
      record(2, "pack", 50 * GIB),
      record(3, "pack", 50 * GIB),
      record(4, "pack", 50 * GIB),
      record(5, "pack", 50 * GIB),
      record(6, "pack", 50 * GIB),
      record(7, "small", 5 * GIB),
    ],
    policy,
  );
  assertEquals(
    result.map((r) => r.id),
    [1],
  );
});

const release = (
  title: string,
  sizeGB: number,
  rejections: string[] = [],
  fullSeason = false,
) => ({ guid: title, title, size: sizeGB * GIB, fullSeason, rejections });

test("replacementFor picks the largest release within the cap that only the existing file blocks", () => {
  const picked = replacementFor(
    [
      release("too-big", 37, ["Existing file meets cutoff: WEB 2160p"]),
      release("web-2160p", 5.1, ["Existing file meets cutoff: WEB 2160p"]),
      release("web-1080p", 4.6),
      release("german", 5, ["Custom Formats Not English have score -10000"]),
      release("pack", 8, [], true),
    ],
    policy,
    1,
  );
  assertEquals(picked?.title, "web-2160p");
  assertEquals(
    replacementFor(
      [release("sd", 0.4, ["SDTV is not wanted in profile"])],
      policy,
      1,
    ),
    undefined,
  );
  assertEquals(replacementFor([release("two", 15)], policy, 2)?.title, "two");
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function fakeSonarr(): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const state = {
    formats: [] as Record<string, unknown>[],
    definitions: [
      {
        id: 15,
        title: "WEBDL-1080p",
        minSize: 4,
        maxSize: 130,
        preferredSize: 95,
      },
      {
        id: 21,
        title: "Bluray-2160p",
        minSize: 35,
        maxSize: null,
        preferredSize: 95,
      },
    ],
    profiles: [{ id: 7, name: "4K", formatItems: [] }],
    queue: {
      records: [
        {
          id: 50,
          downloadId: "a",
          episodeId: 900,
          title: "Big.S03E07",
          size: 37 * GIB,
        },
      ],
    },
    series: [
      { id: 208, statistics: { episodeFileCount: 3 } },
      { id: 209, statistics: { episodeFileCount: 0 } },
    ],
    files: [
      { id: 1, seriesId: 208, relativePath: "S03E04.mkv", size: 36 * GIB },
      { id: 2, seriesId: 208, relativePath: "S03E05.mkv", size: 33 * GIB },
      { id: 3, seriesId: 208, relativePath: "S03E06.mkv", size: 4 * GIB },
      { id: 4, seriesId: 208, relativePath: "S03E07.mkv", size: 30 * GIB },
    ],
    episodes: [
      { id: 800, episodeFileId: 1 },
      { id: 801, episodeFileId: 2 },
      { id: 802, episodeFileId: 3 },
      { id: 900, episodeFileId: 4 },
    ],
    releases: {
      "800": [release("web", 5, ["Existing file meets cutoff: WEB 2160p"])],
      "801": [release("bluray", 33)],
    } as Record<string, unknown>,
  };
  const fetcher: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/api\/v3/, "");
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: `${path}${url.search}`, body });
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 });
      if (method !== "GET") {
        if (method === "POST" && path === "/customformat")
          return json({ ...body, id: 6 });
        return json(body ?? {});
      }
      switch (path) {
        case "/qualitydefinition":
          return json(state.definitions);
        case "/customformat":
          return json(state.formats);
        case "/qualityprofile":
          return json(state.profiles);
        case "/queue":
          return json(state.queue);
        case "/series":
          return json(state.series);
        case "/episodefile":
          return json(
            state.files.filter(
              (file) =>
                String(file.seriesId) === url.searchParams.get("seriesId"),
            ),
          );
        case "/episode":
          return json(state.episodes);
        case "/release":
          return json(
            state.releases[url.searchParams.get("episodeId") ?? ""] ?? [],
          );
      }
      return new Response("not found", { status: 404 });
    },
    { preconnect: fetch.preconnect },
  );
  return { fetcher, calls };
}

test("main caps definitions, scores the format, blocklists the queue and replaces what it can", async () => {
  const { fetcher, calls } = fakeSonarr();
  const code = await main([], env, fetcher);
  assertEquals(code, 0);
  const writes = calls.filter((call) => call.method !== "GET");
  assertEquals(
    writes.map((call) => `${call.method} ${call.path}`),
    [
      "PUT /qualitydefinition/21",
      "POST /customformat",
      "PUT /qualityprofile/7",
      "DELETE /queue/50?removeFromClient=true&blocklist=true&skipRedownload=false",
      "DELETE /episodefile/1",
      "POST /command",
    ],
  );
  assertEquals(writes.at(-1)?.body, {
    name: "EpisodeSearch",
    episodeIds: [800],
  });
  const searches = calls.filter((call) => call.path.startsWith("/release"));
  assertEquals(
    searches.map((call) => call.path),
    ["/release?episodeId=800", "/release?episodeId=801"],
  );
});

test("main honours REPLACE_LIMIT", async () => {
  const { fetcher, calls } = fakeSonarr();
  assertEquals(await main([], { ...env, REPLACE_LIMIT: "1" }, fetcher), 0);
  assertEquals(
    calls.filter((call) => call.path.startsWith("/release")).length,
    1,
  );
  const none = fakeSonarr();
  assertEquals(await main([], { ...env, REPLACE_LIMIT: "0" }, none.fetcher), 0);
  assert(!none.calls.some((call) => call.path.startsWith("/episodefile")));
});

test("main --dry-run sends no write", async () => {
  const { fetcher, calls } = fakeSonarr();
  assertEquals(await main(["--dry-run"], env, fetcher), 0);
  assertEquals(
    calls.filter((call) => call.method !== "GET"),
    [],
  );
});
