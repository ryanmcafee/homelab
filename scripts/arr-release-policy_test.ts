#!/usr/bin/env -S bun test
/**
 * Unit tests for charts/{sonarr,radarr}-config/files/arr-release-policy.ts. The
 * API side is an in-process fetch stand-in; nothing talks to a cluster.
 *
 *   bun test scripts/arr-release-policy_test.ts
 */

import { readFileSync } from "node:fs";
import { test } from "bun:test";
import {
  type BanPolicy,
  enforceProfile,
  formatMatches,
  main,
  readPolicyConfig,
} from "../charts/sonarr-config/files/arr-release-policy.ts";
import { assert, assertEquals, assertThrows } from "./lib/assert.ts";

const policy: BanPolicy = {
  formatName: "Remux",
  titlePattern: "remux",
  qualityPattern: /remux/i,
  score: -10000,
};

const quality = (id: number, name: string, allowed = true) => ({
  quality: { id, name, source: "bluray", resolution: 1080 },
  items: [],
  allowed,
});

const radarrProfile = () => ({
  id: 5,
  name: "Ultra-HD",
  upgradeAllowed: false,
  cutoff: 31,
  minFormatScore: 0,
  items: [
    quality(18, "HDTV-2160p"),
    {
      id: 1003,
      name: "WEB 2160p",
      items: [quality(19, "WEBDL-2160p"), quality(16, "WEBRip-2160p")],
      allowed: true,
    },
    quality(31, "Bluray-2160p"),
    quality(30, "Remux-2160p"),
  ],
  formatItems: [{ format: 1, name: "Not English", score: -10000 }],
});

test("enforceProfile disallows Remux qualities and scores the format", () => {
  const { profile, changes } = enforceProfile(radarrProfile(), 9, policy);
  const items = profile.items;
  assert(Array.isArray(items));
  assertEquals(
    items.map((item) => item.allowed),
    [true, true, true, false],
  );
  assertEquals(profile.formatItems, [
    { format: 1, name: "Not English", score: -10000 },
    { format: 9, name: "Remux", score: -10000 },
  ]);
  assertEquals(changes, [
    "disallow quality Remux-2160p",
    "score format Remux -10000 (was unset)",
  ]);
});

test("enforceProfile moves a Remux cutoff to the best allowed quality below it", () => {
  const raw = radarrProfile();
  raw.cutoff = 30;
  const { profile, changes } = enforceProfile(raw, 9, policy);
  assertEquals(profile.cutoff, 31);
  assert(changes.includes("cutoff Remux-2160p -> Bluray-2160p"));
});

test("enforceProfile moves a cutoff to a group id when the group is next below", () => {
  const raw = radarrProfile();
  raw.items = [raw.items[1]!, raw.items[3]!];
  raw.cutoff = 30;
  const { profile } = enforceProfile(raw, 9, policy);
  assertEquals(profile.cutoff, 1003);
});

test("enforceProfile disallows a group whose only allowed members are banned", () => {
  const raw = radarrProfile();
  raw.items = [
    quality(31, "Bluray-2160p"),
    {
      id: 1010,
      name: "Remuxes",
      items: [quality(30, "Remux-2160p"), quality(20, "Remux-1080p")],
      allowed: true,
    },
  ];
  raw.cutoff = 1010;
  const { profile } = enforceProfile(raw, 9, policy);
  const group = profile.items[1];
  assert(group !== undefined);
  assertEquals(group.allowed, false);
  assertEquals(profile.cutoff, 31);
});

test("enforceProfile overwrites a different score and reports nothing when compliant", () => {
  const raw = radarrProfile();
  raw.items = raw.items.slice(0, 3);
  raw.formatItems.push({ format: 9, name: "Remux", score: 50 });
  const first = enforceProfile(raw, 9, policy);
  assertEquals(first.changes, ["score format Remux -10000 (was 50)"]);
  assertEquals(enforceProfile(first.profile, 9, policy).changes, []);
});

