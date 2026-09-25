#!/usr/bin/env bun

/**
 * contract-check.ts
 *
 * The compatibility gate for the platform event contract (contracts/events/).
 * ADR-026 fixes the subject taxonomy and ADR-030 makes this check a boundary
 * quality gate; this script is the half a machine can enforce.
 *
 * Two things are checked, and they fail for different reasons:
 *
 *   1. Internal consistency — every registered type's subject parses under the
 *      seven-token grammar, lands on a declared domain, carries the suffix its
 *      pattern implies, agrees with the major version in its CloudEvents type,
 *      names a delivery guarantee the platform actually offers, and is covered
 *      by at least one JetStream stream. A subject no stream matches is an
 *      event published into a void. The stream set itself is checked for the
 *      things a real nats-server refuses: overlapping subject filters between
 *      two streams (`10065`, which makes the second stream UNCREATABLE) and a
 *      hard-coded `replicas` a single-node fork cannot satisfy (`10074`).
 *
 *   2. Backward compatibility — the whole contract is diffed against the frozen
 *      baseline in contracts/events/registry.v1.baseline.json: the registered
 *      types, the envelope's own `required` list, the stream set, and the
 *      subject grammar. Removing a stable type, demoting it to experimental,
 *      weakening its delivery guarantee or ordering, changing its data schema
 *      in place, adding OR removing a required attribute, reassigning its
 *      producer, emptying its body, narrowing a stream filter, shortening a
 *      retention, or loosening the grammar are all breaking and all rejected.
 *      The fix is never to edit the baseline by hand: publish `...v2` alongside
 *      `...v1`. `baseline --write` exists for genuinely additive change and is
 *      deliberately a visible diff in the pull request, not a silent one.
 *
 * ADR-038 records why each of these rules exists; every one of them was added
 * because a real breaking change walked past the gate green.
 *
 * Usage:
 *   task contracts:check
 *   bun scripts/contract-check.ts check
 *   bun scripts/contract-check.ts baseline --write   # after an additive change
 *
 * Exit codes: 0 = contract is valid and compatible; 1 = violations found;
 * 2 = usage error or unreadable input.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
export type Suffix = "ev" | "rq" | "wq" | "dl";

export interface RegisteredType {
  type: string;
  subject: string;
  pattern: Pattern;
  delivery: Delivery;
  ordering: Ordering;
  dataschema?: string;
  dataless?: boolean;
  requires?: string[];
  /** `wq` only: the registered `.ev` type that reports the outcome. */
  completion?: string;
  producer: string;
  status: Status;
}

export interface Registry {
  version: number;
  types: RegisteredType[];
}

/** A stream that sources from another rather than ingesting subjects itself. */
export interface StreamSource {
  name: string;
  filters: string[];
}

export interface Stream {
  name: string;
  subjects: string[];
  sources?: StreamSource[];
  replicas?: string | number;
  retention?: string;
  max_age?: string;
  discard?: string;
  delivery: Delivery;
  ordering: Ordering;
}

export interface Taxonomy {
  version: number;
  grammar: { pattern: string; tokens: number; root: string };
  domains: Record<string, string>;
  streams: Stream[];
}

/** The envelope schema, read only for the fields the gate pins. */
export interface Envelope {
  required: string[];
  properties: Record<string, { pattern?: string }>;
}

/**
 * A payload (`dataschema`) file, read only for the fields the gate pins.
 *
 * `additionalProperties` is read because it decides whether the additive path
 * this contract calls non-breaking is actually available to a consumer: a
 * consumer validating against a vendored copy with `additionalProperties: false`
 * rejects every event carrying a property added after it shipped.
 */
