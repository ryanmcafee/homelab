#!/usr/bin/env -S deno test
/**
 * Unit tests for the pure decision logic in cmp-parity-test.ts.
 *
 * The live parity check needs Docker and the registry; these do not. They cover
 * the one branch that decides whether a missing image tag is a failure or the
 * expected state of a PR that bumped it.
 *
 *   deno test scripts/
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { decideMissingTag, isUnknownTagError } from "./cmp-parity-test.ts";

Deno.test("decideMissingTag: a bumped tag is not a failure", () => {
  // cmp-image.yml builds the image on merge to main, so the PR that bumps the
  // tag necessarily references an image the registry does not have yet.
  assertEquals(decideMissingTag({ pinned: "0.1.12", base: "0.1.7" }), "bumped");
  assertEquals(decideMissingTag({ pinned: "0.2.0", base: "0.1.12" }), "bumped");
});

Deno.test("decideMissingTag: an unbumped missing tag is a failure", () => {
  // Same tag on both sides means nothing bumped it, so the image should exist
  // and does not: the cluster would pull nothing.
  assertEquals(decideMissingTag({ pinned: "0.1.7", base: "0.1.7" }), "missing");
});

Deno.test("decideMissingTag: whitespace does not change the verdict", () => {
  assertEquals(
    decideMissingTag({ pinned: " 0.1.7 ", base: "0.1.7\n" }),
    "missing",
  );
  assertEquals(
    decideMissingTag({ pinned: "0.1.8", base: " 0.1.7" }),
    "bumped",
  );
});

Deno.test("decideMissingTag: an unreadable base ref fails closed", () => {
  // The check must not pass because it could not find out.
  assertEquals(decideMissingTag({ pinned: "0.1.12", base: null }), "missing");
  assertEquals(decideMissingTag({ pinned: "0.1.12", base: "" }), "missing");
  assertEquals(decideMissingTag({ pinned: "0.1.12", base: "   " }), "missing");
});

Deno.test("isUnknownTagError: recognises the registry's wordings", () => {
  const unknown = [
    "Error response from daemon: manifest unknown",
    "Error response from daemon: manifest for ghcr.io/ryanmcafee/homelab-cmp:0.1.10 not found: manifest unknown: manifest unknown",
    "MANIFEST UNKNOWN",
    "manifest for x:1 not found",
  ];
  for (const stderr of unknown) {
    assertEquals(isUnknownTagError(stderr), true, stderr);
  }
});

Deno.test("isUnknownTagError: every other failure stays a failure", () => {
  const other = [
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    "unauthorized: authentication required",
    "net/http: TLS handshake timeout",
    "denied: permission_denied: read_package",
    "",
  ];
  for (const stderr of other) {
    assertEquals(isUnknownTagError(stderr), false, stderr);
  }
});
