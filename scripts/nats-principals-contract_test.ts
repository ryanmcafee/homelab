#!/usr/bin/env -S bun test
/**
 * ADR-043 D13's level-0 half: the assertions a static check can make over
 * contracts/events/bus-principals.v1.yaml, the `BusPrincipal -> NATS user` declaration.
 *
 * What a static check CANNOT do is assert that the server refuses. That is the level-2
 * conformance suite on Kind (MCAA-487), and per ADR-038 this file must not be the only thing
 * that is green. The division is written down in the declaration's own `conformance` block, and
 * `every level_0 conformance id has a test or a tracking issue` below fails when an id there has
 * neither -- so the split cannot silently become "level 0 only".
 *
 * The declaration is also diffed against the two contracts it has to agree with:
 * contracts/events/registry.v1.yaml (who owns which subject) and charts/nats-config (the
 * streams and consumers that actually get created). A publish grant for a type another component
 * produces, or a consumer nothing creates, is the drift this catches.
 *
 *   bun test scripts/nats-principals-contract_test.ts
 */

import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "./lib/assert.ts";
import { parse as parseYaml, parseAll as parseYamlAll } from "./lib/yaml.ts";
import {
  ARTIFACT_PATH,
  renderFromDeclaration,
} from "./render-nats-accounts.ts";

const ROOT = join(import.meta.dir, "..");
const DECLARATION_PATH = join(
  ROOT,
  "contracts",
  "events",
  "bus-principals.v1.yaml",
);
const REGISTRY_PATH = join(ROOT, "contracts", "events", "registry.v1.yaml");
const CHART_VALUES_PATH = join(ROOT, "charts", "nats-config", "values.yaml");
const NATS_CONFIG_CHART = join(ROOT, "charts", "nats-config");
const ADDONS_CHART = join(ROOT, "charts", "addons");

/** The tenant placeholder. A literal tenant token is one operator's deployment. */
const TENANT = "<tenant>";

interface Role {
  description: string;
  js_api_allow: string[];
  js_api_deny: string[];
  binds_stream_explicitly: boolean;
  durable_is_exclusive?: boolean;
}

interface Consumes {
  stream: string;
  consumer: string;
  filter: string;
}

interface Principal {
  name: string;
  role: string;
  component: string;
  publish: string[];
  subscribe: string[];
  consumes?: Consumes[];
  /** Set when nothing pre-creates this principal's durable yet; names the tracking issue. */
  pending?: string;
}

interface ConformanceEntry {
  id: string;
  asserts: string;
  pending?: string;
  open_question?: boolean;
  measured?: { image: string; suite: string; run: string };
}

interface Declaration {
  version: number;
  accounts: {
    per_tenant: boolean;
    name_template: string;
    name_pattern: string;
    system_account: string;
    system_account_principals: string[];
    exports: string;
    imports: string;
    disabled_unless_reviewed: string[];
    jetstream_limits_required: string[];
    jetstream_budget_rule: string;
  };
  subject_grants: {
    tenant_ceiling: string;
    never_granted: string[];
    inbox_prefix_template: string;
    inbox_subscribe_template: string;
    reply_mechanism: string;
    reply_inbox_publish_grant: string;
    ack_templates: string[];
  };
  roles: Record<string, Role>;
  principals: Principal[];
  conformance: {
    level_0: ConformanceEntry[];
    level_2: ConformanceEntry[];
  };
}

interface RegistryType {
  subject: string;
  producer: string;
}

const declaration = parseYaml(
  readFileSync(DECLARATION_PATH, "utf8"),
) as Declaration;
const registry = parseYaml(readFileSync(REGISTRY_PATH, "utf8")) as {
  types: RegistryType[];
};
const chart = parseYaml(readFileSync(CHART_VALUES_PATH, "utf8")) as {
  streams: { name: string }[];
  consumers: { name: string; streamName: string }[];
};

/** Every `pf.` grant any principal holds, publish and subscribe alike. */
function platformGrants(): { principal: string; subject: string }[] {
  const grants: { principal: string; subject: string }[] = [];
  for (const principal of declaration.principals) {
    for (const subject of [...principal.publish, ...principal.subscribe]) {
      grants.push({ principal: principal.name, subject });
    }
  }
  return grants;
}

/** Producer -> the subjects the registry assigns it. */
function producerSubjects(): Map<string, Set<string>> {
  const owned = new Map<string, Set<string>>();
  for (const type of registry.types) {
    const existing = owned.get(type.producer) ?? new Set<string>();
    // The registry spells the placeholder `<tenant>` too, so the two compare directly.
    existing.add(type.subject);
    owned.set(type.producer, existing);
  }
  return owned;
}

test("the declaration names version 1 and a role for every principal", () => {
  assertEquals(declaration.version, 1);
  assert(
    declaration.principals.length > 0,
    "the declaration has no principals",
  );
  for (const principal of declaration.principals) {
    assert(
      declaration.roles[principal.role] !== undefined,
      `principal ${principal.name} names role ${principal.role}, which the declaration does not define`,
    );
  }
});

