#!/usr/bin/env -S bun test
/**
 * Consistency tests for contracts/status/status-page.v1.yaml -- the status page's
 * back end -> UI HTTP contract (ryanmcafee/homelab#41).
 *
 * The contract landed before either half of the status page, which is what
 * docs/contracts/sdk-boundary.md Sec. 2 requires. That leaves nothing to conform to
 * it yet, so this file checks the two things that are checkable today and says which
 * one is missing:
 *
 *   1. The contract is internally consistent -- every `$ref` resolves, the taxonomy
 *      and the schema vocabulary are the same vocabulary, every state has exactly
 *      one derivation rule, and every application the taxonomy names actually ships
 *      in this repository. That last one is what stops a hand-written component map
 *      from quietly becoming fiction after a rename.
 *
 *   2. Every fixture in tests/status/ satisfies both the schema and the honesty
 *      invariants the contract exists to enforce -- no `operational` without a
 *      mapped alert, no uptime figure without a full window behind it. These are the
 *      documents the React UI renders against and the shapes the back end must
 *      produce, so a disagreement between the two halves fails here rather than on
 *      the page during an incident.
 *
 * It is deliberately NOT a conformance test of a served response; there is no
 * implementation. That check is named in the contract's `enforcement` section with
 * status "specified, not implemented", per ADR-033.
 *
 * The validator below understands only the JSON Schema keywords this contract uses,
 * and treats `oneOf` as "at least one branch". A test asserts the contract uses no
 * keyword outside that subset, so a keyword the validator would silently ignore
 * fails the build instead of quietly weakening every fixture check.
 *
 *   bun test scripts/status-contract_test.ts
 */

import { test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AssertionError, assert, assertEquals } from "./lib/assert.ts";
import { parse as parseYaml } from "./lib/yaml.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const CONTRACT_PATH = join(
  REPO_ROOT,
  "contracts",
  "status",
  "status-page.v1.yaml",
);
const DOC_PATH = join(
  REPO_ROOT,
  "docs",
  "contracts",
  "status-page-contract.md",
);
const FIXTURE_DIR = join(REPO_ROOT, "tests", "status");

// ---------------------------------------------------------------------------
// Structural accessors. The contract and the fixtures arrive as `unknown`; these
// narrow them with a path in the failure message rather than asserting a shape the
// file may not have.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new AssertionError(`${path} must be a mapping`);
}

function arr(value: unknown, path: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new AssertionError(`${path} must be a sequence`);
}

function str(value: unknown, path: string): string {
  if (typeof value === "string") return value;
  throw new AssertionError(`${path} must be a string`);
}

function int(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new AssertionError(`${path} must be an integer`);
}

function strList(value: unknown, path: string): string[] {
  return arr(value, path).map((entry, i) => str(entry, `${path}[${i}]`));
}

const contract = obj(
  parseYaml(readFileSync(CONTRACT_PATH, "utf8")),
  "status-page.v1.yaml",
);
const schemas = obj(
  obj(contract.components, "components").schemas,
  "components.schemas",
);
const ext = obj(contract["x-status-page"], "x-status-page");
const taxonomy = arr(ext.taxonomy, "x-status-page.taxonomy").map((raw, i) =>
  obj(raw, `x-status-page.taxonomy[${i}]`),
);
const derivation = obj(ext.stateDerivation, "x-status-page.stateDerivation");
const overallRule = obj(derivation.overall, "stateDerivation.overall");

/** The string members of an enum, dropping the explicit null some of them allow. */
function schemaEnum(name: string, pointer: string[]): string[] {
  let node = obj(schemas[name], name);
  for (const key of pointer) node = obj(node[key], `${name}.${key}`);
  return arr(node.enum, `${name}.enum`).filter(
    (member): member is string => typeof member === "string",
  );
}

const COMPONENT_STATES = schemaEnum("ComponentState", []);
const STATE_REASONS = schemaEnum("StateReason", []);
const GROUPS = schemaEnum("Component", ["properties", "group"]);
const SEVERITIES = schemaEnum("Incident", ["properties", "severity"]);
const SIGNAL_IDS = schemaEnum("Signal", ["properties", "id"]);

const signalDependencies = obj(
  derivation.signalDependencies,
  "stateDerivation.signalDependencies",
);

