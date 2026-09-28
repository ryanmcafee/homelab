/**
 * contract-shape.ts
 *
 * The document-kind-agnostic half of the contract compatibility gate: a
 * structural projection of any document under `contracts/`, plus the named rule
 * set that decides whether the difference between two projections is breaking.
 *
 * Why a second projection exists at all. `contract-check.ts` knows what a
 * registered event type is, and every rule it applies is stated in those terms:
 * delivery guarantee, stream filter, subject grammar. None of that vocabulary
 * exists in `contracts/cluster/topology.v1.yaml`, in a Prometheus metric
 * contract, or in an OpenAPI document, so those files sat outside the gate and
 * were held by review. ADR-030's rule is that a boundary contract is gated, not
 * reviewed, and ADR-048 records the decision to gate them structurally: a
 * contract is a tree of fields, and the four ways a tree breaks a consumer —
 * a field disappears, a field is renamed, a field changes type, a declared set
 * is narrowed — are the same whatever the document means.
 *
 * What a shape is. Every node of the parsed document is projected to one entry
 * in a flat `path -> field` map: its JSON kind, its value if it is a scalar, the
 * member set if it is a list of scalars, and the direction of the bound if its
 * key names one. Comments, key order and list order are dropped, which is the
 * point: the projection is what the rules read, and `git diff` is what a human
 * reads.
 *
 * Addressing. A list of objects is addressed by each entry's identity field
 * (`id`, `name`, `key`, `type`, first one present), so reordering the list is
 * not a rename and removing an entry is reported against the id a consumer
 * selects on. A list whose entries carry no such field, or whose identities
 * collide, is addressed positionally (`#0`) instead — stated here because it is
 * the one case where reordering the list reads as a mutation.
 *
 * What this deliberately does NOT decide, and is the named residual (MCAA-431):
 *
 *   - A changed scalar value that is not a direction-classified numeric bound.
 *     `quorum.formula` becoming a different expression, `onIndeterminate`
 *     flipping from `unsafe` to `safe`, a boolean requirement flag going false
 *     is breaking, and no rule below rejects it. What *does* happen is that the
 *     value is pinned, so the baseline stops matching the document and the
 *     in-sync test fails until someone regenerates it — the change becomes
 *     unmissable in review rather than silently green. The reviewer decides
 *     whether it needed a new major version.
 *   - A duration expressed as a string (`max_age: 168h`). Shortening one is a
 *     tightening the number-only bound rule cannot see. `contract-check.ts` has
 *     `durationSeconds` for the event streams; this side does not.
 *   - Anything inside a referenced file. A `$ref` or a `dataschema` path is a
 *     string leaf here; the event pipeline resolves its own.
 */

// ============================================================================
// The shape
// ============================================================================

export type ShapeKind =
  | "object"
  | "list"
  | "string"
  | "number"
  | "boolean"
  | "null";

/** Which way a numeric bound has to move to reject a value it used to accept. */
export type BoundDirection = "min" | "max";

export interface ShapeField {
  kind: ShapeKind;
  /**
   * Membership of a list of scalars, JSON-rendered and sorted so list order is
   * not a difference. Present only for a list whose every entry is a scalar;
   * absent on a list of objects, which is addressed entry by entry instead. The
   * two readings are distinct on purpose — a scalar list becoming a list of
   * objects keeps `kind: "list"` and is caught by the absence of this key.
   */
  members?: string[];
  /** JSON-rendered value. Scalar leaves only. */
  value?: string;
  /** Set only when `kind` is `number` and the key names a min or a max. */
  bound?: BoundDirection;
}

export interface DocumentShape {
  fields: Record<string, ShapeField>;
}

/** Same three fields as `contract-check.ts`'s `Violation`, structurally. */
export interface ShapeViolation {
  rule: string;
  subject: string;
  message: string;
}

/** Tried in order; the first one carrying a string or number wins. */
export const IDENTITY_KEYS = ["id", "name", "key", "type"] as const;

// ============================================================================
// Projection
// ============================================================================

const isDate = (v: unknown): v is Date => v instanceof Date;

