#!/usr/bin/env -S bun test
/**
 * Unit tests for charts/{sonarr,radarr}-config/files/arr-import-sweep.ts. The
 * API side is an in-process fetch stand-in; nothing talks to a cluster.
 *
 *   bun test scripts/arr-import-sweep_test.ts
 */

import { readFileSync } from "node:fs";
import { test } from "bun:test";
import {
  canonicalName,
  decide,
  type Episode,
  type FileCheck,
  fileBlocker,
  type ImportCandidate,
  isIdentityRejection,
  type LibraryItem,
  main,
  normalizeTitle,
  type ParsedRelease,
  type Profile,
  parseProfiles,
  pickBest,
  readConfig,
  scoreCandidates,
  targetEpisodes,
  titleSimilarity,
  yearScore,
} from "../charts/sonarr-config/files/arr-import-sweep.ts";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "./lib/assert.ts";

const series = (over: Partial<LibraryItem>): LibraryItem => ({
  id: 1,
  title: "Show",
  year: 2020,
  titles: [over.title ?? "Show"],
  tmdbId: 0,
  tvdbId: 0,
  monitored: true,
  hasFile: false,
  qualityProfileId: 1,
  ...over,
});

const episode = (over: Partial<Episode>): Episode => ({
  id: 100,
  seasonNumber: 1,
  episodeNumber: 1,
  hasFile: false,
  monitored: true,
  airYear: 2020,
  ...over,
});

const release = (over: Partial<ParsedRelease>): ParsedRelease => ({
  title: "Show",
  year: 0,
  season: 1,
  episodes: [1],
  fullSeason: false,
  appMatchId: null,
  ...over,
});

const noSignals = { tmdbIds: [], tvdbIds: [], historyIds: new Set<number>() };

test("normalizeTitle drops the year suffix, articles, punctuation and accents", () => {
  assertEquals(normalizeTitle("Pulse (2025)"), "pulse");
  assertEquals(normalizeTitle("The Four Seasons"), "four seasons");
  assertEquals(normalizeTitle("Grey's Anatomy"), "greys anatomy");
  assertEquals(normalizeTitle("Pokémon & Friends"), "pokemon and friends");
});

test("titleSimilarity is 1 for equal titles and low for unrelated ones", () => {
  assertEquals(titleSimilarity("PULSE", "Pulse (2025)"), 1);
  assert(titleSimilarity("Innato", "Innate") > 0.5);
  assert(titleSimilarity("Matlock", "Wheel of Fortune") < 0.3);
});

test("yearScore keeps movies strict and accepts a series airing year", () => {
  const show = series({ year: 2022 });
  assertEquals(yearScore(2022, show, false, null).score, 20);
  assertEquals(yearScore(2024, show, true, null).score, -100);
  assertEquals(yearScore(2023, show, true, null).score, 5);
  assertEquals(yearScore(2024, show, false, null).score, 0);
  assertEquals(yearScore(2019, show, false, null).score, -100);
  assertEquals(
    yearScore(2024, show, false, [episode({ airYear: 2024 })]).score,
    10,
  );
  assertEquals(
    yearScore(2026, series({ year: 1983 }), false, [episode({ airYear: 1983 })])
      .score,
    -100,
  );
});

test("targetEpisodes needs every named episode and expands a season pack", () => {
  const all = [
    episode({ id: 1, episodeNumber: 1 }),
    episode({ id: 2, episodeNumber: 2 }),
    episode({ id: 3, seasonNumber: 2, episodeNumber: 1 }),
  ];
  assertEquals(
    targetEpisodes(release({ episodes: [1, 2] }), all).map((e) => e.id),
    [1, 2],
  );
  assertEquals(targetEpisodes(release({ episodes: [1, 9] }), all), []);
  assertEquals(
    targetEpisodes(release({ fullSeason: true, episodes: [] }), all).map(
      (e) => e.id,
    ),
    [1, 2],
  );
  assertEquals(targetEpisodes(release({ season: null }), all), []);
});

test("a title-only match is the single library entry with that name", () => {
  const pulse = series({ id: 69, title: "Pulse (2025)", year: 2025 });
  const other = series({ id: 7, title: "Wheel of Fortune", year: 1983 });
  const episodes = new Map([
    [69, [episode({ id: 609, airYear: 2025 })]],
    [7, [episode({ id: 700, airYear: 1983 })]],
  ]);
  const scored = scoreCandidates(release({ title: "PULSE" }), [pulse, other], {
    tmdbIds: [247784],
    tvdbIds: [],
    historyIds: new Set(),
    episodes,
  });
  assertEquals(scored.length, 1);
  assertEquals(scored[0]!.item.id, 69);
  assertEquals(scored[0]!.reasons, [
    "title 1.00",
    "episodes exist",
    "episode wanted",
  ]);
  assertEquals(scored[0]!.score, 60);
  assertEquals(decide(scored, 60, 20).kind, "match");
  const withTmdb = scoreCandidates(
    release({ title: "PULSE" }),
    [{ ...pulse, tmdbId: 247784 }],
    { tmdbIds: [247784], tvdbIds: [], historyIds: new Set(), episodes },
  );
  assertEquals(withTmdb[0]!.score, 85);
  assertEquals(decide(withTmdb, 60, 20).kind, "match");
});