export interface PayloadSchema {
  properties?: Record<string, { type?: string | string[] }>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * The compatibility-relevant projection of one payload schema.
 *
 * ADR-038 published the eleven payload files the registry had always
 * referenced, which turned `dataschema` from a dangling path into a boundary
 * contract. The gate pinned the *path* and nothing inside it, so adding a
 * required payload property — a hard break for every producer and consumer —
 * passed. ADR-030's rule is that boundary contracts are gated, not reviewed.
 */
export interface BaselinePayload {
  /** Property name -> declared JSON type, `"unknown"` when untyped. */
  properties: Record<string, string>;
  required: string[];
  additionalProperties: boolean;
}

/** One violation. `rule` is stable so CI output can be grepped. */
export interface Violation {
  rule: string;
  subject: string;
  message: string;
}

/**
 * The compatibility-relevant projection of a type.
 *
 * `status`, `dataless` and `producer` are here because each one was a breaking
 * change that passed the gate while they were not: demoting a type to
 * `experimental` removes it from the baseline entirely on the next regeneration,
 * `dataless: true` empties the body of a type consumers already read, and
 * `producer` is the trust boundary that publish permission is granted against.
 */
export interface BaselineEntry {
  type: string;
  subject: string;
  pattern: Pattern;
  delivery: Delivery;
  ordering: Ordering;
  dataschema: string | null;
  dataless: boolean;
  requires: string[];
  completion: string | null;
  producer: string;
  status: Status;
  /** Null for a `dataless` type, or when the file did not resolve. */
  payload: BaselinePayload | null;
}

/** The compatibility-relevant projection of a stream. */
export interface BaselineStream {
  name: string;
  subjects: string[];
  sources: StreamSource[];
  retention: string | null;
  max_age: string | null;
  discard: string | null;
  delivery: Delivery;
  ordering: Ordering;
}

/**
 * The whole frozen contract, not just the type list. An earlier baseline was a
 * bare array of types, which left the envelope schema and the stream set
 * completely unguarded — `docs/contracts/event-contract.md` claimed the gate
 * rejected a newly required envelope attribute while the gate never opened the
 * envelope file at all.
 */
export interface Baseline {
  version: number;
  grammar: { pattern: string; tokens: number };
  envelope: { required: string[] };
  streams: BaselineStream[];
  types: BaselineEntry[];
}

export const TENANT_SAMPLE = "t0";
export const TENANT_PLACEHOLDER = "<tenant>";
export const REPLICAS_PLACEHOLDER = "<replicas>";
export const TOKEN_COUNT = 7;

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
  suffix: Suffix;
}

export const SUFFIXES: Suffix[] = ["ev", "rq", "wq", "dl"];

/** Parse a rendered (not templated) subject. Returns null when it does not parse. */
export function parseSubject(subject: string): ParsedSubject | null {
  const t = subject.split(".");
  if (t.length !== TOKEN_COUNT) return null;
  const [root, tenant, domain, entity, action, major, suffix] = t as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!SUFFIXES.includes(suffix as Suffix)) return null;
  return {
    root,
    tenant,
    domain,
    entity,
    action,
    major,
    suffix: suffix as Suffix,
  };
}

/** The dead-letter subject derived from a `wq` subject: same tokens, `dl` suffix. */
export function deadLetterSubjectOf(subject: string): string {
  const t = subject.split(".");
  t[t.length - 1] = "dl";
  return t.join(".");
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
    (st.subjects ?? []).some((filter) => subjectMatches(filter, subject)),
  );
}

/**
 * True when two subject filters can match the same subject.
 *
 * This is the rule that makes a stream set creatable or not. Two streams in one
 * NATS account may not have overlapping subject filters; the server refuses the
 * second with `subjects overlap with an existing stream (10065)`, so an overlap
 * is not a duplicate-delivery trade-off a design can choose to accept — it means
 * one of the two streams does not exist. Reading a stream config never told
 * anyone this, which is exactly why it belongs in the gate.
 */
export function filtersOverlap(a: string, b: string): boolean {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const xi = x[i];
    const yi = y[i];
    if (xi === ">" || yi === ">") return true; // `>` swallows whatever remains
    if (xi === undefined || yi === undefined) return false; // one ran out first
    if (xi === "*" || yi === "*") continue; // a wildcard matches the other token
    if (xi !== yi) return false;
  }
  return x.length === y.length;
}

/**
 * True when filter `wide` matches every subject filter `narrow` can match.
 * Used to tell a genuinely additive filter change from a narrowing one, which
 * silently stops capturing events a consumer is still expecting to replay.
 */
export function filterCovers(wide: string, narrow: string): boolean {
  const w = wide.split(".");
  const n = narrow.split(".");
  for (let i = 0; i < w.length; i++) {
    if (w[i] === ">") return n.length >= i; // `>` needs at least one token, or ends here
    if (i >= n.length) return false;
    if (w[i] === "*") {
      if (n[i] === ">") return false; // `>` reaches further than one token
      continue;
    }
    if (w[i] !== n[i]) return false; // a literal covers only itself
  }
  return w.length === n.length;
}