test("no_wildcard_tenant_grant: no principal holds pf.> or a pf.* form", () => {
  // `pf.*.>` and `pf.>` are issued to nothing on either backend, platform components
  // included. A grant matching one makes the `<tenant>` token forgeable INSIDE the account,
  // which is the precise thing the account boundary cannot stop (ADR-043 D2).
  let inspected = 0;
  for (const { principal, subject } of platformGrants()) {
    if (!subject.startsWith("pf.")) continue;
    inspected += 1;
    const token = subject.split(".")[1];
    assert(
      token === TENANT,
      `principal ${principal} is granted ${subject}, whose tenant token is ${JSON.stringify(token)} rather than the ${TENANT} placeholder; pf.> and pf.*.> are issued to nothing`,
    );
  }
  // A gate whose matcher reaches nothing passes green. Count what it read, against a source
  // this file does not control: every registered type has an owning producer, so the grants
  // must at least cover the registry.
  assert(
    inspected >= registry.types.length,
    `only ${inspected} pf. grants were inspected against ${registry.types.length} registered types, which is too few for this assertion to be meaningful`,
  );
});

test("no_wildcard_tenant_grant: every consumer filter is tenant-scoped", () => {
  // A consumer's filter is a subscribe grant by another name: a filter of `pf.*.…` binds every
  // tenant's messages on that subject in the account, which is the same forgery surface one
  // level down.
  let inspected = 0;
  for (const principal of declaration.principals) {
    for (const bind of principal.consumes ?? []) {
      inspected += 1;
      assert(
        bind.filter.startsWith(`pf.${TENANT}.`),
        `principal ${principal.name} binds filter ${bind.filter}, which is not scoped to pf.${TENANT}.`,
      );
    }
  }
  assert(inspected > 0, "no consumer filters were inspected");
});

test("grant_within_tenant_ceiling: the ceiling is the tenant prefix and nothing holds it", () => {
  assertEquals(declaration.subject_grants.tenant_ceiling, `pf.${TENANT}.>`);
  for (const { principal, subject } of platformGrants()) {
    assert(
      subject !== declaration.subject_grants.tenant_ceiling,
      `principal ${principal} is granted the whole tenant prefix ${subject}; it is the ceiling a generated grant may not exceed, not a grant`,
    );
  }
});

test("grant_within_producer_ownership: every event publish grant is a subject the registry assigns that component", () => {
  // One registered type has exactly one owning producer, and publish permission is granted per
  // subject prefix to that component. A component that can publish another's events can forge
  // them (event-contract.md Sec. 5, boundary 2).
  const owned = producerSubjects();
  let inspected = 0;
  for (const principal of declaration.principals) {
    for (const subject of principal.publish) {
      if (subject.endsWith(".dl")) continue; // derived; checked below
      inspected += 1;
      const ownedByComponent = owned.get(principal.component);
      assert(
        ownedByComponent !== undefined,
        `principal ${principal.name} publishes ${subject} but component ${principal.component} owns no registered type`,
      );
      assert(
        ownedByComponent.has(subject),
        `principal ${principal.name} publishes ${subject}, which the registry does not assign to producer ${principal.component}`,
      );
    }
  }
  assert(
    inspected >= registry.types.length,
    `only ${inspected} publish grants were checked against the registry; the registry declares ${registry.types.length} types`,
  );
});

test("grant_within_producer_ownership: every registered type has a grant, held by its own producer", () => {
  // The other direction, and the one that bites on a routine contract addition. Without it a
  // new registered type ships with no principal able to publish it: the producer discovers a
  // permissions error at publish time, which reads like a broken ACL rather than a missing
  // grant. Checking only that each grant is owned leaves that case green.
  const granted = new Set<string>();
  for (const principal of declaration.principals) {
    for (const subject of principal.publish) {
      granted.add(`${principal.component} ${subject}`);
    }
  }
  for (const type of registry.types) {
    assert(
      granted.has(`${type.producer} ${type.subject}`),
      `registered type ${type.subject} is assigned to producer ${type.producer}, which holds no publish grant for it in the bus principal declaration`,
    );
  }
});

test("grant_within_producer_ownership: every .dl grant derives from a wq subject that principal consumes", () => {
  // A `dl` subject is never registered on its own: the consumer republishes the full original
  // envelope to the `dl` subject derived from the `wq` message it gives up on, so the grant
  // belongs to the CONSUMER of that subject and not to its producer.
  let inspected = 0;
  for (const principal of declaration.principals) {
    for (const subject of principal.publish) {
      if (!subject.endsWith(".dl")) continue;
      inspected += 1;
      const wq = `${subject.slice(0, -3)}.wq`;
      const consumesIt = (principal.consumes ?? []).some(
        (bind) => bind.filter === wq,
      );
      assert(
        consumesIt,
        `principal ${principal.name} may publish ${subject} but consumes no ${wq}; a dead-letter grant without the work it dead-letters is a publish grant on another consumer's failure path`,
      );
    }
  }
  assert(inspected > 0, "no .dl grants were inspected");
});

test("no_shared_inbox_or_ack: the broad inbox and ACK forms are refused to everything", () => {
  const never = new Set(declaration.subject_grants.never_granted);
  for (const forbidden of [
    "pf.>",
    "pf.*.>",
    "$JS.ACK.>",
    "_INBOX.>",
    "$JS.API.>",
    "$JS.>",
  ]) {
    assert(
      never.has(forbidden),
      `${forbidden} is missing from subject_grants.never_granted; a shared grant on it lets any principal in the account read or acknowledge its neighbours' traffic (ADR-043 D5a)`,
    );
  }
  // And nothing actually holds one.
  for (const { principal, subject } of platformGrants()) {
    assert(
      !never.has(subject),
      `principal ${principal} is granted ${subject}, which never_granted forbids`,
    );
  }
});