/** The signal ids the named field is derived from. */
function dependenciesOf(field: "state" | "uptime"): string[] {
  return strList(
    signalDependencies[field],
    `stateDerivation.signalDependencies.${field}`,
  );
}

// ---------------------------------------------------------------------------
// A JSON Schema validator over exactly the keywords this contract uses.
// ---------------------------------------------------------------------------

const SUPPORTED_KEYWORDS = new Set([
  "$ref",
  "additionalProperties",
  "const",
  "description",
  "enum",
  "format",
  "items",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "type",
]);

const FORMATS: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  "date-time":
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  uri: /^[a-z][a-z0-9+.-]*:\/\/\S+$/,
};

const REF_PREFIX = "#/components/schemas/";

function resolve(schema: Record<string, unknown>): Record<string, unknown> {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const name = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : "";
  if (!(name in schemas))
    throw new AssertionError(`$ref ${ref} does not resolve`);
  return obj(schemas[name], name);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function validate(
  value: unknown,
  rawSchema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const schema = resolve(rawSchema);

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.some((branch, i) => {
      const found: string[] = [];
      validate(value, obj(branch, `${path}.oneOf[${i}]`), path, found);
      return found.length === 0;
    });
    if (!matched) errors.push(`${path}: matched none of the oneOf branches`);
    return;
  }

  if (schema.type !== undefined) {
    const allowed =
      typeof schema.type === "string"
        ? [schema.type]
        : strList(schema.type, `${path}.type`);
    const actual = typeOf(value);
    if (
      !allowed.includes(actual) &&
      !(actual === "integer" && allowed.includes("number"))
    ) {
      errors.push(`${path}: expected ${allowed.join("|")}, got ${actual}`);
      return;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: must equal ${String(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not in the enum`);
  }

  if (typeof value === "string") {
    const { minLength, maxLength, pattern, format } = schema;
    if (typeof minLength === "number" && value.length < minLength) {
      errors.push(`${path}: shorter than minLength ${minLength}`);
    }
    if (typeof maxLength === "number" && value.length > maxLength) {
      errors.push(`${path}: longer than maxLength ${maxLength}`);
    }
    if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
      errors.push(`${path}: does not match ${pattern}`);
    }
    if (typeof format === "string" && FORMATS[format]?.test(value) === false) {
      errors.push(`${path}: not a valid ${format}`);
    }
  }

  if (typeof value === "number") {
    const { minimum, maximum } = schema;
    if (typeof minimum === "number" && value < minimum) {
      errors.push(`${path}: below minimum ${minimum}`);
    }
    if (typeof maximum === "number" && value > maximum) {
      errors.push(`${path}: above maximum ${maximum}`);
    }
  }

  if (Array.isArray(value)) {
    const { minItems, items } = schema;
    if (typeof minItems === "number" && value.length < minItems) {
      errors.push(`${path}: fewer than minItems ${minItems}`);
    }
    if (items !== undefined) {
      const itemSchema = obj(items, `${path}.items`);
      for (const [i, entry] of value.entries()) {
        validate(entry, itemSchema, `${path}[${i}]`, errors);
      }
    }
    return;
  }

  if (isRecord(value)) {
    const properties =
      schema.properties === undefined
        ? {}
        : obj(schema.properties, `${path}.properties`);
    for (const key of strList(schema.required ?? [], `${path}.required`)) {
      if (!(key in value)) {
        errors.push(`${path}: missing required property ${key}`);
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema === undefined) {
        if (schema.additionalProperties === false) {
          errors.push(`${path}: unexpected property ${key}`);
        }
        continue;
      }
      validate(
        entry,
        obj(propertySchema, `${path}.properties.${key}`),
        `${path}.${key}`,
        errors,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The contract is internally consistent.
// ---------------------------------------------------------------------------

test("every schema keyword is one the validator in this file understands", () => {
  const unsupported = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, entry] of Object.entries(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        unsupported.add(key);
        continue;
      }
      if (key === "properties") {
        for (const child of Object.values(obj(entry, "properties")))
          walk(child);
        continue;
      }
      if (["const", "enum", "required", "type"].includes(key)) continue;
      walk(entry);
    }
  };
  for (const schema of Object.values(schemas)) walk(schema);
  assertEquals(
    [...unsupported].sort(),
    [],
    "a keyword the validator ignores would silently weaken every fixture check; teach it the keyword or drop the keyword",
  );
});

test("every $ref in the document resolves to a declared schema", () => {
  const dangling: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (!isRecord(node)) return;
    const ref = node.$ref;
    if (typeof ref === "string") {
      const name = ref.startsWith(REF_PREFIX)
        ? ref.slice(REF_PREFIX.length)
        : "";
      if (!(name in schemas)) dangling.push(ref);
    }
    for (const entry of Object.values(node)) walk(entry);
  };
  walk(contract);
  assertEquals(
    dangling,
    [],
    "a dangling $ref is a field no consumer can generate a type for",
  );
});

test("the taxonomy and the Component schema share one vocabulary", () => {
  const componentProperties = obj(
    obj(schemas.Component, "Component").properties,
    "Component.properties",
  );
  const idPattern = new RegExp(
    str(
      obj(componentProperties.id, "Component.properties.id").pattern,
      "Component.properties.id.pattern",
    ),
  );
  const maxLength = (property: string): number =>
    int(
      obj(componentProperties[property], `Component.properties.${property}`)
        .maxLength,
      `Component.properties.${property}.maxLength`,
    );

  const ids: string[] = [];
  const orders: number[] = [];
  taxonomy.forEach((entry, i) => {
    const id = str(entry.id, `taxonomy[${i}].id`);
    assert(
      idPattern.test(id),
      `taxonomy id ${id} does not match the Component.id pattern`,
    );
    assert(
      GROUPS.includes(str(entry.group, `taxonomy[${i}].group`)),
      `taxonomy ${id} has a group the Component schema does not allow`,
    );
    for (const property of ["name", "description"]) {
      assert(
        str(entry[property], `taxonomy[${i}].${property}`).length <=
          maxLength(property),
        `taxonomy ${id} ${property} is longer than the Component schema allows`,
      );
    }
    ids.push(id);
    orders.push(int(entry.order, `taxonomy[${i}].order`));
  });

  assertEquals(new Set(ids).size, ids.length, "taxonomy ids must be unique");
  assertEquals(
    [...orders].sort((a, b) => a - b),
    ids.map((_, i) => i + 1),
    "order must be unique and dense from 1, so the UI never has to invent a tie-break",
  );
});

test("every application the taxonomy names ships in this repository", () => {
  const missing: string[] = [];
  const owners = new Map<string, string>();
  taxonomy.forEach((entry, i) => {
    const id = str(entry.id, `taxonomy[${i}].id`);
    for (const app of strList(
      entry.applications,
      `taxonomy[${i}].applications`,
    )) {
      const [chart, name] = app.split("/");
      const template =
        chart === undefined || name === undefined
          ? ""
          : join(REPO_ROOT, "charts", chart, "templates", `${name}.yaml`);
      if (template === "" || !existsSync(template)) missing.push(app);
      const owner = owners.get(app);
      assert(
        owner === undefined,
        `${app} is mapped to both ${owner} and ${id}; a visitor cannot be told two things about one service`,
      );
      owners.set(app, id);
    }
  });
  assertEquals(
    missing,
    [],
    "a mapped application with no chart template is a component map that has rotted",
  );
});

test("every state and every reason has exactly one derivation rule", () => {
  const rules = arr(derivation.rules, "stateDerivation.rules").map((raw, i) =>
    obj(raw, `stateDerivation.rules[${i}]`),
  );
  const reasons = rules.map((rule, i) =>
    str(rule.reason, `rules[${i}].reason`),
  );
  assertEquals(
    [...reasons].sort(),
    [...STATE_REASONS].sort(),
    "every StateReason needs a rule and every rule needs a declared reason",
  );
  assertEquals(
    strList(derivation.order, "stateDerivation.order"),
    reasons,
    "the evaluation order must list the rules, in the order they are written",
  );

  const severityToState = obj(
    derivation.severityToState,
    "stateDerivation.severityToState",
  );
  assertEquals(
    Object.keys(severityToState).sort(),
    [...SEVERITIES].sort(),
    "the severity mapping must be total over the Incident severities, or a firing alert has no state",
  );
  for (const [severity, state] of Object.entries(severityToState)) {
    assert(
      state === null ||
        (typeof state === "string" && COMPONENT_STATES.includes(state)),
      `severity ${severity} maps to ${String(state)}, which is not a ComponentState`,
    );
  }

  assertEquals(
    strList(overallRule.worstFirst, "overall.worstFirst").slice().sort(),
    [...COMPONENT_STATES].sort(),
    "the overall ranking must rank every state, or the headline is undefined for one of them",
  );
});

test("every derived field names the signals it depends on", () => {
  assertEquals(
    Object.keys(signalDependencies).sort(),
    ["state", "uptime"],
    "a derived field with no declared dependency is a field with no defined value when an upstream is down",
  );
  const undeclared = [...dependenciesOf("state"), ...dependenciesOf("uptime")]
    .filter((id) => !SIGNAL_IDS.includes(id))
    .sort();
  assertEquals(
    undeclared,
    [],
    "a dependency on a signal the response never reports is a dependency the UI cannot explain",
  );
  assert(
    SIGNAL_IDS.every(
      (id) =>
        dependenciesOf("state").includes(id) ||
        dependenciesOf("uptime").includes(id),
    ),
    "a reported signal that backs no field should not be in the response at all",
  );
});

// ---------------------------------------------------------------------------
// The fixtures satisfy the schema and the invariants.
// ---------------------------------------------------------------------------

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({
    name,
    body: obj(JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")), name),
  }));

const taxonomyById = new Map(
  taxonomy.map((entry) => [str(entry.id, "taxonomy id"), entry]),
);

test("there is a fixture to render, and it is not only the happy path", () => {
  assert(
    fixtures.length >= 4,
    "the UI needs the empty, not-measured and signal-lost shapes, not only the good one",
  );
});

for (const { name, body } of fixtures) {
  test(`${name} satisfies the StatusDocument schema`, () => {
    const errors: string[] = [];
    validate(body, obj(schemas.StatusDocument, "StatusDocument"), name, errors);
    assertEquals(
      errors,
      [],
      `${name} does not satisfy the contract it is a fixture for`,
    );
  });

  test(`${name} satisfies the honesty invariants`, () => {
    const components = arr(body.components, `${name}.components`).map(
      (raw, i) => obj(raw, `${name}.components[${i}]`),
    );

    const unavailable = new Set(
      arr(body.signals, `${name}.signals`)
        .map((raw, i) => obj(raw, `${name}.signals[${i}]`))
        .filter((signal) => signal.state === "unavailable")
        .map((signal) => str(signal.id, "signal id")),
    );
    const lost = (field: "state" | "uptime"): boolean =>
      dependenciesOf(field).some((id) => unavailable.has(id));

    for (const component of components) {
      const id = str(component.id, "id");
      const declared = taxonomyById.get(id);
      assert(declared !== undefined, `${name}: ${id} is not in the taxonomy`);
      for (const property of ["name", "description", "group", "order"]) {
        assertEquals(
          component[property],
          declared[property],
          `${name}: ${id} does not match the taxonomy's ${property}`,
        );
      }

      assertEquals(
        component.stateReason === "signal_unavailable",
        lost("state"),
        `${name}: ${id} reports signal_unavailable only when a signal its state depends on is down, and must report it when one is`,
      );
      if (lost("state")) {
        assertEquals(
          component.state,
          "unknown",
          `${name}: ${id} reads a real state while the signal behind it is unreadable`,
        );
      }

      const coverage = obj(component.coverage, "coverage");
      const mapped = int(coverage.mappedAlertCount, "mappedAlertCount");
      if (component.state === "operational") {
        assert(
          mapped > 0,
          `${name}: ${id} reads operational with no mapped alert -- the one thing this contract forbids`,
        );
      }
      if (mapped === 0) {
        assertEquals(
          component.state,
          "unknown",
          `${name}: ${id} has no mapped alert, so its state cannot be anything but unknown`,
        );
        if (!lost("state")) {
          assertEquals(
            component.stateReason,
            "no_signal",
            `${name}: ${id} has nothing mapped, which is the no_signal reason`,
          );
        }
      }

      const uptime = obj(component.uptime, "uptime");
      const windowDays = int(uptime.windowDays, "windowDays");
      const buckets = arr(uptime.buckets, "buckets");
      const reason = uptime.unavailableReason;
      if (uptime.ratio === null) {
        assert(
          typeof reason === "string",
          `${name}: ${id} has no uptime figure and no reason for it`,
        );
        assert(
          buckets.length === 0 || buckets.length === windowDays,
          `${name}: ${id} publishes a partial bucket array; a missing day is a null bucket`,
        );
      } else {
        assertEquals(
          reason,
          null,
          `${name}: ${id} has both an uptime figure and a reason it is unavailable`,
        );
        assertEquals(
          buckets.length,
          windowDays,
          `${name}: ${id} publishes a figure over a window it has no buckets for`,
        );
        for (const [i, raw] of buckets.entries()) {
          assert(
            obj(raw, `buckets[${i}]`).ratio !== null,
            `${name}: ${id} publishes a headline figure over a window with an unmeasured day`,
          );
        }
      }
      if (reason === "signal_unavailable") {
        assert(
          lost("uptime"),
          `${name}: ${id} blames a lost signal for its uptime while every signal behind it answered`,
        );
      } else if (lost("uptime")) {
        throw new AssertionError(
          `${name}: ${id} publishes uptime derived from a signal the document reports as unavailable`,
        );
      }
      if (reason === "no_sli") {
        assertEquals(
          coverage.hasSli,
          false,
          `${name}: ${id} claims no SLI while coverage says it has one`,
        );
        assertEquals(
          buckets.length,
          0,
          `${name}: ${id} has no SLI but ships buckets`,
        );
      }
    }

    for (const [i, raw] of arr(body.incidents, `${name}.incidents`).entries()) {
      const incident = obj(raw, `incidents[${i}]`);
      assertEquals(
        incident.endedAt === null,
        incident.state === "firing",
        `${name}: incident ${String(incident.id)} disagrees with itself about whether it is over`,
      );
      for (const componentId of strList(
        incident.componentIds,
        "componentIds",
      )) {
        assert(
          taxonomyById.has(componentId),
          `${name}: incident ${String(incident.id)} names ${componentId}, which is not in the taxonomy`,
        );
      }
    }

    const states = new Set(components.map((component) => component.state));
    const expected =
      components.length === 0
        ? str(overallRule.emptyComponents, "overall.emptyComponents")
        : strList(overallRule.worstFirst, "overall.worstFirst").find((state) =>
            states.has(state),
          );
    assertEquals(
      obj(body.overall, "overall").state,
      expected,
      `${name}: the headline disagrees with the tiles beneath it`,
    );
  });
}

