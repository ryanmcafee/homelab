#!/usr/bin/env -S bun test
/**
 * Unit tests for the pure logic in unifi-setting.ts. Nothing here talks to
 * the UniFi controller.
 *
 *   bun test scripts/unifi-setting_test.ts
 */

import { test } from "bun:test";
import { assert, assertEquals, assertThrows } from "./lib/assert.ts";
import {
  parseArgs,
  planSetting,
  settingPath,
  UsageError,
} from "./unifi-setting.ts";

test("parseArgs with no arguments prints help", () => {
  assertEquals(parseArgs([], {}).command, "help");
  assertEquals(parseArgs(["apply", "--help"], {}).command, "help");
});

test("parseArgs get reads the key and defaults the site from UNIFI_SITE", () => {
  const args = parseArgs(["get", "netflow"], { UNIFI_SITE: "lab" });
  assertEquals(args.command, "get");
  assertEquals(args.key, "netflow");
  assertEquals(args.site, "lab");
  assertEquals(args.insecure, false);
});

test("parseArgs apply parses --data as a JSON object and accepts flags", () => {
  const args = parseArgs(
    [
      "apply",
      "netflow",
      "--site=default",
      "--insecure",
      "--dry-run",
      "--data",
      '{"enabled":true,"port":2055}',
    ],
    {},
  );
  assertEquals(args.command, "apply");
  assertEquals(args.site, "default");
  assertEquals(args.insecure, true);
  assertEquals(args.dryRun, true);
  assertEquals(args.data, { enabled: true, port: 2055 });
});

test("parseArgs apply without --data or with a non-object is a usage error", () => {
  assertThrows(() => parseArgs(["apply", "netflow"], {}), UsageError, "--data");
  assertThrows(
    () => parseArgs(["apply", "netflow", "--data", "[1]"], {}),
    UsageError,
    "JSON object",
  );
  assertThrows(
    () => parseArgs(["apply", "netflow", "--data", "{"], {}),
    UsageError,
    "JSON object",
  );
});

test("parseArgs rejects unknown subcommands, flags and invalid keys", () => {
  assertThrows(() => parseArgs(["set", "netflow"], {}), UsageError, "set");
  assertThrows(() => parseArgs(["get", "netflow", "--x"], {}), UsageError);
  assertThrows(() => parseArgs(["get", "../x"], {}), UsageError, "key");
  assertThrows(() => parseArgs(["get"], {}), UsageError, "key");
});

test("planSetting merges the desired fields over the current setting", () => {
  const current = {
    _id: "abc",
    key: "netflow",
    enabled: false,
    port: 2055,
    refresh_rate: 20,
  };
  const plan = planSetting(current, {
    enabled: true,
    server: "192.0.2.10",
    port: 2055,
  });
  assert(plan.changed, "enabled and server differ");
  assertEquals(plan.changes, [
    "enabled: false -> true",
    "server: unset -> 192.0.2.10",
  ]);
  assertEquals(plan.body, {
    _id: "abc",
    key: "netflow",
    enabled: true,
    port: 2055,
    refresh_rate: 20,
    server: "192.0.2.10",
  });
});

test("planSetting reports no change when every desired field matches", () => {
  const plan = planSetting(
    { key: "netflow", enabled: true, network_ids: ["a", "b"] },
    { enabled: true, network_ids: ["a", "b"] },
  );
  assertEquals(plan.changed, false);
  assertEquals(plan.changes, []);
});

test("settingPath builds the UniFi OS Network API paths for a site", () => {
  assertEquals(
    settingPath("get", "default", "netflow"),
    "/proxy/network/api/s/default/get/setting/netflow",
  );
  assertEquals(
    settingPath("set", "my site", "rsyslogd"),
    "/proxy/network/api/s/my%20site/set/setting/rsyslogd",
  );
});