test("no_shared_inbox_or_ack: every ACK template pins the principal's own stream and consumer", () => {
  const templates = declaration.subject_grants.ack_templates;
  assert(
    templates.length >= 2,
    "both ACK subject forms must be declared; the server emits the v1 $JS.ACK.<stream>.<consumer> form and the v2 $JS.ACK.<domain>.<account-hash>.<stream>.<consumer> form, and a grant covering only one leaves the other unusable or unscoped",
  );
  for (const template of templates) {
    assert(
      template.includes("<stream>") && template.includes("<consumer>"),
      `ACK template ${template} does not pin both <stream> and <consumer>; $JS.ACK.> admits acknowledging another consumer's messages inside the account`,
    );
  }
});

test("no_shared_inbox_or_ack: the inbox prefix is derived from the principal name", () => {
  // A declared per-principal inbox could name another principal's prefix. Deriving it from the
  // name is what makes that unrepresentable, so the templates must carry the placeholder.
  assert(
    declaration.subject_grants.inbox_prefix_template.includes("<principal>"),
    "inbox_prefix_template does not carry <principal>, so the prefix is not per-principal",
  );
  assert(
    declaration.subject_grants.inbox_subscribe_template.includes("<principal>"),
    "inbox_subscribe_template does not carry <principal>",
  );
  for (const { principal, subject } of platformGrants()) {
    assert(
      !subject.startsWith("_INBOX."),
      `principal ${principal} declares an inbox grant ${subject}; inbox grants are generated from the principal name, never declared`,
    );
  }
  assertEquals(
    declaration.subject_grants.reply_inbox_publish_grant,
    "forbidden",
    "a standing publish grant on another principal's inbox reads every reply that principal receives",
  );
});

test("js_api_allow_is_exhaustive: no role reaches a destructive or account-wide endpoint", () => {
  // The account-scoped $JS.API surface is far larger than the handful of verbs one thinks to
  // name. Enumerating dangerous verbs is the wrong shape and goes stale at the next chart bump
  // -- the allow-list is what holds -- so this asserts over what the allow-lists CONTAIN
  // rather than over a deny list that has to stay complete (ADR-043 D5).
  const refused = [
    "$JS.API.>",
    "$JS.>",
    "$JS.API.STREAM.MSG.GET",
    "$JS.API.ACCOUNT.PURGE",
    "$JS.API.STREAM.RESTORE",
    "$JS.API.STREAM.SNAPSHOT",
    "$JS.API.SERVER.",
  ];
  let inspected = 0;
  for (const [name, role] of Object.entries(declaration.roles)) {
    for (const allowed of role.js_api_allow) {
      inspected += 1;
      for (const prefix of refused) {
        assert(
          !allowed.startsWith(prefix),
          `role ${name} allows ${allowed}, which reaches ${prefix}; STREAM.MSG.GET reads any message body in the account and ACCOUNT.PURGE destroys all of it`,
        );
      }
    }
  }
  assert(
    inspected >= 17,
    `only ${inspected} $JS.API allow entries were inspected across ${Object.keys(declaration.roles).length} roles`,
  );
});

test("js_api_allow_is_exhaustive: only the stream controller holds stream lifecycle rights", () => {
  // The stream set is GitOps state reconciled by NACK, so nothing else needs stream lifecycle
  // rights, and any component holding them can delete a tenant's durable work in one request.
  for (const [name, role] of Object.entries(declaration.roles)) {
    if (name === "stream_controller") continue;
    for (const allowed of role.js_api_allow) {
      assert(
        !/\$JS\.API\.STREAM\.(CREATE|UPDATE|DELETE|PURGE)/.test(allowed),
        `role ${name} allows ${allowed}; only the stream controller reconciles the stream set`,
      );
    }
  }
});

test("js_api_allow_is_exhaustive: a bound puller's reads are scoped to its own stream and consumer", () => {
  const role = declaration.roles.bound_puller;
  assert(role !== undefined, "role bound_puller is missing");
  for (const allowed of role.js_api_allow) {
    if (allowed === "$JS.API.INFO") continue;
    assert(
      allowed.includes("<stream>"),
      `role bound_puller allows ${allowed} without naming <stream>; an account-wide read reaches a neighbour's stream inside the same account`,
    );
  }
  assert(
    role.binds_stream_explicitly,
    "role bound_puller does not bind its stream explicitly; nats.go's subscribe path then discovers over $JS.API.STREAM.NAMES, which is not in the allow-list (ADR-043 D5b)",
  );
  assert(
    role.durable_is_exclusive === true,
    "role bound_puller does not declare durable_is_exclusive; an ack on a SHARED durable advances the delivery state every other reader of it depends on (ADR-043 D7a)",
  );
});

/** Whether two NATS subject patterns admit at least one common subject. */
function subjectsIntersect(a: string, b: string): boolean {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; ; i += 1) {
    if (i === left.length || i === right.length) {
      return i === left.length && i === right.length;
    }
    if (left[i] === ">" || right[i] === ">") return true;
    if (left[i] !== "*" && right[i] !== "*" && left[i] !== right[i]) {
      return false;
    }
  }
}

/** Every subject shape v2.15.0 routes to its consumer-create handler. */
const CONSUMER_CREATE_SUBJECTS = [
  "$JS.API.CONSUMER.CREATE.*",
  "$JS.API.CONSUMER.CREATE.*.>",
  "$JS.API.CONSUMER.DURABLE.CREATE.*.*",
];