test("the fixtures exercise every value the UI has to render", () => {
  const states = new Set<unknown>();
  const reasons = new Set<unknown>();
  const uptimeReasons = new Set<unknown>();
  for (const { name, body } of fixtures) {
    for (const [i, raw] of arr(
      body.components,
      `${name}.components`,
    ).entries()) {
      const component = obj(raw, `components[${i}]`);
      states.add(component.state);
      reasons.add(component.stateReason);
      uptimeReasons.add(obj(component.uptime, "uptime").unavailableReason);
    }
  }
  assertEquals(
    COMPONENT_STATES.filter((state) => !states.has(state)),
    [],
    "a state with no fixture is a state nobody has designed a rendering for",
  );
  assertEquals(
    STATE_REASONS.filter((reason) => !reasons.has(reason)),
    [],
    "a reason with no fixture is a reason the UI will render as a blank",
  );
  assertEquals(
    schemaEnum("Uptime", ["properties", "unavailableReason"]).filter(
      (reason) => !uptimeReasons.has(reason),
    ),
    [],
    "an unavailable-uptime reason with no fixture is an empty bar with no explanation",
  );
});

// ---------------------------------------------------------------------------
// The companion document does not drift from the contract.
// ---------------------------------------------------------------------------

test("the companion document names every component and every state", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  for (const entry of taxonomy) {
    const id = str(entry.id, "taxonomy id");
    assert(doc.includes(id), `the companion document never mentions ${id}`);
  }
  for (const state of COMPONENT_STATES) {
    assert(
      doc.includes(state),
      `the companion document does not say what the UI renders for ${state}`,
    );
  }
});