const DURATION_UNITS: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/** Parse a Go-style duration (`24h`, `2m`, `720h`) to seconds. Null when unparseable. */
export function durationSeconds(
  value: string | null | undefined,
): number | null {
  if (!value) return null;
  const m = /^([0-9]+(?:\.[0-9]+)?)(ns|us|ms|s|m|h|d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * (DURATION_UNITS[m[2] as string] as number);
}

// ============================================================================
// Rule 1 — internal consistency
// ============================================================================

const DELIVERIES: Delivery[] = ["at_least_once", "at_most_once"];

/**
 * Checks on the stream set itself, independent of any registered type.
 *
 * Everything here is a thing a real nats-server refuses at create time. A
 * contract that describes a stream the server will not build is worse than no
 * contract, because CI says it is fine.
 */
export function validateTaxonomy(taxonomy: Taxonomy): Violation[] {
  const out: Violation[] = [];
  const v = (rule: string, subject: string, message: string) =>
    out.push({ rule, subject, message });

  if (taxonomy.grammar.tokens !== TOKEN_COUNT)
    v(
      "grammar-token-count",
      "grammar",
      `grammar.tokens is ${taxonomy.grammar.tokens}; the taxonomy is ${TOKEN_COUNT} tokens and the parser assumes it. Changing the token count changes every wildcard guarantee in the contract`,
    );

  const byName = new Set<string>();
  for (const st of taxonomy.streams) {
    if (byName.has(st.name))
      v("duplicate-stream", st.name, `stream ${st.name} is declared twice`);
    byName.add(st.name);

    // Fork-ability: a hard-coded replicas > 1 makes every stream uncreatable on
    // the single-node install a stranger forking this repo actually has.
    if (st.replicas !== REPLICAS_PLACEHOLDER)
      v(
        "replicas-hardcoded",
        st.name,
        `replicas is ${JSON.stringify(st.replicas)}; it must be the literal ${REPLICAS_PLACEHOLDER} placeholder, because a single-node fork cannot create a replicated stream ("replicas > 1 not supported in non-clustered mode", 10074) and defaults belong in replicas_defaults`,
      );

    if ((st.subjects ?? []).length === 0 && (st.sources ?? []).length === 0)
      v(
        "stream-ingests-nothing",
        st.name,
        "a stream with neither subjects nor sources receives nothing",
      );

    // A sourced stream may only source subjects its upstream actually captures.
    for (const src of st.sources ?? []) {
      const upstream = taxonomy.streams.find((s) => s.name === src.name);
      if (!upstream) {
        v(
          "source-stream-unknown",
          st.name,
          `sources from ${src.name}, which is not a declared stream`,
        );
        continue;
      }
      for (const f of src.filters ?? []) {
        if (!(upstream.subjects ?? []).some((u) => filterCovers(u, f)))
          v(
            "source-filter-uncovered",
            st.name,
            `source filter ${f} is not covered by any subject filter on ${src.name}; it would mirror nothing`,
          );
      }
    }
  }

  // The 10065 rule. Only DIRECT subject filters overlap — a sourced stream
  // ingests nothing of its own, which is the whole reason sourcing fixes this.
  for (let i = 0; i < taxonomy.streams.length; i++) {
    for (let j = i + 1; j < taxonomy.streams.length; j++) {
      const a = taxonomy.streams[i] as Stream;
      const b = taxonomy.streams[j] as Stream;
      for (const fa of a.subjects ?? [])
        for (const fb of b.subjects ?? [])
          if (filtersOverlap(fa, fb))
            v(
              "stream-subject-overlap",
              `${a.name}/${b.name}`,
              `subject filters ${fa} and ${fb} overlap; NATS refuses the second stream with "subjects overlap with an existing stream" (10065), so one of these two streams cannot be created. Source one stream from the other instead`,
            );
    }
  }

  return out;
}

export function validateRegistry(
  registry: Registry,
  taxonomy: Taxonomy,
  envelope?: Envelope,
  contractsDir?: string,
): Violation[] {
  const out: Violation[] = [];
  const grammar = new RegExp(taxonomy.grammar.pattern);
  const typePattern = envelope?.properties?.type?.pattern
    ? new RegExp(envelope.properties.type.pattern)
    : null;
  const seenTypes = new Set<string>();
  const seenSubjects = new Set<string>();
  const registered = new Map(registry.types.map((t) => [t.type, t]));

  for (const t of registry.types) {
    const subject = renderSubject(t.subject);
    const v = (rule: string, message: string) =>
      out.push({ rule, subject: t.type, message });

    // Fork-ability: the tenant token is runtime data, so the template must keep
    // the placeholder. A hard-coded cluster name in a NEW type is otherwise
    // invisible to the gate, because nothing pins a subject the baseline has
    // never seen.
    if (t.subject.split(".")[1] !== TENANT_PLACEHOLDER)
      v(
        "tenant-placeholder",
        `subject token 2 is "${t.subject.split(".")[1]}"; it must be the literal ${TENANT_PLACEHOLDER} placeholder, never a real tenant or cluster name`,
      );

    // The registry and the envelope must agree on what a legal `type` is, or a
    // type passes every registry rule and is rejected at runtime by validation.
    if (typePattern && !typePattern.test(t.type))
      v(
        "type-pattern",
        `${t.type} does not match the envelope schema's type pattern; it would be rejected at runtime by envelope.v1.schema.json`,
      );

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

    // The suffix is the guarantee a reader sees without opening the registry, and
    // it is the SINGLE source of truth for durability — the registry no longer
    // restates it, so there is nothing left to drift.
    if (p.suffix === "dl")
      v(
        "dead-letter-not-registerable",
        "a `dl` subject is derived from its `wq` subject, not registered as a type's own subject; dead letters carry the original type",
      );
    else if (t.pattern === "pubsub" && p.suffix !== "ev")
      v(
        "suffix-mismatch",
        `pattern "pubsub" requires the "ev" suffix, subject ends in "${p.suffix}"`,
      );
    else if (t.pattern === "request_reply" && p.suffix === "ev")
      v(
        "suffix-mismatch",
        'pattern "request_reply" requires "wq" (durable, PF_WORK) or "rq" (core NATS), subject ends in "ev"',
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
        `delivery "${t.delivery}" is not offered; the platform has no exactly-once path (ADR-026)`,
      );

    if (t.pattern === "pubsub") {
      if (t.delivery !== "at_least_once")
        v(
          "pubsub-delivery",
          "pub/sub runs over JetStream and is at_least_once; nothing else is truthful",
        );
      if (t.ordering !== "per_subject")
        v("pubsub-ordering", "pub/sub over JetStream is ordered per subject");
      if (t.completion !== undefined)
        v(
          "completion-on-pubsub",
          "completion names the outcome event of a durable request; a pub/sub event is not a request",
        );
    } else {
      // Durability is read off the subject, not declared a second time.
      const durable = p.suffix === "wq";
      if (durable && t.delivery !== "at_least_once")
        v(
          "durable-request-delivery",
          "a `wq` request goes through PF_WORK and is at_least_once",
        );
      else if (!durable && t.delivery !== "at_most_once")
        v(
          "core-request-delivery",
          "an `rq` request is core NATS and is at_most_once; the requester retries and THE RESPONDER must be idempotent",
        );
      if (t.ordering !== "none")
        v(
          "request-ordering",
          "request/reply has no cross-request ordering guarantee",
        );
      if (!durable && !(t.requires ?? []).includes("replyto"))
        v(
          "replyto-required",
          "a synchronous request must require the replyto attribute",
        );
      if (durable && (t.requires ?? []).includes("replyto"))
        v(
          "durable-request-replyto",
          "a `wq` request must not require replyto; an inbox does not survive the wait that made the request durable. Declare a completion type instead",
        );
      if (!(t.requires ?? []).includes("correlationid"))
        v(
          "correlationid-required",
          "request/reply must require correlationid so an outcome can be tied to its request",
        );

      // A durable request with no defined reply leaves the requester with no way
      // to learn the work finished. That is not a gap in the docs, it is a hole
      // in the interaction pattern.
      if (durable) {
        if (!t.completion)
          v(
            "completion-required",
            "a `wq` type must name a completion type: a registered `.ev` event carrying the same correlationid. A durable request has no synchronous reply",
          );
        else {
          const c = registered.get(t.completion);
          if (!c)
            v(
              "completion-unregistered",
              `completion ${t.completion} is not a registered type`,
            );
          else {
            if (!renderSubject(c.subject).endsWith(".ev"))
              v(
                "completion-not-event",
                `completion ${t.completion} must be published on an \`.ev\` subject; its outcome has to be as durable as the request`,
              );
            if (!(c.requires ?? []).includes("correlationid"))
              v(
                "completion-uncorrelated",
                `completion ${t.completion} must require correlationid, or a requester cannot join the outcome to its request`,
              );
          }
        }
      } else if (t.completion !== undefined) {
        v(
          "completion-on-synchronous-request",
          "an `rq` request is answered on its reply inbox; completion is for `wq` only",
        );
      }
    }

    if (!t.dataless && !t.dataschema)
      v(
        "dataschema-required",
        "a type with a body must publish a dataschema; an unpublished payload is not a contract",
      );

    if (t.dataless && t.dataschema)
      v(
        "dataless-with-dataschema",
        "dataless: true and a dataschema are contradictory; a type either has a body with a published shape or it has no body",
      );

    // The gate previously accepted eleven dataschema paths that pointed at files
    // which did not exist. "A payload whose shape is not published is not a
    // contract" has to be enforced, not asserted.
    if (
      t.dataschema &&
      contractsDir &&
      !existsSync(join(contractsDir, t.dataschema))
    )
      v(
        "dataschema-missing-file",
        `dataschema ${t.dataschema} does not resolve to a file under ${contractsDir}; the first producer has nothing to build against`,
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
    // Unconditional: a `wq` type claiming a guarantee PF_WORK does not offer was
    // previously unchecked, because this rule only ran for `pattern: pubsub`.
    for (const st of matched) {
      if (st.delivery !== t.delivery)
        v(
          "stream-delivery-mismatch",
          `stream ${st.name} offers ${st.delivery} but the type claims ${t.delivery}`,
        );
    }

    // Every durable request needs somewhere for its poison messages to go, or
    // they sit in the work queue undeliverable until max_age deletes them.
    if (p.suffix === "wq") {
      const dl = deadLetterSubjectOf(subject);
      if (streamsFor(taxonomy, dl).length === 0)
        v(
          "no-dead-letter-stream",
          `no stream covers ${dl}; a \`wq\` type with nowhere to republish a failed message has no failure path`,
        );
    }
  }

  return out;
}

// ============================================================================
// Rule 2 — backward compatibility
// ============================================================================

/**
 * Project a payload schema down to the fields a consumer can actually break on.
 * Only top-level properties are pinned: nesting is deliberately out of scope so
 * the baseline stays reviewable by eye, and a nested break still surfaces as a
 * type change on the property that contains it.
 */
export function toBaselinePayload(schema: PayloadSchema): BaselinePayload {
  const properties: Record<string, string> = {};
  for (const [name, def] of Object.entries(schema.properties ?? {})) {
    const t = def?.type;
    properties[name] = Array.isArray(t)
      ? [...t].sort().join("|")
      : (t ?? "unknown");
  }
  return {
    properties,
    required: [...(schema.required ?? [])].sort(),
    // Absent means "additions allowed" in JSON Schema; record the effective value.
    additionalProperties: schema.additionalProperties ?? true,
  };
}

export function toBaselineTypes(
  registry: Registry,
  payloads: Map<string, PayloadSchema> = new Map(),
): BaselineEntry[] {
  return registry.types
    .filter((t) => t.status === "stable")
    .map((t) => {
      const schema = payloads.get(t.type);
      return {
        type: t.type,
        subject: t.subject,
        pattern: t.pattern,
        delivery: t.delivery,
        ordering: t.ordering,
        dataschema: t.dataschema ?? null,
        dataless: t.dataless ?? false,
        requires: [...(t.requires ?? [])].sort(),
        completion: t.completion ?? null,
        producer: t.producer,
        status: t.status,
        payload: schema ? toBaselinePayload(schema) : null,
      };
    })
    .sort((a, b) => a.type.localeCompare(b.type));
}

export function toBaselineStreams(taxonomy: Taxonomy): BaselineStream[] {
  return taxonomy.streams
    .map((st) => ({
      name: st.name,
      subjects: [...(st.subjects ?? [])].sort(),
      sources: (st.sources ?? []).map((s) => ({
        name: s.name,
        filters: [...(s.filters ?? [])].sort(),
      })),
      retention: st.retention ?? null,
      max_age: st.max_age ?? null,
      discard: st.discard ?? null,
      delivery: st.delivery,
      ordering: st.ordering,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function toBaseline(
  registry: Registry,
  taxonomy: Taxonomy,
  envelope: Envelope,
  payloads: Map<string, PayloadSchema> = new Map(),
): Baseline {
  return {
    version: 1,
    grammar: {
      pattern: taxonomy.grammar.pattern,
      tokens: taxonomy.grammar.tokens,
    },
    envelope: { required: [...envelope.required].sort() },
    streams: toBaselineStreams(taxonomy),
    types: toBaselineTypes(registry, payloads),
  };
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
  baseline: Baseline,
  current: Registry,
): Violation[] {
  const out: Violation[] = [];
  const now = new Map(current.types.map((t) => [t.type, t]));

  for (const was of baseline.types) {
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

    // `requires` is equally a promise TO CONSUMERS that the attribute is always
    // present. Dropping one breaks every consumer joining on it, and breaks it
    // without a null check, because the contract said it was always there.
    const dropped = was.requires.filter(
      (r) => !(is.requires ?? []).includes(r),
    );
    if (dropped.length > 0)
      v(
        "required-attribute-removed",
        `no longer required: [${dropped.join(", ")}]; consumers were promised these are always present and do not null-check them`,
      );

    if ((is.dataless ?? false) && !was.dataless)
      v(
        "body-removed",
        "dataless: true on a type that had a body; every consumer reading `data` gets undefined",
      );

    if (is.producer !== was.producer)
      v(
        "producer-reassigned",
        `producer changed ${was.producer} -> ${is.producer}. This is a trust boundary: publish permission is granted per subject prefix to the owning component's credential, and a component that can publish another's events can forge them. Move it with an ADR, not a passing gate`,
      );

    if (is.status !== was.status)
      v(
        "status-demoted",
        `status changed ${was.status} -> ${is.status}; demoting a stable type declares it exempt from this gate and unfit to consume across a trust boundary, about a type consumers are already reading across one — and the next \`baseline --write\` would drop it from the baseline entirely`,
      );

    const wasCompletion = was.completion ?? null;
    const isCompletion = is.completion ?? null;
    if (wasCompletion !== null && isCompletion !== wasCompletion)
      v(
        "completion-changed",
        `completion type changed ${wasCompletion} -> ${isCompletion}; requesters are waiting on the old one`,
      );
  }

  return out;
}

/**
 * The twelve payload schemas, field by field.
 *
 * Until this rule existed the gate pinned the `dataschema` *path* and nothing
 * inside the file, so every one of these passed on a stable type: adding a
 * required property, deleting a property, retyping one, and closing the schema
 * to additions. Each is a break a consumer discovers at runtime.
 */
export function checkPayloadCompatibility(
  baseline: Baseline,
  payloads: Map<string, PayloadSchema>,
): Violation[] {
  const out: Violation[] = [];

  for (const was of baseline.types) {
    if (!was.payload) continue;
    const v = (rule: string, message: string) =>
      out.push({ rule, subject: was.type, message });

    const raw = payloads.get(was.type);
    if (!raw) {
      // `dataschema-missing-file` reports the unreadable path; this reports the
      // compatibility consequence — the pinned shape can no longer be checked.
      v(
        "payload-schema-unreadable",
        `the payload schema for this stable type no longer loads, so its ${
          Object.keys(was.payload.properties).length
        } pinned properties are unguarded; restore ${was.dataschema} or cut a new major`,
      );
      continue;
    }
    const is = toBaselinePayload(raw);

    const addedRequired = is.required.filter(
      (r) => !was.payload!.required.includes(r),
    );
    if (addedRequired.length > 0)
      v(
        "payload-required-added",
        `newly required payload properties [${addedRequired.join(", ")}] on a stable type; every already-deployed producer emits events that now fail validation. Add it optional, or cut a new major`,
      );

    const droppedRequired = was.payload.required.filter(
      (r) => !is.required.includes(r),
    );
    if (droppedRequired.length > 0)
      v(
        "payload-required-removed",
        `payload properties no longer required: [${droppedRequired.join(", ")}]; consumers were promised these are always present and do not null-check them`,
      );

    const removed = Object.keys(was.payload.properties).filter(
      (p) => !(p in is.properties),
    );
    if (removed.length > 0)
      v(
        "payload-property-removed",
        `payload properties removed: [${removed.join(", ")}]; a consumer reading them gets undefined. Deprecate in place instead`,
      );

    for (const [name, wasType] of Object.entries(was.payload.properties)) {
      const isType = is.properties[name];
      if (isType !== undefined && isType !== wasType)
        v(
          "payload-property-retyped",
          `payload property "${name}" changed type ${wasType} -> ${isType}; a consumer that parsed the old type fails on the new one`,
        );
    }

    if (was.payload.additionalProperties && !is.additionalProperties)
      v(
        "payload-closed-to-additions",
        `additionalProperties tightened true -> false on a stable type; a consumer validating against this schema now rejects any event carrying a property added later, which forecloses the additive evolution path this contract calls non-breaking`,
      );
  }

  return out;
}

/**
 * The envelope schema's own `required` list, which the gate did not read at all
 * until ADR-038 — while the documentation claimed it rejected a newly required
 * envelope attribute. Both directions are breaking: adding one rejects every
 * event from a producer that has not shipped yet, and removing one withdraws a
 * guarantee consumers were told to rely on.
 */
export function checkEnvelopeCompatibility(
  baseline: Baseline,
  envelope: Envelope,
): Violation[] {
  const out: Violation[] = [];
  const was = baseline.envelope?.required ?? [];
  const is = envelope.required ?? [];
  const added = is.filter((r) => !was.includes(r));
  const removed = was.filter((r) => !is.includes(r));
  if (added.length > 0)
    out.push({
      rule: "envelope-attribute-required",
      subject: "envelope.v1.schema.json",
      message: `newly required envelope attributes [${added.join(", ")}]; the envelope is additionalProperties: false, so this is a coordinated rollout (validators first, producers second), never a unilateral edit`,
    });
  if (removed.length > 0)
    out.push({
      rule: "envelope-attribute-unrequired",
      subject: "envelope.v1.schema.json",
      message: `no longer required: [${removed.join(", ")}]; consumers were told these are always present`,
    });
  return out;
}

/**
 * The stream set and the grammar, neither of which was in the baseline.
 * Shrinking PF_EVENTS.max_age from 7d to 1h destroys the replayability the
 * contract promises, and narrowing PF_AUDIT's filters silently stops auditing a
 * whole domain — both passed the old gate, because `no-stream` only fires when
 * NOTHING matches.
 */
export function checkTaxonomyCompatibility(
  baseline: Baseline,
  taxonomy: Taxonomy,
): Violation[] {
  const out: Violation[] = [];
  const v = (rule: string, subject: string, message: string) =>
    out.push({ rule, subject, message });

  if (baseline.grammar?.pattern !== taxonomy.grammar.pattern)
    v(
      "grammar-changed",
      "grammar",
      `the subject grammar changed. It is compiled from the file under test, so loosening it — an eighth suffix, a different root — would otherwise validate happily against itself. Changing it needs an ADR and a deliberate baseline regeneration:\n      was: ${baseline.grammar?.pattern}\n      is:  ${taxonomy.grammar.pattern}`,
    );
  if (baseline.grammar?.tokens !== taxonomy.grammar.tokens)
    v(
      "grammar-token-count-changed",
      "grammar",
      `token count changed ${baseline.grammar?.tokens} -> ${taxonomy.grammar.tokens}; every wildcard in every consumer assumes the old one`,
    );

  const now = new Map(taxonomy.streams.map((s) => [s.name, s]));
  for (const was of baseline.streams ?? []) {
    const is = now.get(was.name);
    if (!is) {
      v(
        "stream-removed",
        was.name,
        "a stream was removed; whatever it retained is gone and every consumer bound to it fails to resubscribe",
      );
      continue;
    }

    for (const f of was.subjects) {
      if (!(is.subjects ?? []).some((cur) => filterCovers(cur, f)))
        v(
          "stream-filter-narrowed",
          was.name,
          `subject filter ${f} is no longer covered; events that used to be captured are now published into a void`,
        );
    }

    for (const wasSrc of was.sources ?? []) {
      const isSrc = (is.sources ?? []).find((s) => s.name === wasSrc.name);
      if (!isSrc) {
        v(
          "stream-source-removed",
          was.name,
          `no longer sources from ${wasSrc.name}; it silently stops mirroring everything that source carried`,
        );
        continue;
      }
      for (const f of wasSrc.filters) {
        if (!(isSrc.filters ?? []).some((cur) => filterCovers(cur, f)))
          v(
            "stream-source-narrowed",
            was.name,
            `source filter ${f} from ${wasSrc.name} is no longer covered; a whole class of events silently stops being mirrored`,
          );
      }
    }

    const wasAge = durationSeconds(was.max_age);
    const isAge = durationSeconds(is.max_age);
    if (wasAge !== null && isAge !== null && isAge < wasAge)
      v(
        "retention-shortened",
        was.name,
        `max_age shortened ${was.max_age} -> ${is.max_age}; replay and audit windows the contract promises are destroyed, and on a work queue the deletion is silent`,
      );

    if (was.retention !== null && is.retention !== was.retention)
      v(
        "stream-retention-changed",
        was.name,
        `retention policy changed ${was.retention} -> ${is.retention}; limits and workqueue are different delivery models, not a tuning knob`,
      );

    if (was.discard !== null && is.discard !== was.discard)
      v(
        "stream-discard-changed",
        was.name,
        `discard changed ${was.discard} -> ${is.discard}; \`new\` refuses writes when full and \`old\` drops history, and which one is correct is a design decision per stream`,
      );

    if (DELIVERY_RANK[is.delivery] < DELIVERY_RANK[was.delivery])
      v(
        "stream-delivery-weakened",
        was.name,
        `delivery weakened ${was.delivery} -> ${is.delivery}`,
      );

    if (ORDERING_RANK[is.ordering] < ORDERING_RANK[was.ordering])
      v(
        "stream-ordering-weakened",
        was.name,
        `ordering weakened ${was.ordering} -> ${is.ordering}`,
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
export const ENVELOPE_FILE = "envelope.v1.schema.json";

export function loadRegistry(dir = CONTRACTS_DIR): Registry {
  return parseYaml(readFileSync(join(dir, REGISTRY_FILE), "utf8")) as Registry;
}

export function loadTaxonomy(dir = CONTRACTS_DIR): Taxonomy {
  return parseYaml(readFileSync(join(dir, TAXONOMY_FILE), "utf8")) as Taxonomy;
}

export function loadEnvelope(dir = CONTRACTS_DIR): Envelope {
  return JSON.parse(readFileSync(join(dir, ENVELOPE_FILE), "utf8")) as Envelope;
}

export function loadBaseline(dir = CONTRACTS_DIR): Baseline {
  return JSON.parse(readFileSync(join(dir, BASELINE_FILE), "utf8")) as Baseline;
}

/**
 * Every resolvable `dataschema`, keyed by CloudEvents type. A path that does not
 * resolve or does not parse is simply absent: `dataschema-missing-file` already
 * reports the first, and `payload-schema-unreadable` reports the compatibility
 * consequence for a type that was previously pinned.
 */
export function loadPayloads(
  registry: Registry,
  dir = CONTRACTS_DIR,
): Map<string, PayloadSchema> {
  const out = new Map<string, PayloadSchema>();
  for (const t of registry.types) {
    if (!t.dataschema) continue;
    const path = join(dir, t.dataschema);
    if (!existsSync(path)) continue;
    try {
      out.set(t.type, JSON.parse(readFileSync(path, "utf8")) as PayloadSchema);
    } catch {
      // Left absent on purpose; an unparseable schema is an unreadable schema.
    }
  }
  return out;
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
    const baselineRegistry = loadRegistry(dir);
    const baseline = toBaseline(
      baselineRegistry,
      loadTaxonomy(dir),
      loadEnvelope(dir),
      loadPayloads(baselineRegistry, dir),
    );
    const body = `${JSON.stringify(baseline, null, 2)}\n`;
    if (argv.includes("--write")) {
      writeFileSync(join(dir, BASELINE_FILE), body);
      const pinnedProps = baseline.types.reduce(
        (n, t) => n + Object.keys(t.payload?.properties ?? {}).length,
        0,
      );
      log.ok(
        `wrote ${join(dir, BASELINE_FILE)} (${baseline.types.length} stable types, ${baseline.streams.length} streams, ${baseline.envelope.required.length} required envelope attributes, ${pinnedProps} payload properties)`,
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
  const envelope = loadEnvelope(dir);
  const baseline = loadBaseline(dir);

  const payloads = loadPayloads(registry, dir);

  const violations = [
    ...validateTaxonomy(taxonomy),
    ...validateRegistry(registry, taxonomy, envelope, dir),
    ...checkCompatibility(baseline, registry),
    ...checkEnvelopeCompatibility(baseline, envelope),
    ...checkTaxonomyCompatibility(baseline, taxonomy),
    ...checkPayloadCompatibility(baseline, payloads),
  ];

  if (violations.length > 0) {
    log.fail(`${violations.length} contract violation(s)`);
    console.error(renderViolations(violations));
    return 1;
  }

  const pinnedProps = baseline.types.reduce(
    (n, t) => n + Object.keys(t.payload?.properties ?? {}).length,
    0,
  );
  log.ok(
    `${registry.types.length} registered types across ${taxonomy.streams.length} streams; ${baseline.types.length} stable types, ${baseline.streams.length} streams, the envelope's ${baseline.envelope.required.length} required attributes, ${pinnedProps} payload properties and the subject grammar all compatible with the baseline`,
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