/** Placeholders widened to the broadest subject they can render to, so no allow hides behind one. */
function widenPlaceholders(template: string): string {
  return template
    .replaceAll("<stream>", "*")
    .replaceAll("<consumer>", "*")
    .replaceAll("<filter>", ">")
    .replaceAll("<tenant>", "*");
}

/** The allows among `allow` that reach a consumer-create subject. */
function consumerCreateReach(allow: string[]): string[] {
  return allow.filter((subject) =>
    CONSUMER_CREATE_SUBJECTS.some((create) =>
      subjectsIntersect(widenPlaceholders(subject), create),
    ),
  );
}

test("consumer_create_only_stream_controller: the matcher fails a broad allow and passes the controller", () => {
  // A literal substring check passes `$JS.API.>`, which is a create grant like any other.
  for (const broad of [
    ">",
    "$JS.>",
    "$JS.API.>",
    "$JS.API.CONSUMER.>",
    "$JS.API.CONSUMER.*.*",
    "$JS.API.CONSUMER.*.<stream>.<consumer>",
    "$JS.API.*.DURABLE.CREATE.*.*",
    "$JS.API.CONSUMER.CREATE.<stream>.<consumer>.<filter>",
  ]) {
    assertEquals(
      consumerCreateReach([broad]),
      [broad],
      `${broad} reaches a consumer-create subject but the matcher did not flag it`,
    );
  }
  for (const narrow of [
    "$JS.API.INFO",
    "$JS.API.CONSUMER.INFO.<stream>.<consumer>",
    "$JS.API.CONSUMER.MSG.NEXT.<stream>.<consumer>",
    "$JS.API.STREAM.CREATE.*",
  ]) {
    assertEquals(
      consumerCreateReach([narrow]),
      [],
      `${narrow} reaches no consumer-create subject but the matcher flagged it`,
    );
  }
  assertEquals(
    consumerCreateReach(declaration.roles.stream_controller.js_api_allow)
      .length,
    CONSUMER_CREATE_SUBJECTS.length,
    "the matcher does not see stream_controller's three create allows, so a pass elsewhere proves nothing",
  );
});

test("consumer_create_only_stream_controller: no other role or rendered principal can create a consumer", () => {
  // A create body carries a `deliver_subject` the server never checks against the creator's
  // publish grant, so any create authority is a redirect of the stream (ADR-043 D6b).
  let inspected = 0;
  for (const [name, role] of Object.entries(declaration.roles)) {
    if (name === "stream_controller") continue;
    inspected += role.js_api_allow.length;
    assertEquals(
      consumerCreateReach(role.js_api_allow),
      [],
      `role ${name} holds consumer-create authority; only stream_controller creates consumers`,
    );
  }
  const artifact = parseYaml(readFileSync(ARTIFACT_PATH, "utf8")) as {
    principals: { name: string; role: string; publish: { allow: string[] } }[];
  };
  for (const principal of artifact.principals) {
    if (principal.role === "stream_controller") continue;
    inspected += principal.publish.allow.length;
    assertEquals(
      consumerCreateReach(principal.publish.allow),
      [],
      `rendered principal ${principal.name} may publish to a consumer-create subject; only nack creates consumers`,
    );
  }
  assert(inspected >= 20, `only ${inspected} allow entries were inspected`);
});

test("consumer_create_denies_present: binding roles deny the alternates, and the controller denies no create form", () => {
  // Under default-deny the name-only and legacy-durable entrances are already refused; the denies
  // exist so a later broader grant cannot quietly re-open them. Deny takes precedence over allow,
  // so the controller denying any create form would stop NACK reconciling consumers.
  let inspected = 0;
  for (const [name, role] of Object.entries(declaration.roles)) {
    const binds = role.js_api_allow.some((s) =>
      s.startsWith("$JS.API.CONSUMER.MSG.NEXT."),
    );
    if (name === "stream_controller" || !binds) continue;
    inspected += 1;
    for (const required of [
      "$JS.API.CONSUMER.CREATE.*",
      "$JS.API.CONSUMER.DURABLE.CREATE.*.*",
    ]) {
      assert(
        role.js_api_deny.includes(required),
        `role ${name} binds a consumer but does not deny ${required}`,
      );
    }
  }
  assert(inspected > 0, "no binding role was inspected");
  const controllerDenies = consumerCreateReach(
    declaration.roles.stream_controller.js_api_deny,
  );
  assertEquals(
    controllerDenies,
    [],
    "stream_controller denies a consumer-create form; deny takes precedence over allow, so NACK could not create the durables every bound_puller needs",
  );
});

test("no_system_account_principal: nothing on the platform holds $SYS", () => {
  // The `nack` 0.35.0 chart's values invite exactly the opposite by naming the controller
  // credential `nats-sys-creds`. A system-account NACK has cross-account reach over every
  // tenant's streams, which is the boundary the account buys (ADR-043 D4).
  assertEquals(
    declaration.accounts.system_account_principals,
    [],
    "a platform component is listed as holding the system account",
  );
  assertEquals(declaration.accounts.system_account, "$SYS");
  for (const principal of declaration.principals) {
    assert(
      principal.name !== "$SYS" && principal.role !== "$SYS",
      `principal ${principal.name} names the system account`,
    );
    for (const subject of [...principal.publish, ...principal.subscribe]) {
      assert(
        !subject.startsWith("$SYS"),
        `principal ${principal.name} is granted ${subject}, which is system-account territory`,
      );
    }
  }
});