test("two same-named series are ambiguous unless a signal separates them", () => {
  const old = series({ id: 1, title: "Matlock", year: 1986, tvdbId: 11 });
  const reboot = series({
    id: 2,
    title: "Matlock (2024)",
    year: 2024,
    tvdbId: 22,
  });
  const episodes = new Map([
    [
      1,
      [episode({ id: 10, seasonNumber: 2, episodeNumber: 16, hasFile: true })],
    ],
    [
      2,
      [episode({ id: 20, seasonNumber: 2, episodeNumber: 16, hasFile: true })],
    ],
  ]);
  const parsed = release({ title: "Matlock", season: 2, episodes: [16] });
  const plain = scoreCandidates(parsed, [old, reboot], {
    ...noSignals,
    episodes,
  });
  const tie = decide(plain, 60, 20);
  assertEquals(tie.kind, "ambiguous");
  const history = scoreCandidates(parsed, [old, reboot], {
    ...noSignals,
    tvdbIds: [22],
    historyIds: new Set([2]),
    episodes,
  });
  const decision = decide(history, 60, 20);
  assertEquals(decision.kind, "match");
  if (decision.kind === "match") assertEquals(decision.best.item.id, 2);
});

test("a series whose episodes do not exist is disqualified", () => {
  const show = series({ id: 1 });
  const scored = scoreCandidates(release({ episodes: [40] }), [show], {
    ...noSignals,
    episodes: new Map([[1, [episode({})]]]),
  });
  assert(scored[0]!.score < 0);
  assertStringIncludes(scored[0]!.reasons.join(), "episodes missing");
});

test("a wanted movie with the right year matches", () => {
  const movie = series({ id: 5, title: "No Other Choice", year: 2025 });
  const scored = scoreCandidates(
    release({
      title: "No Other Choice",
      year: 2025,
      season: null,
      episodes: [],
    }),
    [movie, series({ id: 6, title: "No Other Choice", year: 1990 })],
    { ...noSignals, movies: true },
  );
  assertEquals(scored[0]!.item.id, 5);
  assertEquals(scored[0]!.score, 70);
  assertEquals(decide(scored, 60, 20).kind, "match");
});

test("decide wants a minimum score and a lead over the runner-up", () => {
  const scored = (score: number) => ({ item: series({}), score, reasons: [] });
  assertEquals(decide([], 60, 20).kind, "ambiguous");
  assertEquals(decide([scored(59)], 60, 20).kind, "ambiguous");
  assertEquals(decide([scored(90), scored(75)], 60, 20).kind, "ambiguous");
  assertEquals(decide([scored(90), scored(70)], 60, 20).kind, "match");
});

const profile: Profile = {
  id: 1,
  minFormatScore: 0,
  allowedQualities: new Set(["WEBDL-1080p"]),
  qualityRank: new Map([["WEBDL-1080p", 3]]),
};

const check = (over: Partial<FileCheck>): FileCheck => ({
  file: {
    path: "/downloads/completed/tv/a/a.mkv",
    name: "a",
    quality: { quality: { name: "WEBDL-1080p" } },
    languages: [],
    size: 1,
    rejections: [{ reason: "Unknown Series" }],
  },
  episodeIds: [1],
  qualityName: "WEBDL-1080p",
  formatScore: 0,
  languages: [],
  ...over,
});
const wanted = [{ hasFile: false, monitored: true }];

test("fileBlocker overrides only identity rejections and keeps quality decisions", () => {
  assertEquals(fileBlocker(check({}), wanted, profile), null);
  assert(
    isIdentityRejection(
      "Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible.",
    ),
  );
  assertStringIncludes(
    fileBlocker(
      check({
        file: {
          ...check({}).file,
          rejections: [{ reason: "No audio tracks detected" }],
        },
      }),
      wanted,
      profile,
    )!,
    "No audio tracks",
  );
  assertStringIncludes(
    fileBlocker(check({}), [{ hasFile: true, monitored: true }], profile)!,
    "already has a file",
  );
  assertEquals(
    fileBlocker(check({}), [{ hasFile: false, monitored: false }], profile),
    "not monitored",
  );
  assertEquals(fileBlocker(check({}), [], profile), "no matching episode");
  assertStringIncludes(
    fileBlocker(check({ qualityName: "SDTV" }), wanted, profile)!,
    "not allowed",
  );
  assertStringIncludes(
    fileBlocker(check({ formatScore: -10000 }), wanted, profile)!,
    "-10000 < profile minimum 0",
  );
  assertStringIncludes(
    fileBlocker(check({ formatScore: null }), wanted, profile)!,
    "cannot score",
  );
});

