#!/usr/bin/env -S bun test
/**
 * Unit tests for the pure logic in tailscale-dns.ts. Nothing here talks to
 * 1Password or the Tailscale API.
 *
 *   bun test scripts/tailscale-dns_test.ts
 */

import { test } from "bun:test";
import { assert, assertEquals, assertThrows } from "./lib/assert.ts";
import {
  DEFAULT_OAUTH_REF,
  DEFAULT_TAILNET,
  envFileValue,
  formatStatus,
  parseArgs,
  planRemove,
  planSplitDns,
  UsageError,
} from "./tailscale-dns.ts";

const ENV = { domain: "example.com", nameserver: "192.0.2.1" };

test("parseArgs with no arguments prints help", () => {
  assertEquals(parseArgs([], ENV).command, "help");
  assertEquals(parseArgs(["--help"], ENV).command, "help");
  assertEquals(parseArgs(["apply", "-h"], ENV).command, "help");
});

test("parseArgs apply defaults domain and nameserver from the environment file values", () => {
  const args = parseArgs(["apply"], ENV);
  assertEquals(args.command, "apply");
  assertEquals(args.domain, "example.com");
  assertEquals(args.nameservers, ["192.0.2.1"]);
  assertEquals(args.oauthRef, DEFAULT_OAUTH_REF);
  assertEquals(args.tailnet, DEFAULT_TAILNET);
  assertEquals(args.dryRun, false);
});

test("parseArgs flags override the environment file and --nameserver repeats", () => {
  const args = parseArgs(
    [
      "apply",
      "--domain",
      "Lab.Example.NET.",
      "--nameserver",
      "10.0.0.53",
      "--nameserver=10.0.1.53",
      "--oauth-ref",
      "op://vault/item",
      "--tailnet",
      "example.com",
      "--dry-run",
    ],
    ENV,
  );
  assertEquals(args.domain, "lab.example.net");
  assertEquals(args.nameservers, ["10.0.0.53", "10.0.1.53"]);
  assertEquals(args.oauthRef, "op://vault/item");
  assertEquals(args.tailnet, "example.com");
  assertEquals(args.dryRun, true);
});

test("parseArgs accepts a -- separator from the task runner", () => {
  const args = parseArgs(["apply", "--", "--dry-run"], ENV);
  assertEquals(args.command, "apply");
  assertEquals(args.dryRun, true);
});

test("parseArgs apply without a domain or nameserver is a usage error", () => {
  assertThrows(
    () => parseArgs(["apply"], { nameserver: "192.0.2.1" }),
    UsageError,
    "--domain",
  );
  assertThrows(
    () => parseArgs(["apply"], { domain: "example.com" }),
    UsageError,
    "--nameserver",
  );
});

test("parseArgs remove needs a domain but no nameserver", () => {
  const args = parseArgs(["remove"], { domain: "example.com" });
  assertEquals(args.command, "remove");
  assertEquals(args.domain, "example.com");
  assertEquals(args.nameservers, []);
  assertThrows(() => parseArgs(["remove"], {}), UsageError, "--domain");
});

test("parseArgs status needs neither domain nor nameserver", () => {
  const args = parseArgs(["status"], {});
  assertEquals(args.command, "status");
  assertEquals(args.domain, undefined);
});

test("parseArgs rejects malformed values", () => {
  assertThrows(
    () => parseArgs(["apply", "--nameserver", "300.1.1.1"], ENV),
    UsageError,
    "nameserver",
  );
  assertThrows(
    () => parseArgs(["apply", "--nameserver", "gateway"], ENV),
    UsageError,
    "nameserver",
  );
  assertThrows(
    () => parseArgs(["apply", "--domain", "not a domain"], ENV),
    UsageError,
    "domain",
  );
  assertThrows(
    () => parseArgs(["apply", "--oauth-ref", "vault/item"], ENV),
    UsageError,
    "op://",
  );
  assertThrows(
    () => parseArgs(["apply", "--oauth-ref", "op://vault/item/"], ENV),
    UsageError,
    "op://",
  );
  assertThrows(
    () => parseArgs(["apply", "--tailnet", "bad tailnet"], ENV),
    UsageError,
    "tailnet",
  );
  assertThrows(
    () => parseArgs(["apply", "--domain"], ENV),
    UsageError,
    "value",
  );
  assertThrows(
    () => parseArgs(["apply", "--bogus"], ENV),
    UsageError,
    "unknown flag",
  );
  assertThrows(
    () => parseArgs(["frobnicate"], ENV),
    UsageError,
    "unknown subcommand",
  );
  assertThrows(
    () => parseArgs(["status", "extra"], ENV),
    UsageError,
    "unexpected",
  );
});