test("no_cross_account_link: exports and imports are forbidden and the bypasses are listed", () => {
  // An export is the one construct that reopens the account boundary invisibly to every subject
  // permission (ADR-043 D3). Leaf nodes, gateways, WebSocket, MQTT and subject mappings are
  // routing rather than authorization, and each can carry traffic past the assumptions above.
  assertEquals(declaration.accounts.exports, "forbidden");
  assertEquals(declaration.accounts.imports, "forbidden");
  const disabled = new Set(declaration.accounts.disabled_unless_reviewed);
  for (const feature of [
    "leafnodes",
    "gateways",
    "websocket",
    "mqtt",
    "mappings",
  ]) {
    assert(
      disabled.has(feature),
      `${feature} is not listed in accounts.disabled_unless_reviewed; it can carry traffic past every subject permission`,
    );
  }
});

test("jetstream_limits_declared: all four per-account limits are mandatory", () => {
  // Without them one tenant's streams exhaust the shared file store and every account on that
  // peer is refused with `insufficient resources (10047)` (ADR-043 D8).
  assertEquals(declaration.accounts.jetstream_limits_required, [
    "max_memory",
    "max_store",
    "max_streams",
    "max_consumers",
  ]);
  assert(
    declaration.accounts.per_tenant === true,
    "accounts.per_tenant is not true; one account per tenant IS the enforcement (ADR-043 D1)",
  );
  assert(
    /<TENANT>/.test(declaration.accounts.name_template),
    "accounts.name_template carries no <TENANT> placeholder, so the account name is one operator's tenant",
  );
});

test("durable_not_shared: no two principals bind the same stream and consumer", () => {
  // ADR-045 claims the trigger bus cannot move PF_EVENTS or PF_AUDIT state. That is a property
  // of this, not of running a second StatefulSet: an ack on a shared durable advances the
  // delivery state every other reader of it depends on, and every subject permission still
  // reads correct while it happens (ADR-043 D7a).
  const seen = new Map<string, string>();
  let inspected = 0;
  for (const principal of declaration.principals) {
    for (const bind of principal.consumes ?? []) {
      inspected += 1;
      const key = `${bind.stream}/${bind.consumer}`;
      const owner = seen.get(key);
      assert(
        owner === undefined,
        `principals ${owner} and ${principal.name} both bind ${key}; a shared durable puts one principal's failure domain inside the other's consumer state`,
      );
      seen.set(key, principal.name);
    }
  }
  assert(inspected > 1, "fewer than two binds were inspected");
});

test("every bound consumer exists in the chart that creates it, and names its own stream", () => {
  // A bound_puller has no consumer-create grant, so a durable the chart does not pre-create is
  // a principal that cannot start. The failure is a permissions error at runtime, which reads
  // like a bad ACL rather than a missing resource.
  const chartConsumers = new Map(
    chart.consumers.map((consumer) => [consumer.name, consumer.streamName]),
  );
  const chartStreams = new Set(chart.streams.map((stream) => stream.name));
  let inspected = 0;
  for (const principal of declaration.principals) {
    const role = declaration.roles[principal.role];
    for (const bind of principal.consumes ?? []) {
      assert(
        chartStreams.has(bind.stream),
        `principal ${principal.name} binds stream ${bind.stream}, which charts/nats-config does not declare`,
      );
      if (role.durable_is_exclusive !== true) continue;
      if (principal.pending !== undefined) continue;
      inspected += 1;
      assertEquals(
        chartConsumers.get(bind.consumer),
        bind.stream,
        `principal ${principal.name} binds pre-created durable ${bind.consumer} on ${bind.stream}, which charts/nats-config does not create on that stream`,
      );
    }
  }
  assert(inspected > 0, "no pre-created durable was checked against the chart");
});

test("a principal whose durable nothing creates yet names its tracking issue", () => {
  // `pending` is the only thing that excuses a bound principal from the chart cross-check
  // above, so it has to be a tracking issue rather than a way of quieting the gate. Dropping
  // the key without adding the durable puts the principal straight back into that check.
  let pendingCount = 0;
  for (const principal of declaration.principals) {
    if (principal.pending === undefined) continue;
    pendingCount += 1;
    assert(
      /^MCAA-\d+$/.test(principal.pending),
      `principal ${principal.name} is pending on ${JSON.stringify(principal.pending)}, which is not a tracking issue identifier`,
    );
    assert(
      principal.publish.length === 0,
      `principal ${principal.name} is pending but holds publish grants; a grant for a component that does not exist is a credential with no owner`,
    );
  }
  assert(
    pendingCount < declaration.principals.length,
    "every principal is pending, so the chart cross-check reads nothing",
  );
});