test("enforceProfile refuses a profile that would allow no quality at all", () => {
  const raw = radarrProfile();
  raw.items = [quality(30, "Remux-2160p")];
  raw.cutoff = 30;
  assertThrows(
    () => enforceProfile(raw, 9, policy),
    Error,
    "no allowed quality",
  );
});

test("formatMatches compares the release title specification", () => {
  const format = (value: string) => ({
    name: "Remux",
    specifications: [
      {
        implementation: "ReleaseTitleSpecification",
        negate: false,
        required: true,
        fields: [{ name: "value", value }],
      },
    ],
  });
  assert(formatMatches(format("remux"), policy));
  assert(!formatMatches(format("\\bREMUX\\b"), policy));
  assert(!formatMatches({ name: "Remux", specifications: [] }, policy));
});

test("readPolicyConfig reads the API key from config.xml and validates the score", () => {
  const config = readPolicyConfig(
    [],
    { ARR_URL: "http://radarr:7878/" },
    () => "<Config><ApiKey>abc</ApiKey></Config>",
  );
  assert(config !== "help");
  assertEquals(config.apiKey, "abc");
  assertEquals(config.url, "http://radarr:7878");
  assertEquals(config.policy.score, -10000);
  assertThrows(
    () =>
      readPolicyConfig(
        [],
        { ARR_URL: "u", ARR_API_KEY: "k", BANNED_FORMAT_SCORE: "5" },
        () => "",
      ),
    Error,
    "negative",
  );
  assertEquals(
    readPolicyConfig(["--help"], {}, () => ""),
    "help",
  );
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeArr(state: {
  formats: Record<string, unknown>[];
  profiles: ReturnType<typeof radarrProfile>[];
}): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/api\/v3/, "");
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 });
      if (method === "GET" && path === "/customformat")
        return json(state.formats);
      if (method === "POST" && path === "/customformat") {
        const created = { ...body, id: 9 };
        state.formats.push(created);
        return json(created);
      }
      if (method === "GET" && path === "/qualityprofile")
        return json(state.profiles);
      if (method === "PUT" && path.startsWith("/qualityprofile/"))
        return json(body);
      return new Response("not found", { status: 404 });
    },
    { preconnect: fetch.preconnect },
  );
  return { fetcher, calls };
}

test("main creates the format, then updates only non-compliant profiles", async () => {
  const compliant = radarrProfile();
  compliant.id = 6;
  compliant.items = compliant.items.slice(0, 3);
  compliant.formatItems.push({ format: 9, name: "Remux", score: -10000 });
  const { fetcher, calls } = fakeArr({
    formats: [],
    profiles: [radarrProfile(), compliant],
  });
  const code = await main(
    [],
    { ARR_URL: "http://radarr:7878", ARR_API_KEY: "k" },
    fetcher,
  );
  assertEquals(code, 0);
  const writes = calls.filter((call) => call.method !== "GET");
  assertEquals(
    writes.map((call) => `${call.method} ${call.path}`),
    ["POST /customformat", "PUT /qualityprofile/5"],
  );
});

test("main --dry-run sends no write", async () => {
  const { fetcher, calls } = fakeArr({
    formats: [],
    profiles: [radarrProfile()],
  });
  const code = await main(
    ["--dry-run"],
    { ARR_URL: "http://radarr:7878", ARR_API_KEY: "k" },
    fetcher,
  );
  assertEquals(code, 0);
  assertEquals(
    calls.filter((call) => call.method !== "GET"),
    [],
  );
});

test("the Sonarr and Radarr chart copies are identical", () => {
  const read = (chart: string) =>
    readFileSync(
      new URL(
        `../charts/${chart}/files/arr-release-policy.ts`,
        import.meta.url,
      ),
      "utf8",
    );
  assertEquals(read("radarr-config"), read("sonarr-config"));
});