export function kindOf(value: unknown): ShapeKind {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "list";
  if (isDate(value)) return "string";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

const isScalar = (value: unknown): boolean =>
  value === null || value === undefined || isDate(value)
    ? true
    : typeof value !== "object";

export function renderScalar(value: unknown): string {
  if (isDate(value)) return JSON.stringify(value.toISOString());
  return JSON.stringify(value) ?? "null";
}

/** A `.` inside a key is escaped so a path never splits ambiguously. */
export function escapeSegment(segment: string): string {
  return segment.replace(/([\\.])/g, "\\$1");
}

export function joinPath(parent: string, segment: string): string {
  const escaped = escapeSegment(segment);
  return parent === "" ? escaped : `${parent}.${escaped}`;
}

/** Split on unescaped `.` only. */
export function splitPath(path: string): string[] {
  if (path === "") return [];
  return path.split(/(?<!\\)\./).map((s) => s.replace(/\\(.)/g, "$1"));
}

export function parentPath(path: string): string | null {
  const segments = splitPath(path);
  if (segments.length === 0) return null;
  return segments.slice(0, -1).map(escapeSegment).join(".");
}

export function lastSegment(path: string): string {
  const segments = splitPath(path);
  return segments[segments.length - 1] ?? "";
}

/**
 * The identity of each entry of a list of objects, or `null` when the list has
 * to be addressed positionally — an entry that is not an object, an entry with
 * no identity field, or two entries claiming the same identity.
 */
export function listEntryIds(items: unknown[]): string[] | null {
  const ids: string[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const record: Record<string, unknown> = { ...item };
    const key = IDENTITY_KEYS.find(
      (k) => typeof record[k] === "string" || typeof record[k] === "number",
    );
    if (key === undefined) return null;
    ids.push(String(record[key]));
  }
  return new Set(ids).size === ids.length ? ids : null;
}

/**
 * JSON Schema's own keywords plus the `minFoo`/`maxFoo` convention every
 * contract in this repository follows. Matching on the keyword rather than on a
 * loose substring keeps `maximumsomething` out and lets `minimumReachable-
 * Endpoints`, `max_msg_size` and `minLength` all in.
 */
const MIN_BOUND = /^min(imum|Length|Items|Properties)?(?=$|[A-Z_])/;
const MAX_BOUND = /^max(imum|Length|Items|Properties)?(?=$|[A-Z_])/;

export function boundDirection(segment: string): BoundDirection | null {
  if (MIN_BOUND.test(segment)) return "min";
  if (MAX_BOUND.test(segment)) return "max";
  return null;
}

function walk(
  value: unknown,
  path: string,
  segment: string,
  out: Record<string, ShapeField>,
): void {
  const kind = kindOf(value);

  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      out[path] = { kind, members: value.map(renderScalar).sort() };
      return;
    }
    out[path] = { kind };
    const ids = listEntryIds(value);
    value.forEach((item, index) => {
      const entry = ids === null ? `#${index}` : (ids[index] ?? `#${index}`);
      walk(item, joinPath(path, entry), entry, out);
    });
    return;
  }

  if (kind === "object") {
    out[path] = { kind };
    for (const [key, child] of Object.entries(Object(value))) {
      walk(child, joinPath(path, key), key, out);
    }
    return;
  }

  const field: ShapeField = { kind, value: renderScalar(value) };
  const bound = kind === "number" ? boundDirection(segment) : null;
  if (bound !== null) field.bound = bound;
  out[path] = field;
}

export function projectShape(document: unknown): DocumentShape {
  const fields: Record<string, ShapeField> = {};
  walk(document, "", "", fields);
  return { fields };
}

// ============================================================================
// Counts
// ============================================================================

export interface ShapeCounts {
  /** Every projected path, the root included. */
  fields: number;
  /** Lists of scalars, whose membership is pinned. */
  scalarLists: number;
  /** Entries of a list, keyed or positional. */
  entries: number;
  /** Numeric leaves whose key classified them as a min or a max. */
  bounds: number;
}

/**
 * Reported by both commands and asserted by the tests. A projection that stops
 * walking part of a document, or a bound convention a contract stops following,
 * turns into a silent pass otherwise: the rules below can only fire on a field
 * that is actually in the map.
 */
export function shapeCounts(shape: DocumentShape): ShapeCounts {
  const paths = Object.keys(shape.fields);
  return {
    fields: paths.length,
    scalarLists: paths.filter((p) => shape.fields[p]?.members !== undefined)
      .length,
    entries: paths.filter((p) => {
      const parent = parentPath(p);
      return parent !== null && shape.fields[parent]?.kind === "list";
    }).length,
    bounds: paths.filter((p) => shape.fields[p]?.bound !== undefined).length,
  };
}

// ============================================================================
// The rule set
// ============================================================================

/** `topology.v1.yaml` -> `topology.v2.yaml`. */
export function nextMajorName(document: string): string {
  const match = document.match(/\.v(\d+)\./);
  if (match === null) return `a new major version of ${document}`;
  return document.replace(/\.v(\d+)\./, `.v${Number(match[1]) + 1}.`);
}

const subjectOf = (document: string, path: string): string =>
  path === "" ? document : `${document} ${path}`;

const depth = (path: string): number => splitPath(path).length;