/** `helm template`, as the exit code and the combined output the guards write to. */
function helmTemplate(
  chart: string,
  ...args: string[]
): { code: number; output: string } {
  const proc = Bun.spawnSync(["helm", "template", "probe", chart, ...args]);
  if (proc.exitCode === null) {
    throw new Error(`helm template was killed by a signal: ${proc.signalCode}`);
  }
  return {
    code: proc.exitCode,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

/** Marks a generated render value so a diff, a render or a scan reads it as not a credential. */
const NOT_A_CREDENTIAL = "SYNTHETICRENDERFIXTURE";

/**
 * The `--set` pair that gives a principal a public nkey for a render.
 *
 * The chart only requires a `<principal>=<key>` pair and never inspects the key material, so the
 * value is derived from the principal name at run time. Nothing pairs an nkey assignment with a
 * literal token in the tree, which is what a committed placeholder did.
 */
function publicNkeyArgs(principal: string): string[] {
  const generated = `U${principal.toUpperCase()}${NOT_A_CREDENTIAL}`;
  return ["--set", `nats.principalNkeys=${principal}=${generated}`];
}

test("the committed accounts artifact matches the declaration", () => {
  // charts/addons cannot read `contracts/` -- Helm's `.Files.Get` is scoped to the chart
  // directory -- so the expansion is committed. This is the only thing pinning the copy the
  // server renders from to the declaration it claims to implement; without it a grant edited
  // in one file and not the other ships as two permission models.
  assertEquals(
    readFileSync(ARTIFACT_PATH, "utf8"),
    renderFromDeclaration(),
    "charts/addons/files/nats-accounts.gen.yaml is stale; regenerate it with `bun scripts/render-nats-accounts.ts`",
  );
});

test("stream_and_consumer_name_account: every rendered Stream and Consumer sets spec.account", () => {
  // A resource without `spec.account` falls back to NACK's server-wide credential, so it is
  // created in whatever account that one reaches. Reading the values file would not catch it:
  // only a render exercises the `with` that emits the field.
  const rendered = helmTemplate(
    NATS_CONFIG_CHART,
    "--set",
    "account.name=tenant-probe",
    "--set",
    "account.natsName=TENANT_PROBE",
    "--set",
    "account.credentialSecret=nats-principal-nack",
  );
  assert(
    rendered.code === 0,
    `helm template exited ${rendered.code}\n${rendered.output}`,
  );
  const docs = parseYamlAll(rendered.output).filter(
    (
      doc,
    ): doc is {
      kind: string;
      metadata: { name: string };
      spec: Record<string, unknown>;
    } => doc !== null && typeof doc === "object",
  );
  let inspected = 0;
  for (const doc of docs) {
    if (doc.kind !== "Stream" && doc.kind !== "Consumer") continue;
    inspected += 1;
    assertEquals(
      doc.spec.account,
      "tenant-probe",
      `${doc.kind} ${doc.metadata.name} does not name the tenant account`,
    );
  }
  // A gate whose matcher reaches nothing passes green: the chart declares one resource per
  // stream plus one per consumer, and the declaration binds every one of them.
  const expected = chart.streams.length + chart.consumers.length;
  assertEquals(
    inspected,
    expected,
    `${inspected} of the chart's ${expected} Stream and Consumer resources were inspected`,
  );

  // And the Account they name is NACK's own tenant credential, never `$SYS` -- the `nack`
  // chart's `nats-sys-creds` default invites exactly that (ADR-043 D4). `spec.nkey` and not
  // `spec.creds`: the latter is an nsc credentials file and the two are not interchangeable.
  const accounts = docs.filter((doc) => doc.kind === "Account");
  assertEquals(accounts.length, 1, "the chart rendered no single Account");
  const account = accounts[0].spec as {
    name: string;
    nkey?: { secret?: { name?: string } };
    creds?: unknown;
  };
  assertEquals(account.name, "TENANT_PROBE");
  assert(
    account.creds === undefined,
    "the Account carries spec.creds, which is an nsc credentials file rather than the nkey the static backend issues",
  );
  assertEquals(account.nkey?.secret?.name, "nats-principal-nack");
});

test("stream_and_consumer_name_account: the field is absent only when no account is configured", () => {
  // The other half, and the one that keeps the assertion above from passing on a template
  // that emits the field unconditionally: with no account the chart is the pre-ADR-043
  // anonymous bus, and a hard-coded `spec.account` would break it.
  const rendered = helmTemplate(NATS_CONFIG_CHART);
  assert(
    rendered.code === 0,
    `helm template exited ${rendered.code}\n${rendered.output}`,
  );
  assert(
    !/^\s+account:/m.test(rendered.output),
    "the chart renders spec.account with no account configured",
  );
});

interface RenderedConsumer {
  kind: string;
  metadata: { name: string };
  spec: Record<string, unknown>;
}

/** The Consumers among `docs` whose spec selects push delivery, by the CRD's own field names. */
function pushConsumers(docs: RenderedConsumer[]): string[] {
  const nonEmpty = (value: unknown) =>
    value !== undefined && value !== null && value !== "";
  return docs
    .filter((doc) => doc.kind === "Consumer")
    .filter(
      (doc) =>
        nonEmpty(doc.spec.deliverSubject) || nonEmpty(doc.spec.deliverGroup),
    )
    .map((doc) => doc.metadata.name);
}

function renderedConsumers(): RenderedConsumer[] {
  const rendered = helmTemplate(NATS_CONFIG_CHART);
  assert(
    rendered.code === 0,
    `helm template exited ${rendered.code}\n${rendered.output}`,
  );
  return parseYamlAll(rendered.output).filter(
    (doc): doc is RenderedConsumer =>
      doc !== null &&
      typeof doc === "object" &&
      (doc as { kind?: unknown }).kind === "Consumer",
  );
}

test("no_push_consumer: no rendered Consumer sets deliverSubject or deliverGroup", () => {
  // A push consumer declared in Git is the deliver_subject redirect with a reviewer's signature
  // on it; on v2.15.0 deliverSubject alone selects push mode (ADR-043 D6b).
  const consumers = renderedConsumers();
  assertEquals(
    consumers.length,
    chart.consumers.length,
    `${consumers.length} of the chart's ${chart.consumers.length} Consumers were rendered`,
  );
  assertEquals(pushConsumers(consumers), [], "a rendered Consumer is push");
});

test("no_push_consumer: each push field alone fails the rule", () => {
  const [base] = renderedConsumers();
  assert(base !== undefined, "the chart rendered no Consumer to mutate");
  for (const field of ["deliverSubject", "deliverGroup"]) {
    const mutated = { ...base, spec: { ...base.spec, [field]: "pf.x.y" } };
    assertEquals(
      pushConsumers([mutated]),
      [base.metadata.name],
      `a Consumer setting spec.${field} was not flagged`,
    );
  }
  const emptied = { ...base, spec: { ...base.spec, deliverSubject: "" } };
  assertEquals(
    pushConsumers([emptied]),
    [],
    "an empty deliverSubject was flagged",
  );
});

/** The test-only opt-in past the ADR-055 render guard, for renders that enable auth on purpose. */
const NACK_INBOX_OPT_IN_KEY = "testOnlyAuthWithoutNackInbox";
const NACK_INBOX_OPT_IN = ["--set", `nats.${NACK_INBOX_OPT_IN_KEY}=true`];

test("nack_inbox_prefix_render_guard: setting keys without the opt-in is refused, naming ADR-055", () => {
  // The pinned NACK cannot set `_INBOX.nack`, so an authenticated bus would freeze the stream
  // set while every Application reads Synced. The refusal must happen at render.
  const args = [
    "--set",
    "nats.enabled=true",
    ...publicNkeyArgs("nack"),
    "--show-only",
    "templates/nats.yaml",
  ];
  const refused = helmTemplate(ADDONS_CHART, ...args);
  assert(
    refused.code !== 0,
    `keys rendered with no NACK inbox prefix\n${refused.output}`,
  );
  assertStringIncludes(refused.output, "cannot set its inbox prefix");
  assertStringIncludes(refused.output, "(ADR-055)");

  // The other half, so the refusal above is the guard and not some unrelated failure.
  const optedIn = helmTemplate(ADDONS_CHART, ...args, ...NACK_INBOX_OPT_IN);
  assert(optedIn.code === 0, `the opted-in render failed\n${optedIn.output}`);
  const anonymous = helmTemplate(
    ADDONS_CHART,
    "--set",
    "nats.enabled=true",
    "--show-only",
    "templates/nats.yaml",
  );
  assert(
    anonymous.code === 0,
    `the anonymous bus no longer renders without the opt-in\n${anonymous.output}`,
  );
});

test("nack_inbox_prefix_render_guard: no shipped values surface sets the test-only opt-in", () => {
  // The opt-in is for suites that enable auth on purpose. Matched as a bare word rather than a
  // YAML key, so a templated or commented-out setting is caught too.
  const surfaces = [
    join(ADDONS_CHART, "values.yaml"),
    join(ADDONS_CHART, "values-localdev.yaml"),
    join(ROOT, "configuration", "templates", "helm-addons.tmpl"),
  ];
  for (const surface of surfaces) {
    const text = readFileSync(surface, "utf8");
    assert(text.length > 0, `${surface} read empty`);
    assert(
      !text.includes(NACK_INBOX_OPT_IN_KEY),
      `${surface} mentions ${NACK_INBOX_OPT_IN_KEY}; that key is for test suites only, and a shipped render that sets it enables auth NACK cannot reconcile under (ADR-055)`,
    );
  }
});

test("callout_allowed_accounts_bounded: an unbounded callout is refused before it renders", () => {
  // v2.15.0 delegates EVERY account to the callout service when `allowed_accounts` is left
  // empty, so the secure value is not the default. The bound is checked before the backend
  // exists, because otherwise the first configuration that could get it wrong is also the
  // first one nothing checks.
  const base = [
    "--set",
    "nats.enabled=true",
    ...publicNkeyArgs("nack"),
    "--show-only",
    "templates/nats.yaml",
  ];

  const unbounded = helmTemplate(
    ADDONS_CHART,
    ...base,
    "--set",
    "nats.authCallout.issuer=ABPROBE",
  );
  assert(
    unbounded.code !== 0,
    `an auth callout with no allowed_accounts rendered\n${unbounded.output}`,
  );
  assertStringIncludes(
    unbounded.output,
    "allowedAccounts is empty",
    "an unbounded callout was refused for the wrong reason",
  );

  const system = helmTemplate(
    ADDONS_CHART,
    ...base,
    "--set",
    "nats.authCallout.issuer=ABPROBE",
    "--set",
    "nats.authCallout.allowedAccounts[0]=$SYS",
  );
  assert(
    system.code !== 0,
    `an auth callout allowed to mint $SYS users rendered\n${system.output}`,
  );
  assertStringIncludes(
    system.output,
    "names $SYS",
    "a $SYS-reaching callout was refused for the wrong reason",
  );

  // A BOUNDED callout is refused too, and for a different reason: only the static backend
  // ships. Distinguishing the two rejections is what shows the bound is measured rather than
  // shadowed by a blanket refusal that would pass this test while checking nothing.
  const bounded = helmTemplate(
    ADDONS_CHART,
    ...base,
    "--set",
    "nats.authCallout.issuer=ABPROBE",
    "--set",
    "nats.authCallout.allowedAccounts[0]=TENANT_PROBE",
  );
  assert(
    bounded.code !== 0,
    `the unimplemented callout backend rendered\n${bounded.output}`,
  );
  assertStringIncludes(
    bounded.output,
    "only the static backend ships",
    "a bounded callout was refused for the wrong reason",
  );
});

test("callout_allowed_accounts_bounded: the shipped config configures no callout at all", () => {
  const rendered = helmTemplate(
    ADDONS_CHART,
    "--set",
    "nats.enabled=true",
    ...publicNkeyArgs("nack"),
    ...NACK_INBOX_OPT_IN,
    "--show-only",
    "templates/nats.yaml",
  );
  assert(
    rendered.code === 0,
    `helm template exited ${rendered.code}\n${rendered.output}`,
  );
  // Matched as config KEYS. A substring match would also hit this template's own comments
  // explaining why neither key is set, which is a gate that passes by reading the fix.
  for (const forbidden of ["auth_callout", "authCallout", "no_auth_user"]) {
    assert(
      !new RegExp(`^\\s*${forbidden}\\s*:`, "m").test(rendered.output),
      `the rendered server config sets ${forbidden}; the static backend renders an accounts block and nothing else, and no_auth_user would hand every anonymous connection an account`,
    );
  }
  // The accounts block itself, and `$SYS` declared with no user. v2.15.0 resolves
  // `system_account` against the accounts it was given and exits with `error resolving system
  // account: account missing` when the name is absent -- and `nats-server -t` does NOT catch
  // that, so the omission is a crash loop on sync rather than a rejected config.
  assertStringIncludes(rendered.output, "system_account: $SYS");
  assertStringIncludes(rendered.output, "$SYS:\n                users: []");
});

test("every level_0 conformance id has a test or a tracking issue", () => {
  // The honest split between a static check and a running server only holds if an id added here
  // has to be implemented. An id with neither a test nor a `pending` tracking issue is a
  // conformance claim with nothing behind it.
  const source = readFileSync(import.meta.path, "utf8");
  for (const entry of declaration.conformance.level_0) {
    if (entry.pending !== undefined) {
      assert(
        /^MCAA-\d+$/.test(entry.pending),
        `level_0 id ${entry.id} is pending on ${JSON.stringify(entry.pending)}, which is not a tracking issue identifier`,
      );
      continue;
    }
    // A test that only names the id in a comment would satisfy a substring match. Require the
    // id at the start of a test name, which is where the tests above put it.
    assert(
      source.includes(`test("${entry.id}:`) ||
        source.includes(`test("${entry.id}"`),
      `level_0 conformance id ${entry.id} has no test named for it and no pending tracking issue`,
    );
  }
});

test("every level_2 conformance id states whether it is measured", () => {
  // ADR-038 exists because the alternative is a green gate over a broker that disagrees. An
  // unmeasured mechanism is named as an open question rather than promoted to a claim, so the
  // reader of this contract can tell the two apart.
  const openQuestions = declaration.conformance.level_2.filter(
    (entry) => entry.open_question === true,
  );
  assertEquals(
    openQuestions.map((entry) => entry.id).sort(),
    ["nack_account_on_stream_move"],
    "the set of open questions changed; promoting one to a claim needs the level-2 measurement, and adding one needs the ADR amended",
  );
  for (const entry of openQuestions) {
    assert(
      entry.asserts.includes("UNMEASURED"),
      `level_2 open question ${entry.id} does not say it is unmeasured`,
    );
    assert(
      entry.measured === undefined,
      `level_2 open question ${entry.id} also records a measurement`,
    );
  }
  const promoted = declaration.conformance.level_2.filter(
    (entry) => entry.measured !== undefined,
  );
  assertEquals(
    promoted.map((entry) => entry.id).sort(),
    ["consumer_create_name_only_reach", "rq_reply_needs_no_inbox_grant"],
    "every former open question must cite the level-2 run that answered it",
  );
  for (const { id, asserts, measured } of promoted) {
    assert(
      !asserts.includes("UNMEASURED"),
      `level_2 id ${id} is measured but still says UNMEASURED`,
    );
    assert(
      /^docker\.io\/library\/nats@sha256:[0-9a-f]{64}$/.test(
        measured?.image ?? "",
      ),
      `level_2 id ${id} cites ${JSON.stringify(measured?.image)}, not a rendered nats image digest`,
    );
    assert(
      /^https:\/\/github\.com\/ryanmcafee\/homelab\/actions\/runs\/\d+$/.test(
        measured?.run ?? "",
      ),
      `level_2 id ${id} cites ${JSON.stringify(measured?.run)}, not a CI run`,
    );
    const probes = readFileSync(
      join(ROOT, measured?.suite ?? "", "probes.sh"),
      "utf8",
    );
    assert(
      probes.includes(`id=${id}`),
      `level_2 id ${id} cites suite ${measured?.suite}, whose probes.sh does not exercise it`,
    );
  }
  assert(
    declaration.conformance.level_2.length >
      declaration.conformance.level_0.length / 2,
    "the level-2 suite has shrunk relative to level 0; per ADR-038 the static gate must not be the only thing that is green",
  );
});
