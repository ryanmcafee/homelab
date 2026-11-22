#!/usr/bin/env -S bun test
/**
 * Unit tests for charts/{sonarr,radarr}-config/files/arr-import-sweep.ts. The
 * API side is an in-process fetch stand-in; nothing talks to a cluster.
 *
 *   bun test scripts/arr-import-sweep_test.ts
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  blocklistTarget,
  Client,
  canonicalName,
  findSameCommand,
  HttpError,
  languageVerdict,
  safeRemove,
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

test("readConfig takes ARR_API_KEY without reading config.xml", () => {
  // Production mounts the key from a Secret and no config claim at all.
  const config = readConfig(
    [],
    { ARR_APP: "sonarr", ARR_URL: "u", IMPORT_PATH: "p", ARR_API_KEY: "k" },
    (path) => {
      throw new Error(`ENOENT: ${path}`);
    },
  );
  assert(config !== "help");
  assertEquals(config.apiKey, "k");
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
    const out = route(url, init);
    return out instanceof Response ? out : Response.json(out);
  };
  return Object.assign(handler, { preconnect: fetch.preconnect });
}

function sonarrRoutes(
  posted: unknown[],
  options: { root?: string; languages?: string[]; queue?: unknown[] } = {},
): Record<string, Route> {
  const root = options.root ?? "/downloads/completed/tv";
  const folder = `${root}/PULSE.S01E02.1080p.WEB-DL-GRP`;
  const file = `${folder}/PULSE.S01E02.1080p.WEB-DL-GRP.mkv`;
  const languages = (options.languages ?? ["English"]).map((name) => ({
    name,
  }));
  return {
    "GET /api/v3/filesystem": (url) =>
      url.searchParams.get("path") === `${folder}/`
        ? { directories: [], files: [{ name: "x.mkv", path: file }] }
        : {
            directories: [
              { name: "PULSE.S01E02.1080p.WEB-DL-GRP", path: `${folder}/` },
            ],
            files: [{ name: ".DS_Store", path: `${root}/.DS_Store` }],
          },
    "GET /api/v3/queue": () => ({ records: options.queue ?? [] }),
    "GET /api/v3/command": () => [],
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
        downloadId: "abc123",
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
          languages: canonical ? languages : [{ name: "Unknown" }],
        },
        series: canonical ? { id: 69 } : null,
        customFormatScore: canonical ? 0 : -10000,
        customFormats: languages.some((l) => l.name === "English")
          ? []
          : [{ name: "Not English" }],
        languages: canonical ? languages : [{ name: "Unknown" }],
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
  RETRY_DELAY_SECONDS: "0",
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
          languages: [{ name: "English" }],
          indexerFlags: 0,
          downloadId: "abc123",
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

const noSleep = { attempts: 5, delayMs: 100, sleep: async () => {} };

function flaky(
  failures: number,
  fail: () => Response | Error,
): {
  fetcher: typeof fetch;
  calls: () => number;
} {
  let calls = 0;
  const handler = async (): Promise<Response> => {
    calls++;
    if (calls <= failures) {
      const outcome = fail();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    return Response.json({ ok: true });
  };
  return {
    fetcher: Object.assign(handler, { preconnect: fetch.preconnect }),
    calls: () => calls,
  };
}

test("Client retries connection errors with doubling backoff", async () => {
  const delays: number[] = [];
  const { fetcher, calls } = flaky(4, () => new TypeError("Unable to connect"));
  const client = new Client("http://app", {}, fetcher, {
    ...noSleep,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  assertEquals(await client.request("GET", "/x"), { ok: true });
  assertEquals(calls(), 5);
  assertEquals(delays, [100, 200, 400, 800]);
});

test("Client retries 5xx and 429 but not other 4xx", async () => {
  const busy = flaky(2, () => new Response("busy", { status: 503 }));
  const client = new Client("http://app", {}, busy.fetcher, noSleep);
  assertEquals(await client.request("GET", "/x"), { ok: true });
  assertEquals(busy.calls(), 3);

  const missing = flaky(9, () => new Response("gone", { status: 404 }));
  let thrown: unknown;
  try {
    await new Client("http://app", {}, missing.fetcher, noSleep).request(
      "GET",
      "/x",
    );
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof HttpError && thrown.status === 404);
  assertEquals(missing.calls(), 1);
});

test("Client gives up after the last attempt and once means one attempt", async () => {
  const down = flaky(99, () => new TypeError("Unable to connect"));
  let message = "";
  try {
    await new Client("http://app", {}, down.fetcher, noSleep).request(
      "GET",
      "/x",
    );
  } catch (error) {
    message = String(error);
  }
  assertStringIncludes(message, "after 5 attempt(s)");
  assertEquals(down.calls(), 5);

  const once = flaky(99, () => new TypeError("Unable to connect"));
  try {
    await new Client("http://app", {}, once.fetcher, noSleep).request(
      "POST",
      "/command",
      {},
      { once: true },
    );
  } catch {}
  assertEquals(once.calls(), 1);
});

test("findSameCommand finds the command already acting on the same files", () => {
  const body = {
    name: "ManualImport",
    files: [{ path: "/d/a/a.mkv" }],
  };
  const commands = [
    { id: 1, name: "ManualImport", body: { files: [{ path: "/d/b/b.mkv" }] } },
    { id: 2, name: "ManualImport", body: { files: [{ path: "/d/a/a.mkv" }] } },
    { id: 3, name: "DownloadedEpisodesScan", body: { path: "/d/a/a.mkv" } },
  ];
  assertEquals(findSameCommand(commands, body)?.id, 2);
  assertEquals(
    findSameCommand(commands, { name: "DownloadedEpisodesScan", path: "/d/z" }),
    undefined,
  );
});

test("a lost ManualImport POST is found in the app's commands, never sent twice", async () => {
  const posted: unknown[] = [];
  const routes = sonarrRoutes(posted);
  const accept = routes["POST /api/v3/command"]!;
  routes["POST /api/v3/command"] = (url, init) => {
    const result = accept(url, init);
    if (JSON.parse(String(init?.body)).name === "ManualImport") {
      throw new TypeError("Unable to connect");
    }
    return result;
  };
  routes["GET /api/v3/command"] = () =>
    posted
      .filter((body) => (body as { name: string }).name === "ManualImport")
      .map((body, i) => ({ id: 50 + i, name: "ManualImport", body }));
  routes["GET /api/v3/command/50"] = () => ({ id: 50, status: "completed" });
  const fetcher = fakeFetch(routes, []);
  const handler: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (/^\/api\/v3\/command\/\d+$/.test(url.pathname)) {
        return Response.json({ id: 50, status: "completed" });
      }
      return fetcher(input, init);
    },
    { preconnect: fetch.preconnect },
  );
  assertEquals(await main([], sonarrEnv, handler), 0);
  assertEquals(
    posted.filter((body) => (body as { name: string }).name === "ManualImport")
      .length,
    1,
  );
});

test("a lost poll counts as done when the files left the downloads folder", async () => {
  const posted: unknown[] = [];
  const routes = sonarrRoutes(posted);
  routes["POST /api/v3/command"] = (_url, init) => {
    const body = JSON.parse(String(init?.body));
    posted.push(body);
    return { id: posted.length, name: body.name, status: "started" };
  };
  let imported = false;
  const fetcher = fakeFetch(routes, []);
  const handler: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/command/1") {
        return Response.json({ id: 1, status: "completed" });
      }
      if (url.pathname === "/api/v3/command/2") {
        imported = true;
        throw new TypeError("Unable to connect");
      }
      if (imported && url.pathname === "/api/v3/filesystem") {
        return Response.json({ directories: [], files: [] });
      }
      return fetcher(input, init);
    },
    { preconnect: fetch.preconnect },
  );
  assertEquals(await main([], sonarrEnv, handler), 0);
  assertEquals(posted.length, 2);
});

test("languageVerdict keeps anything with English and never judges Unknown", () => {
  assertEquals(languageVerdict(["German", "English"]), "english");
  assertEquals(languageVerdict(["english"]), "english");
  assertEquals(languageVerdict(["German"]), "non-english");
  assertEquals(languageVerdict(["Spanish", "Original"]), "non-english");
  assertEquals(languageVerdict(["Unknown"]), "unknown");
  assertEquals(languageVerdict(["Original"]), "unknown");
  assertEquals(languageVerdict([]), "unknown");
});

test("blocklistTarget prefers the queue item, then the grab in history", () => {
  const entry = {
    name: "Show.S01E01.GERMAN-GRP",
    path: "/d/tv/Show.S01E01.GERMAN-GRP",
  };
  const queue = [
    { id: 7, title: "Other", downloadId: "q1", outputPath: "/d/tv/Other" },
    {
      id: 8,
      title: "x",
      downloadId: "",
      outputPath: "/d/tv/Show.S01E01.GERMAN-GRP/",
    },
  ];
  const history = [
    {
      id: 90,
      itemId: 1,
      sourceTitle: "Show.S01E01.GERMAN-GRP",
      downloadId: "h1",
    },
    { id: 91, itemId: 1, sourceTitle: "Unrelated", downloadId: "ABC" },
  ];
  assertEquals(blocklistTarget(entry, ["q1"], queue, history), {
    kind: "queue",
    item: queue[0]!,
  });
  assertEquals(blocklistTarget(entry, [], queue, history), {
    kind: "queue",
    item: queue[1]!,
  });
  assertEquals(blocklistTarget(entry, ["abc"], [], history), {
    kind: "history",
    record: history[1]!,
  });
  assertEquals(blocklistTarget(entry, [], [], history), {
    kind: "history",
    record: history[0]!,
  });
  assertEquals(blocklistTarget(entry, [], [], []), null);
});

function scratch(): { root: string; category: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arr-sweep-")));
  const category = join(root, "completed", "tv");
  mkdirSync(category, { recursive: true });
  return { root, category };
}

test("safeRemove deletes only a real direct child of the category folder", () => {
  const { root, category } = scratch();
  try {
    const release = join(category, "Show.S01E01");
    mkdirSync(release);
    writeFileSync(join(release, "a.mkv"), "x");
    safeRemove(category, release);
    assert(!existsSync(release));

    const outside = join(root, "keep");
    mkdirSync(outside);
    const link = join(category, "link");
    symlinkSync(outside, link);
    assertThrows(() => safeRemove(category, link));
    assert(existsSync(outside));

    const nested = join(category, "a", "b");
    mkdirSync(nested, { recursive: true });
    assertThrows(() => safeRemove(category, nested));
    assert(existsSync(nested));

    assertThrows(() => safeRemove(category, join(category, "..", "keep")));
    assertThrows(() => safeRemove(category, category));
    assertThrows(() => safeRemove("/", join("/", "tmp")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-English release is reported, not touched, on a dry run", async () => {
  const { root, category } = scratch();
  try {
    mkdirSync(join(category, "PULSE.S01E02.1080p.WEB-DL-GRP"));
    const calls: string[] = [];
    const posted: unknown[] = [];
    const code = await main(
      ["--dry-run", "--remove-non-english"],
      { ...sonarrEnv, IMPORT_PATH: category },
      fakeFetch(
        sonarrRoutes(posted, { root: category, languages: ["German"] }),
        calls,
      ),
    );
    assertEquals(code, 0);
    assert(calls.every((call) => call.startsWith("GET ")));
    assert(existsSync(join(category, "PULSE.S01E02.1080p.WEB-DL-GRP")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-English release is blocklisted through the queue and deleted", async () => {
  const { root, category } = scratch();
  try {
    const release = join(category, "PULSE.S01E02.1080p.WEB-DL-GRP");
    mkdirSync(release);
    writeFileSync(join(release, "x.mkv"), "x");
    const calls: string[] = [];
    const posted: unknown[] = [];
    const routes = sonarrRoutes(posted, {
      root: category,
      languages: ["German"],
      queue: [{ id: 42, title: "other", downloadId: "abc123", outputPath: "" }],
    });
    routes["DELETE /api/v3/queue/42"] = () => ({});
    const code = await main(
      ["--remove-non-english"],
      { ...sonarrEnv, IMPORT_PATH: category },
      fakeFetch(routes, calls),
    );
    assertEquals(code, 0);
    assert(
      calls.includes(
        "DELETE /api/v3/queue/42?removeFromClient=true&blocklist=true",
      ),
    );
    assertEquals(
      posted.map((body) => (body as { name: string }).name),
      ["DownloadedEpisodesScan"],
    );
    assert(!existsSync(release));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a queue item the grab is marked failed; without either it still deletes", async () => {
  for (const history of [
    [{ id: 77, seriesId: 69, sourceTitle: "PULSE.S01E02.1080p.WEB-DL-GRP" }],
    [],
  ]) {
    const { root, category } = scratch();
    try {
      const release = join(category, "PULSE.S01E02.1080p.WEB-DL-GRP");
      mkdirSync(release);
      const calls: string[] = [];
      const routes = sonarrRoutes([], {
        root: category,
        languages: ["French"],
      });
      routes["GET /api/v3/history"] = () => ({ records: history });
      routes["POST /api/v3/history/failed/77"] = () => ({});
      const code = await main(
        ["--remove-non-english"],
        { ...sonarrEnv, IMPORT_PATH: category },
        fakeFetch(routes, calls),
      );
      assertEquals(code, 0);
      assertEquals(
        calls.includes("POST /api/v3/history/failed/77"),
        history.length > 0,
      );
      assert(!existsSync(release));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an English or Unknown release is never removed", async () => {
  for (const languages of [["German", "English"], ["Unknown"]]) {
    const { root, category } = scratch();
    try {
      const release = join(category, "PULSE.S01E02.1080p.WEB-DL-GRP");
      mkdirSync(release);
      const calls: string[] = [];
      await main(
        ["--remove-non-english"],
        { ...sonarrEnv, IMPORT_PATH: category },
        fakeFetch(sonarrRoutes([], { root: category, languages }), calls),
      );
      assert(!calls.some((call) => call.startsWith("DELETE ")));
      assert(existsSync(release));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
