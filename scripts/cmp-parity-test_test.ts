#!/usr/bin/env -S bun test
/**
 * Unit tests for the pure decision logic in cmp-parity-test.ts.
 *
 * The live parity check needs Docker and the registry; these do not. They cover
 * the one branch that decides whether a missing image tag is a failure or the
 * expected state of a PR that bumped it.
 *
 *   bun test scripts/cmp-parity-test_test.ts
 */

import { test } from "bun:test";
import { assertEquals } from "./lib/assert.ts";
import {
  decideMissingTag,
  isPlatformMismatchError,
  isUnknownTagError,
} from "./cmp-parity-test.ts";

test("decideMissingTag: a bumped tag is not a failure", () => {
  // cmp-image.yml builds the image on merge to main, so the PR that bumps the
  // tag necessarily references an image the registry does not have yet.
  assertEquals(decideMissingTag({ pinned: "0.1.12", base: "0.1.7" }), "bumped");
  assertEquals(decideMissingTag({ pinned: "0.2.0", base: "0.1.12" }), "bumped");
});

test("decideMissingTag: an unbumped missing tag is a failure", () => {
  // Same tag on both sides means nothing bumped it, so the image should exist
  // and does not: the cluster would pull nothing.
  assertEquals(decideMissingTag({ pinned: "0.1.7", base: "0.1.7" }), "missing");
});

test("decideMissingTag: whitespace does not change the verdict", () => {
  assertEquals(
    decideMissingTag({ pinned: " 0.1.7 ", base: "0.1.7\n" }),
    "missing",
  );
  assertEquals(decideMissingTag({ pinned: "0.1.8", base: " 0.1.7" }), "bumped");
});

test("decideMissingTag: an unreadable base ref fails closed", () => {
  // The check must not pass because it could not find out.
  assertEquals(decideMissingTag({ pinned: "0.1.12", base: null }), "missing");
  assertEquals(decideMissingTag({ pinned: "0.1.12", base: "" }), "missing");
  assertEquals(decideMissingTag({ pinned: "0.1.12", base: "   " }), "missing");
});

test("isUnknownTagError: recognises the registry's wordings", () => {
  const unknown = [
    "Error response from daemon: manifest unknown",
    "Error response from daemon: manifest for ghcr.io/ryanmcafee/homelab-cmp:0.1.10 not found: manifest unknown: manifest unknown",
    "MANIFEST UNKNOWN",
    "manifest for x:1 not found",
    // Docker 29.2 with the containerd image store says only this — no
    // "manifest" anywhere. Matching just the two older wordings made a bumped
    // tag read as a hard failure, which is how this was found: the first live
    // run of `task test:cmp-parity` still exited 1.
    'Error response from daemon: failed to resolve reference "ghcr.io/ryanmcafee/homelab-cmp:0.1.12": ghcr.io/ryanmcafee/homelab-cmp:0.1.12: not found',
  ];
  for (const stderr of unknown) {
    assertEquals(isUnknownTagError(stderr), true, stderr);
  }
});

test("isUnknownTagError: every other failure stays a failure", () => {
  const other = [
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    "unauthorized: authentication required",
    "net/http: TLS handshake timeout",
    "denied: permission_denied: read_package",
    // Ambiguous between "absent" and "no credentials", so it must stay a
    // failure: excusing it would turn a missing login into a green check.
    "pull access denied for ghcr.io/ryanmcafee/homelab-cmp, repository does not exist or may require 'docker login'",
    // A resolve failure that is not a 404 is still a failure.
    'failed to resolve reference "ghcr.io/x:1": unexpected status from HEAD request: 403 Forbidden',
    // A platform mismatch ends in "not found" too, but the tag is present: the
    // image simply has no build for this architecture. Reading it as a missing
    // tag would report a published image as absent.
    "no matching manifest for linux/arm64/v8 in the manifest list entries: no match for platform in manifest: not found",
    "",
  ];
  for (const stderr of other) {
    assertEquals(isUnknownTagError(stderr), false, stderr);
  }
});

test("isPlatformMismatchError: the amd64-only image on an arm64 machine", () => {
  // cmp-image.yml builds without a `platforms:` list, so the image is
  // linux/amd64 only and a pull on an arm64 workstation fails this way. The fix
  // is --platform, not a rebuild, so it must not be confused with either a
  // missing tag or drift.
  const mismatches = [
    "Error response from daemon: no matching manifest for linux/arm64/v8 in the manifest list entries: no match for platform in manifest: not found",
    "no match for platform in manifest",
  ];
  for (const stderr of mismatches) {
    assertEquals(isPlatformMismatchError(stderr), true, stderr);
    assertEquals(isUnknownTagError(stderr), false, stderr);
  }
});

test("isPlatformMismatchError: a genuinely missing tag is not a platform problem", () => {
  const notPlatform = [
    "Error response from daemon: manifest unknown",
    'Error response from daemon: failed to resolve reference "ghcr.io/x:1": ghcr.io/x:1: not found',
    "Cannot connect to the Docker daemon",
    "",
  ];
  for (const stderr of notPlatform) {
    assertEquals(isPlatformMismatchError(stderr), false, stderr);
  }
});