test("canonicalName rewrites the title part to the library title and year", () => {
  assertEquals(
    canonicalName("sonarr", "PULSE.S01E04.Treat.Em.2160p.NF.WEB-DL-TOSSATO", {
      title: "Pulse (2025)",
      year: 2025,
    }),
    "Pulse.2025.S01E04.Treat.Em.2160p.NF.WEB-DL-TOSSATO",
  );
  assertEquals(
    canonicalName("sonarr", "Sheriff Country (2026) S02E01 1080p WEB", {
      title: "Sheriff Country",
      year: 2025,
    }),
    "Sheriff.Country.2025.S02E01 1080p WEB",
  );
  assertEquals(
    canonicalName("radarr", "Harry.Potter.and.the.Sorcerers.Stone.2001.2160p", {
      title: "Harry Potter and the Philosopher's Stone",
      year: 2001,
    }),
    "Harry.Potter.and.the.Philosopher.s.Stone.2001.2160p",
  );
  assertEquals(
    canonicalName("sonarr", "no-token-here", { title: "X", year: 1 }),
    null,
  );
});

test("pickBest keeps the preferred release per episode", () => {
  const candidate = (
    name: string,
    keys: number[],
    rank: number,
    size = 1,
  ): ImportCandidate => ({
    entry: name,
    check: check({
      file: { ...check({}).file, path: `/d/${name}`, name, size },
    }),
    keys,
    rank,
    payload: {},
  });
  const hd = candidate("hd", [1], 3);
  const uhd = candidate("uhd", [1], 5);
  const pack = candidate("pack", [1, 2], 3, 10);
  const other = candidate("e2", [2], 3, 1);
  const { selected, superseded } = pickBest([hd, uhd, pack, other]);
  assertEquals(selected.map((c) => c.entry).sort(), ["e2", "uhd"]);
  assertEquals(
    superseded.map((s) => `${s.candidate.entry}>${s.by.entry}`).sort(),
    ["hd>uhd", "pack>uhd"],
  );
});

test("parseProfiles flattens quality groups into allowed names and ranks", () => {
  const profiles = parseProfiles([
    {
      id: 7,
      minFormatScore: 0,
      items: [
        { quality: { name: "SDTV" }, items: [], allowed: false },
        {
          name: "WEB 1080p",
          allowed: true,
          items: [
            { quality: { name: "WEBRip-1080p" }, items: [], allowed: false },
            { quality: { name: "WEBDL-1080p" }, items: [], allowed: false },
          ],
        },
      ],
    },
  ]);
  const parsed = profiles.get(7)!;
  assertEquals([...parsed.allowedQualities].sort(), [
    "WEBDL-1080p",
    "WEBRip-1080p",
  ]);
  assertEquals(parsed.qualityRank.get("SDTV"), 0);
  assertEquals(parsed.qualityRank.get("WEBDL-1080p"), 1);
});

test("readConfig takes flags over env and reads the key from config.xml", () => {
  const config = readConfig(
    ["--app", "radarr", "--dry-run"],
    { ARR_APP: "sonarr", ARR_URL: "http://r:7878/", IMPORT_PATH: "/d/movies/" },
    () => "<Config><ApiKey>abc</ApiKey></Config>",
  );
  assert(config !== "help");
  assertEquals(config.app, "radarr");
  assertEquals(config.url, "http://r:7878");
  assertEquals(config.importPath, "/d/movies");
  assertEquals(config.apiKey, "abc");
  assertEquals(config.dryRun, true);
  assertEquals(config.minScore, 60);
  assertEquals(
    readConfig(["--help"], {}, () => ""),
    "help",
  );
  assertThrows(() => readConfig(["--bogus"], {}, () => ""));
  assertThrows(() =>
    readConfig(
      [],
      { ARR_APP: "sonarr", ARR_URL: "u", IMPORT_PATH: "p" },
      () => "",
    ),
  );
  assertThrows(() =>
    readConfig(
      [],
      {
        ARR_APP: "sonarr",
        ARR_URL: "u",
        IMPORT_PATH: "p",
        ARR_API_KEY: "k",
        MIN_SCORE: "x",
      },
      () => "",
    ),
  );
});

test("the Sonarr and Radarr chart copies are identical", () => {
  const read = (chart: string) =>
    readFileSync(
      new URL(`../charts/${chart}/files/arr-import-sweep.ts`, import.meta.url),
      "utf8",
    );
  assert(read("sonarr-config") === read("radarr-config"));
});

type Route = (url: URL, init: RequestInit | undefined) => unknown;