/**
 * Every difference this gate calls breaking, for a contract of any kind.
 *
 * Each rule rejects a document that would reject a value, or lose a field, a
 * consumer already relies on. None of them is cleared by regenerating the
 * baseline — that is what separates them from an additive change, which the
 * in-sync test asks you to regenerate and the reviewer then sees as a diff.
 *
 *   contract-field-removed      a pinned path is gone (a removal, or the old
 *                               half of a rename)
 *   contract-entry-removed      an entry of a list is gone, by the identity a
 *                               consumer selects on
 *   contract-field-retyped      the kind at a pinned path changed, a scalar
 *                               list becoming a list of objects included
 *   contract-list-member-removed  a declared set lost a member, so a value that
 *                               used to be permitted no longer is
 *   contract-required-added     a `required` list grew: every producer that
 *                               validated now fails
 *   contract-required-removed   a `required` list shrank: every consumer that
 *                               relied on the field being present now fails
 *   contract-bound-tightened    a `min…` rose or a `max…` fell, rejecting a
 *                               value that used to validate
 */
export function diffShape(
  before: DocumentShape,
  after: DocumentShape,
  document: string,
): ShapeViolation[] {
  const out: ShapeViolation[] = [];
  const v2 = nextMajorName(document);
  const publishV2 = `publish ${v2} alongside this file and keep this version published, rather than changing it in place`;

  // Shallowest first, so a removed or retyped subtree reports once instead of
  // once per descendant: a consumer acts on `limits` becoming a list, not on the
  // two children that went with it.
  const paths = Object.keys(before.fields).sort(
    (a, b) => depth(a) - depth(b) || a.localeCompare(b),
  );
  const silenced: string[] = [];
  const silence = (path: string): void => {
    silenced.push(path);
  };

  for (const path of paths) {
    if (silenced.some((s) => path === s || path.startsWith(`${s}.`))) continue;

    const was = before.fields[path];
    const now = after.fields[path];
    if (was === undefined) continue;

    if (now === undefined) {
      silence(path);
      const parent = parentPath(path);
      const inList = parent !== null && before.fields[parent]?.kind === "list";
      out.push({
        rule: inList ? "contract-entry-removed" : "contract-field-removed",
        subject: subjectOf(document, path),
        message: inList
          ? `the baseline declares this entry of \`${parent}\` and the document no longer does. An entry a consumer selects on by id cannot be withdrawn in place: ${publishV2}.`
          : `pinned by the baseline, absent from the document. Removing a field, or renaming one, breaks every consumer reading it: ${publishV2}. A rename is the removal plus the addition, and only the removal is rejected here — add the new name beside the old one and drop the old one in ${v2}.`,
      });
      continue;
    }

    if (now.kind !== was.kind) {
      silence(path);
      out.push({
        rule: "contract-field-retyped",
        subject: subjectOf(document, path),
        message: `${was.kind} -> ${now.kind}. A consumer parses this field as ${was.kind}: ${publishV2}.`,
      });
      continue;
    }

    if (was.members !== undefined && now.members === undefined) {
      silence(path);
      out.push({
        rule: "contract-field-retyped",
        subject: subjectOf(document, path),
        message: `a list of scalars became a list of objects. Every consumer reading the entries as values now reads objects: ${publishV2}.`,
      });
      continue;
    }

    if (was.members === undefined && now.members !== undefined) {
      silence(path);
      out.push({
        rule: "contract-field-retyped",
        subject: subjectOf(document, path),
        message: `a list of objects became a list of scalars. Every consumer reading an entry's fields now reads a value: ${publishV2}.`,
      });
      continue;
    }

    if (was.members !== undefined && now.members !== undefined) {
      const isRequired = lastSegment(path) === "required";
      const gone = was.members.filter((m) => !now.members?.includes(m));
      const added = now.members.filter((m) => !was.members?.includes(m));

      if (gone.length > 0) {
        out.push(
          isRequired
            ? {
                rule: "contract-required-removed",
                subject: subjectOf(document, path),
                message: `no longer requires ${gone.join(", ")}. A consumer that reads the field unconditionally because the contract required it now reads an absent value: ${publishV2}.`,
              }
            : {
                rule: "contract-list-member-removed",
                subject: subjectOf(document, path),
                message: `dropped ${gone.join(", ")} from a declared set. A value this contract used to permit no longer is: ${publishV2}.`,
              },
        );
      }
      if (isRequired && added.length > 0) {
        out.push({
          rule: "contract-required-added",
          subject: subjectOf(document, path),
          message: `now requires ${added.join(", ")}. Every producer that validated against the published contract fails: ${publishV2}.`,
        });
      }
    }

    if (
      was.bound !== undefined &&
      was.value !== undefined &&
      now.value !== undefined
    ) {
      const from = Number(was.value);
      const to = Number(now.value);
      const tightened = was.bound === "min" ? to > from : to < from;
      if (tightened) {
        out.push({
          rule: "contract-bound-tightened",
          subject: subjectOf(document, path),
          message: `${was.bound} bound ${from} -> ${to} rejects a value this contract used to accept: ${publishV2}. Loosening it instead is additive and needs only a baseline refresh.`,
        });
      }
    }
  }

  return out;
}
