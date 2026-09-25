#!/usr/bin/env bun

/**
 * contract-check.ts
 *
 * The compatibility gate for the platform event contract (contracts/events/).
 * ADR-025 fixes the subject taxonomy and ADR-029 makes this check a boundary
 * quality gate; this script is the half a machine can enforce.
 *
 * Two things are checked, and they fail for different reasons:
 *
 *   1. Internal consistency — every registered type's subject parses under the
 *      seven-token grammar, lands on a declared domain, carries the suffix its
 *      pattern implies, agrees with the major version in its CloudEvents type,
 *      names a delivery guarantee the platform actually offers, and is covered
 *      by at least one JetStream stream. A subject no stream matches is an
 *      event published into a void.
 *
 *   2. Backward compatibility — the registry is diffed against the frozen
 *      baseline in contracts/events/registry.v1.baseline.json. Removing a
 *      stable type, weakening its delivery guarantee or ordering, changing its
 *      data schema in place, or adding a newly required envelope attribute are
 *      all breaking and all rejected. The fix is never to edit the baseline by
 *      hand: publish `...v2` alongside `...v1`.
 *
 * Usage:
 *   task contracts:check
 *   bun scripts/contract-check.ts check
 *   bun scripts/contract-check.ts baseline --write   # after an additive change
 *
 * Exit codes: 0 = contract is valid and compatible; 1 = violations found;
 * 2 = usage error or unreadable input.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "./lib/yaml.ts";

// ============================================================================
// Logging (stderr; stdout carries machine-readable output only)
// ============================================================================
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const log = {
  info: (msg: string) => console.error(`${cyan("INFO")}  ${msg}`),
  ok: (msg: string) => console.error(`${green("OK")}    ${msg}`),
  fail: (msg: string) => console.error(`${red("FAIL")}  ${msg}`),
};

// ============================================================================
// Contract shapes
// ============================================================================

export type Pattern = "pubsub" | "request_reply";
export type Delivery = "at_least_once" | "at_most_once";
export type Ordering = "per_subject" | "none";
export type Status = "stable" | "experimental";

export interface RegisteredType {
  type: string;
  subject: string;
  pattern: Pattern;
  durable_request?: boolean;
  delivery: Delivery;
  ordering: Ordering;
  dataschema?: string;
  dataless?: boolean;
  requires?: string[];
  producer: string;
  status: Status;
}

export interface Registry {
  version: number;
  types: RegisteredType[];
}

export interface Stream {
  name: string;
  subjects: string[];
  delivery: Delivery;
  ordering: Ordering;
}

export interface Taxonomy {
  version: number;
  grammar: { pattern: string; tokens: number; root: string };
  domains: Record<string, string>;
  streams: Stream[];
}

/** One violation. `rule` is stable so CI output can be grepped. */
export interface Violation {
  rule: string;
  subject: string;
  message: string;
}

/** The compatibility-relevant projection of a type. Everything else may change freely. */
export interface BaselineEntry {
  type: string;
  subject: string;
  pattern: Pattern;
  delivery: Delivery;
  ordering: Ordering;
  dataschema: string | null;
  requires: string[];
}

export const TENANT_SAMPLE = "t0";

// ============================================================================
// Subject grammar
// ============================================================================

/**
 * Substitute the tenant placeholder. Registry subjects are templates
 * (`pf.<tenant>.…`) because the tenant token is runtime data, not contract.
 */
export function renderSubject(
  template: string,
  tenant = TENANT_SAMPLE,
): string {
  return template.replace("<tenant>", tenant);
}

export interface ParsedSubject {
  root: string;
  tenant: string;
  domain: string;
  entity: string;
  action: string;
  major: string;
  suffix: "ev" | "rq" | "wq" | "rs";
}

/** Parse a rendered (not templated) subject. Returns null when it does not parse. */
export function parseSubject(subject: string): ParsedSubject | null {
  const t = subject.split(".");
  if (t.length !== 7) return null;
  const [root, tenant, domain, entity, action, major, suffix] = t as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (suffix !== "ev" && suffix !== "rq" && suffix !== "wq" && suffix !== "rs")
    return null;
  return { root, tenant, domain, entity, action, major, suffix };
}