function fakeFetch(
  routes: Record<string, Route>,
  calls: string[],
): typeof fetch {
  const handler = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response("not found", { status: 404 });
    return Response.json(route(url, init));
  };
  return Object.assign(handler, { preconnect: fetch.preconnect });
}

function sonarrRoutes(posted: unknown[]): Record<string, Route> {
  const folder = "/downloads/completed/tv/PULSE.S01E02.1080p.WEB-DL-GRP";
  const file = `${folder}/PULSE.S01E02.1080p.WEB-DL-GRP.mkv`;
  return {
    "GET /api/v3/filesystem": () => ({
      directories: [
        { name: "PULSE.S01E02.1080p.WEB-DL-GRP", path: `${folder}/` },
      ],
      files: [{ name: ".DS_Store", path: "/downloads/completed/tv/.DS_Store" }],
    }),
    "GET /api/v3/series": () => [
      {
        id: 69,
        title: "Pulse (2025)",
        year: 2025,
        tvdbId: 9,
        tmdbId: 247784,
        monitored: true,
        qualityProfileId: 7,
      },
    ],
    "GET /api/v3/qualityprofile": () => [
      {
        id: 7,
        minFormatScore: 0,
        items: [{ quality: { name: "WEBDL-1080p" }, items: [], allowed: true }],
      },
    ],
    "GET /api/v3/history": () => ({ records: [] }),
    "GET /api/v3/episode": () => [
      {
        id: 609,
        seasonNumber: 1,
        episodeNumber: 2,
        hasFile: false,
        monitored: true,
        airDate: "2025-10-03",
      },
    ],
    "GET /api/v3/manualimport": () => [
      {
        path: file,
        name: "PULSE.S01E02.1080p.WEB-DL-GRP",
        size: 5,
        quality: { quality: { name: "WEBDL-1080p" } },
        languages: [{ id: 0, name: "Unknown" }],
        rejections: [{ reason: "Unknown Series", type: "permanent" }],
      },
    ],
    "GET /api/v3/parse": (url) => {
      const title = url.searchParams.get("title") ?? "";
      const canonical = title.startsWith("Pulse.2025.");
      return {
        parsedEpisodeInfo: {
          seriesTitle: canonical ? "Pulse 2025" : "PULSE",
          seriesTitleInfo: {
            titleWithoutYear: canonical ? "Pulse" : "PULSE",
            year: canonical ? 2025 : 0,
          },
          seasonNumber: 1,
          episodeNumbers: [2],
          languages: [{ id: 1, name: "English" }],
        },
        series: canonical ? { id: 69 } : null,
        customFormatScore: canonical ? 0 : -10000,
        languages: [{ id: 1, name: "English" }],
      };
    },
    "POST /api/v3/command": (_url, init) => {
      const body = JSON.parse(String(init?.body));
      posted.push(body);
      return { id: posted.length, name: body.name, status: "completed" };
    },
  };
}

const sonarrEnv = {
  ARR_APP: "sonarr",
  ARR_URL: "http://sonarr:8989",
  IMPORT_PATH: "/downloads/completed/tv",
  ARR_API_KEY: "key",
  POLL_SECONDS: "0",
};

test("a dry run reports the match and sends no POST", async () => {
  const posted: unknown[] = [];
  const calls: string[] = [];
  const code = await main(
    ["--dry-run"],
    sonarrEnv,
    fakeFetch(sonarrRoutes(posted), calls),
  );
  assertEquals(code, 0);
  assertEquals(posted, []);
  assert(calls.every((call) => call.startsWith("GET ")));
});

test("a real run scans each entry, then manual-imports the matched file", async () => {
  const posted: unknown[] = [];
  const code = await main([], sonarrEnv, fakeFetch(sonarrRoutes(posted), []));
  assertEquals(code, 0);
  assertEquals(posted, [
    {
      name: "DownloadedEpisodesScan",
      path: "/downloads/completed/tv/PULSE.S01E02.1080p.WEB-DL-GRP",
      importMode: "Move",
    },
    {
      name: "ManualImport",
      importMode: "move",
      files: [
        {
          path: "/downloads/completed/tv/PULSE.S01E02.1080p.WEB-DL-GRP/PULSE.S01E02.1080p.WEB-DL-GRP.mkv",
          quality: { quality: { name: "WEBDL-1080p" } },
          languages: [{ id: 1, name: "English" }],
          indexerFlags: 0,
          seriesId: 69,
          episodeIds: [609],
          releaseType: "singleEpisode",
        },
      ],
    },
  ]);
});

test("a failed command fails the run", async () => {
  const routes = sonarrRoutes([]);
  routes["POST /api/v3/command"] = () => ({
    id: 1,
    status: "failed",
    message: "boom",
  });
  assertEquals(await main([], sonarrEnv, fakeFetch(routes, [])), 1);
});