test("parseArgs accepts an IPv6 nameserver", () => {
  const args = parseArgs(["apply", "--nameserver", "fd7a:115c:a1e0::53"], ENV);
  assertEquals(args.nameservers, ["fd7a:115c:a1e0::53"]);
});

test("envFileValue reads a trimmed string and rejects placeholders", () => {
  const text = 'DOMAIN: " Example.COM "\nGATEWAY_IP: "192.0.2.1"\nEMPTY: ""\n';
  assertEquals(envFileValue(text, "DOMAIN"), "example.com");
  assertEquals(envFileValue(text, "GATEWAY_IP"), "192.0.2.1");
  assertEquals(envFileValue(text, "EMPTY"), null);
  assertEquals(envFileValue(text, "MISSING"), null);
  assertEquals(envFileValue("DOMAIN: REPLACEME-domain.com\n", "DOMAIN"), null);
  assertEquals(envFileValue("GATEWAY_IP: 1\n", "GATEWAY_IP"), null);
  assertEquals(envFileValue(":: not yaml", "DOMAIN"), null);
  assertEquals(envFileValue("- a list\n", "DOMAIN"), null);
});

test("planSplitDns reports no change when the domain already maps to the same nameservers", () => {
  const current = {
    "example.com": ["10.0.1.53", "10.0.0.53"],
    "other.test": ["10.9.9.9"],
  };
  const plan = planSplitDns(current, "example.com", ["10.0.0.53", "10.0.1.53"]);
  assertEquals(plan.changed, false);
  assertEquals(plan.current, ["10.0.1.53", "10.0.0.53"]);
  assertEquals(plan.patch, { "example.com": ["10.0.0.53", "10.0.1.53"] });
});

test("planSplitDns patches only the requested domain", () => {
  const current = { "other.test": ["10.9.9.9"] };
  const plan = planSplitDns(current, "example.com", ["192.0.2.1"]);
  assertEquals(plan.changed, true);
  assertEquals(plan.current, undefined);
  // PATCH semantics: other domains are untouched because they are absent.
  assertEquals(plan.patch, { "example.com": ["192.0.2.1"] });
});

test("planSplitDns detects a nameserver change for an existing domain", () => {
  const plan = planSplitDns({ "example.com": ["10.0.0.1"] }, "example.com", [
    "192.0.2.1",
  ]);
  assertEquals(plan.changed, true);
  assertEquals(plan.current, ["10.0.0.1"]);
});

test("planRemove clears a domain with null and is a no-op when absent", () => {
  assertEquals(planRemove({ "example.com": ["10.0.0.1"] }, "example.com"), {
    changed: true,
    current: ["10.0.0.1"],
    patch: { "example.com": null },
  });
  assertEquals(planRemove({}, "example.com").changed, false);
});

test("formatStatus lists MagicDNS, global nameservers, search paths and split DNS", () => {
  const text = formatStatus({
    magicDNS: true,
    nameservers: ["1.1.1.1"],
    searchPaths: ["corp.test"],
    splitDns: {
      "example.com": ["192.0.2.1"],
      "other.test": ["10.9.9.9", "10.9.9.10"],
    },
  });
  assert(text.includes("MagicDNS: enabled"));
  assert(text.includes("1.1.1.1"));
  assert(text.includes("corp.test"));
  assert(text.includes("example.com -> 192.0.2.1"));
  assert(text.includes("other.test -> 10.9.9.9, 10.9.9.10"));
});

test("formatStatus says so when nothing is configured", () => {
  const text = formatStatus({
    magicDNS: false,
    nameservers: [],
    searchPaths: [],
    splitDns: {},
  });
  assert(text.includes("MagicDNS: disabled"));
  assert(text.includes("(none)"));
});