/** The major version token carried inside the CloudEvents `type`, e.g. "v1". */
export function majorOfType(type: string): string | null {
  const last = type.split(".").pop() ?? "";
  return /^v[1-9][0-9]*$/.test(last) ? last : null;
}

/**
 * The tail of a CloudEvents `type` mirrors the subject:
 * `…​.<domain>.<entity>.<action>.<vN>`. Keeping the two in lockstep means a
 * reader who has one can derive the other, and neither can drift alone.
 */
export function tailOfType(
  type: string,
): { domain: string; entity: string; action: string } | null {
  const t = type.split(".");
  if (t.length < 5) return null;
  const [domain, entity, action] = t.slice(-4, -1) as [string, string, string];
  if (!domain || !entity || !action) return null;
  return { domain, entity, action };
}

/**
 * NATS subject match, supporting `*` (exactly one token) and `>` (one or more
 * trailing tokens). Written out rather than pulled in so the gate has no
 * runtime dependency on a NATS client.
 */
export function subjectMatches(filter: string, subject: string): boolean {
  const f = filter.split(".");
  const s = subject.split(".");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === ">") return s.length > i;
    if (i >= s.length) return false;
    if (f[i] !== "*" && f[i] !== s[i]) return false;
  }
  return f.length === s.length;
}

/** Streams whose subject filters cover `subject`. */
export function streamsFor(taxonomy: Taxonomy, subject: string): Stream[] {
  return taxonomy.streams.filter((st) =>
    st.subjects.some((filter) => subjectMatches(filter, subject)),
  );
}

// ============================================================================
// Rule 1 — internal consistency
// ============================================================================

const DELIVERIES: Delivery[] = ["at_least_once", "at_most_once"];

export function validateRegistry(
  registry: Registry,
  taxonomy: Taxonomy,
): Violation[] {
  const out: Violation[] = [];
  const grammar = new RegExp(taxonomy.grammar.pattern);
  const seenTypes = new Set<string>();
  const seenSubjects = new Set<string>();

  for (const t of registry.types) {
    const subject = renderSubject(t.subject);
    const v = (rule: string, message: string) =>
      out.push({ rule, subject: t.type, message });

    if (seenTypes.has(t.type))
      v("duplicate-type", `${t.type} is registered twice`);
    seenTypes.add(t.type);
    if (seenSubjects.has(subject))
      v("duplicate-subject", `subject ${subject} is registered twice`);
    seenSubjects.add(subject);

    if (!grammar.test(subject)) {
      v("subject-grammar", `${subject} does not match the seven-token grammar`);
      continue; // every rule below reads parsed tokens
    }

    const p = parseSubject(subject);
    if (!p) {
      v("subject-grammar", `${subject} did not parse into seven tokens`);
      continue;
    }

    if (p.root !== taxonomy.grammar.root)
      v(
        "subject-root",
        `${subject} must start with "${taxonomy.grammar.root}."`,
      );

    if (!(p.domain in taxonomy.domains))
      v(
        "unknown-domain",
        `domain "${p.domain}" is not declared in subjects.v1.yaml; adding a domain is additive, using an undeclared one is not`,
      );

    // The suffix is the guarantee a reader sees without opening the registry, so it
    // must agree with the declared pattern and durability rather than restate it.
    const wantSuffix =
      t.pattern === "pubsub" ? "ev" : t.durable_request ? "wq" : "rq";
    if (p.suffix !== wantSuffix)
      v(
        "suffix-mismatch",
        `pattern "${t.pattern}"${
          t.pattern === "request_reply"
            ? ` with durable_request: ${t.durable_request}`
            : ""
        } requires the "${wantSuffix}" suffix, subject ends in "${p.suffix}"`,
      );

    const major = majorOfType(t.type);
    if (!major)
      v("type-version", `${t.type} does not end in an explicit major version`);
    else if (major !== p.major)
      v(
        "version-mismatch",
        `type says ${major}, subject says ${p.major}; the version lives in both and must agree`,
      );

    const tail = tailOfType(t.type);
    if (!tail)
      v(
        "type-shape",
        `${t.type} must end in <domain>.<entity>.<action>.<major>`,
      );
    else {
      if (tail.domain !== p.domain)
        v(
          "domain-mismatch",
          `type domain "${tail.domain}" does not match subject domain "${p.domain}"`,
        );
      if (tail.entity !== p.entity)
        v(
          "entity-mismatch",
          `type entity "${tail.entity}" does not match subject entity "${p.entity}"`,
        );
      if (tail.action !== p.action)
        v(
          "action-mismatch",
          `type action "${tail.action}" does not match subject action "${p.action}"`,
        );
    }

    if (!DELIVERIES.includes(t.delivery))
      v(
        "delivery-guarantee",
        `delivery "${t.delivery}" is not offered; the platform has no exactly-once path (ADR-025)`,
      );

    if (t.pattern === "pubsub") {
      if (t.delivery !== "at_least_once")
        v(
          "pubsub-delivery",
          "pub/sub runs over JetStream and is at_least_once; nothing else is truthful",
        );
      if (t.ordering !== "per_subject")
        v("pubsub-ordering", "pub/sub over JetStream is ordered per subject");
      if (t.durable_request !== undefined)
        v(
          "durable-request-on-pubsub",
          "durable_request applies to request_reply only",
        );
    } else {
      if (t.durable_request === undefined)
        v(
          "durable-request-missing",
          "request_reply must declare durable_request; it selects PF_WORK vs core NATS",
        );
      else if (t.durable_request && t.delivery !== "at_least_once")
        v(
          "durable-request-delivery",
          "durable_request: true goes through PF_WORK and is at_least_once",
        );
      else if (!t.durable_request && t.delivery !== "at_most_once")
        v(
          "core-request-delivery",
          "durable_request: false is core NATS and is at_most_once; the requester retries",
        );
      if (t.ordering !== "none")
        v(
          "request-ordering",
          "request/reply has no cross-request ordering guarantee",
        );
      if (!t.durable_request && !(t.requires ?? []).includes("replyto"))
        v(
          "replyto-required",
          "a synchronous request must require the replyto attribute",
        );
      if (!(t.requires ?? []).includes("correlationid"))
        v(
          "correlationid-required",
          "request/reply must require correlationid so a reply can be tied to its request",
        );
    }

    if (!t.dataless && !t.dataschema)
      v(
        "dataschema-required",
        "a type with a body must publish a dataschema; an unpublished payload is not a contract",
      );

    if (!t.producer)
      v("producer-required", "every type has exactly one owning producer");

    // `rq`/`rs` are core NATS and deliberately match no stream. Everything
    // persisted must be covered, or it is published with nothing to replay it.
    const matched = streamsFor(taxonomy, subject);
    if (p.suffix === "rq") {
      if (matched.length > 0)
        v(
          "synchronous-request-persisted",
          `${subject} is a synchronous request but is captured by stream(s) ${matched
            .map((s) => s.name)
            .join(", ")}; core NATS request/reply must not be persisted`,
        );
    } else if (matched.length === 0) {
      v(
        "no-stream",
        `no stream in subjects.v1.yaml covers ${subject}; it would be published with nothing to replay it`,
      );
    }
    for (const st of matched) {
      if (st.delivery !== t.delivery && t.pattern === "pubsub")
        v(
          "stream-delivery-mismatch",
          `stream ${st.name} offers ${st.delivery} but the type claims ${t.delivery}`,
        );
    }
  }

  return out;
}

// ============================================================================
// Rule 2 — backward compatibility
// ============================================================================

export function toBaseline(registry: Registry): BaselineEntry[] {
  return registry.types
    .filter((t) => t.status === "stable")
    .map((t) => ({
      type: t.type,
      subject: t.subject,
      pattern: t.pattern,
      delivery: t.delivery,
      ordering: t.ordering,
      dataschema: t.dataschema ?? null,
      requires: [...(t.requires ?? [])].sort(),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * A guarantee may only be strengthened. at_most_once -> at_least_once is fine
 * (a consumer written for at_most_once already tolerates loss and, being
 * idempotent, tolerates repeats); the reverse silently breaks anyone relying on
 * redelivery. Same reasoning for ordering.
 */
const DELIVERY_RANK: Record<Delivery, number> = {
  at_most_once: 0,
  at_least_once: 1,
};
const ORDERING_RANK: Record<Ordering, number> = { none: 0, per_subject: 1 };

export function checkCompatibility(
  baseline: BaselineEntry[],
  current: Registry,
): Violation[] {
  const out: Violation[] = [];
  const now = new Map(current.types.map((t) => [t.type, t]));

  for (const was of baseline) {
    const is = now.get(was.type);
    const v = (rule: string, message: string) =>
      out.push({ rule, subject: was.type, message });

    if (!is) {
      v(
        "removed-stable-type",
        "a stable type was removed; assume a consumer you cannot redeploy still subscribes — publish a vN+1 instead and keep this one",
      );
      continue;
    }

    if (is.subject !== was.subject)
      v(
        "subject-moved",
        `subject changed ${was.subject} -> ${is.subject}; existing consumers filter on the old subject`,
      );

    if (is.pattern !== was.pattern)
      v(
        "pattern-changed",
        `pattern changed ${was.pattern} -> ${is.pattern}; this changes how every consumer is wired`,
      );

    if (DELIVERY_RANK[is.delivery] < DELIVERY_RANK[was.delivery])
      v(
        "delivery-weakened",
        `delivery weakened ${was.delivery} -> ${is.delivery}; consumers relying on redelivery lose data`,
      );

    if (ORDERING_RANK[is.ordering] < ORDERING_RANK[was.ordering])
      v(
        "ordering-weakened",
        `ordering weakened ${was.ordering} -> ${is.ordering}`,
      );

    const isSchema = is.dataschema ?? null;
    if (isSchema !== was.dataschema)
      v(
        "dataschema-replaced",
        `dataschema changed ${was.dataschema} -> ${isSchema} within the same major version; evolve the existing schema additively or cut a new major`,
      );

    const added = (is.requires ?? []).filter((r) => !was.requires.includes(r));
    if (added.length > 0)
      v(
        "required-attribute-added",
        `newly required envelope attributes [${added.join(", ")}]; existing producers do not set them`,
      );
  }

  return out;
}

// ============================================================================
// Loading
// ============================================================================

export const CONTRACTS_DIR = "contracts/events";
export const REGISTRY_FILE = "registry.v1.yaml";
export const TAXONOMY_FILE = "subjects.v1.yaml";
export const BASELINE_FILE = "registry.v1.baseline.json";

export function loadRegistry(dir = CONTRACTS_DIR): Registry {
  return parseYaml(readFileSync(join(dir, REGISTRY_FILE), "utf8")) as Registry;
}

export function loadTaxonomy(dir = CONTRACTS_DIR): Taxonomy {
  return parseYaml(readFileSync(join(dir, TAXONOMY_FILE), "utf8")) as Taxonomy;
}

export function loadBaseline(dir = CONTRACTS_DIR): BaselineEntry[] {
  return JSON.parse(
    readFileSync(join(dir, BASELINE_FILE), "utf8"),
  ) as BaselineEntry[];
}

export function renderViolations(violations: Violation[]): string {
  if (violations.length === 0) return "contract ok";
  return violations
    .map((v) => `${v.rule}: ${v.subject}\n    ${v.message}`)
    .join("\n");
}

// ============================================================================
// CLI
// ============================================================================

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "check";
  const dir = CONTRACTS_DIR;

  if (cmd === "baseline") {
    const registry = loadRegistry(dir);
    const baseline = toBaseline(registry);
    const body = `${JSON.stringify(baseline, null, 2)}\n`;
    if (argv.includes("--write")) {
      writeFileSync(join(dir, BASELINE_FILE), body);
      log.ok(
        `wrote ${join(dir, BASELINE_FILE)} (${baseline.length} stable types)`,
      );
      return 0;
    }
    process.stdout.write(body);
    return 0;
  }

  if (cmd !== "check") {
    log.fail(`unknown command "${cmd}"; expected check | baseline`);
    return 2;
  }

  const registry = loadRegistry(dir);
  const taxonomy = loadTaxonomy(dir);
  const baseline = loadBaseline(dir);

  const violations = [
    ...validateRegistry(registry, taxonomy),
    ...checkCompatibility(baseline, registry),
  ];

  if (violations.length > 0) {
    log.fail(`${violations.length} contract violation(s)`);
    console.error(renderViolations(violations));
    return 1;
  }

  log.ok(
    `${registry.types.length} registered types across ${taxonomy.streams.length} streams; ${baseline.length} stable types compatible with the baseline`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    log.fail(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
