# The event contract: CloudEvents over NATS

Normative. Decision records: ADR-026, revised by **ADR-038** after the second-reviewer pass,
in [`docs/project_notes/decisions.md`](../project_notes/decisions.md).
Machine-checkable artifacts: [`contracts/events/`](../../contracts/events), gated by
`task contracts:check`.

## 1. The envelope

Every message on the platform bus is a CloudEvents 1.0 event in **structured JSON mode**,
narrowed by [`contracts/events/envelope.v1.schema.json`](../../contracts/events/envelope.v1.schema.json).
The profile narrows the spec in four places, each for a reason:

| Narrowing | Why |
|---|---|
| `datacontenttype` fixed to `application/json` | A second content type is a second serialization contract and a second set of compatibility rules. Binary mode buys throughput this platform does not need yet, and costs a permanent fork in every consumer. |
| `dataschema` required (CloudEvents makes it optional) | A payload whose shape is not published is not a contract. |
| `type` must end in an explicit major version | A consumer subscribed to `…v1` can never be handed a v2 body. The version is not a separate attribute anyone can forget to read. |
| `tenant` a required extension | It is the trust boundary, and it is the one attribute a consumer may never be asked to infer. |
| `sequence` an **optional** extension | It is the only honest ordering token, but only the broker can assign it: the SDK fills it from the PubAck, and on the core-NATS `rq` path there is no stream and no PubAck at all. A required attribute a producer must fill with a placeholder is a lie in the schema. Present on every event a consumer receives from a stream; absent on a synchronous request. |

The major version lives in **both** the `type` and the subject, and `task contracts:check`
fails if they disagree. Redundancy is deliberate: a reader who has only one of them can still
tell which contract they are looking at.

The `com.mcafeeconsulting.platform.` prefix in `type` is **fixed, and a fork does not change
it.** It identifies the platform software, which a forked install still runs, and it is what
makes an event from any install recognisable to the same SDK. The operator's own identity
travels in `source`, whose domain segment is parameterised — that is the attribute the
fork-ability contract is about.

`dataschema` resolution is defined rather than left to each producer: the wire value is
`<contracts_base_uri>` + the relative path in the registry, where `contracts_base_uri` is a
single operator-supplied setting ending in `/`. The registry stores the relative path and the
compatibility gate compares relative paths; only the base differs between installs. Every
registered `dataschema` resolves to a file under [`contracts/events/data/`](../../contracts/events/data)
and the gate opens it — an unpublished payload is not a contract, so the rule is enforced and
not merely asserted.

**`$id` is identity; `dataschema` is location.** Every schema's `$id` stays
`https://github.com/ryanmcafee/homelab/…` on a fork, while its `dataschema` on the wire resolves
through that fork's own `contracts_base_uri`. This is deliberate and is the same argument as the
fixed `com.mcafeeconsulting.platform.` type prefix: the schema's identity belongs to the platform
software, which a fork still runs, and only the retrieval URI is the operator's. Cache and compare
by `$id`; fetch by `dataschema`. Do not key a schema cache on the retrieval URI, or two installs
of the same contract look like two contracts.

## 2. The subject taxonomy

Seven tokens, always:

```
pf.<tenant>.<domain>.<entity>.<action>.<major>.<suffix>
```

Defined in [`contracts/events/subjects.v1.yaml`](../../contracts/events/subjects.v1.yaml).

**Fixed token count is the whole design.** `pf.*.workload.*.*.v1.ev` is a stable wildcard for
"every v1 workload event in every tenant", and because `*` matches exactly one token it cannot
silently start matching a deeper subject somebody adds next quarter. A variable-depth taxonomy
makes every wildcard a latent bug.

The suffix carries the delivery guarantee so a reader knows it without opening the registry:

| Suffix | Path | Delivery | Ordering |
|---|---|---|---|
| `ev` | Pub/sub via `PF_EVENTS`; `PF_AUDIT` **sources** identity/control from it | **at-least-once** | per subject *on the stream* — see §3 |
| `wq` | Durable request via the `PF_WORK` work-queue stream | **at-least-once** | none |
| `rq` | Synchronous request on core NATS, never persisted. The **reply** goes to the requester's `_INBOX.…`, which is outside this grammar — which is why there is no `rs` suffix | **at-most-once** | none |
| `dl` | Dead letter: the full original envelope of a `wq` message a consumer gave up on, on `PF_DLQ` | **at-least-once** | per subject |

`domain`, `entity` and `action` allow internal hyphens (`analysis-run.step-completed`). A
hyphen is not a NATS token separator, so the token count and every wildcard guarantee are
untouched.

**`pf.>` is reserved for the platform bus.** No third-party bus — Argo Events, Temporal,
anything added later — may place a stream, consumer or publish permission under it, and each
gets its own NATS account as well as its own root. This is not tidiness: two streams in one
account may not have overlapping subject filters, and the server refuses the second with
`subjects overlap with an existing stream (10065)`. A bus that widens into `pf.>` does not
degrade the platform bus, it makes a platform stream **uncreatable**. `task contracts:check`
now rejects an overlapping stream set for exactly this reason.

**Stream sizing is operator-supplied.** `replicas` is the literal `<replicas>` placeholder on
every stream, with defaults per surface (homelab `1`, commercial `3`, which needs a 3-peer
JetStream meta-group). A hard-coded `replicas: 3` means a stranger forking this repo onto a
single-node box cannot create *any* stream — `replicas > 1 not supported in non-clustered
mode (10074)` — so the gate rejects it.

## 3. Delivery-guarantee honesty

**No path on this platform is exactly-once end to end, and nothing in the documentation may
imply otherwise.** JetStream's `duplicate_window` de-duplicates *publishes* on `Nats-Msg-Id`
(the SDK sets it to the CloudEvents `id`). It does not make delivery exactly-once, because a
consumer can always crash between handling a message and acking it.

It does not even make *publishing* once, except inside the window. This is a rule on
producers, not a property of the stream:

> **A publisher MUST cap its total publish-retry duration below `duplicate_window` (2m)**, or
> treat the publish as plainly at-least-once. A real publisher riding out a NATS outage has a
> retry budget longer than two minutes, and at 2m+1s the same `Nats-Msg-Id` persists a genuine
> duplicate. Relying on consumer idempotency instead is a perfectly good answer — it is what
> consumers already do — but it has to be the stated answer.

**`ordering: per_subject` is a property of the stream, not of delivery.** A consumer with
`max_deliver > 1` observes reordering after any failure: a message that fails and waits out
`ack_wait` is redelivered *after* later messages on the same subject were handled and acked.
`max_ack_pending` (256 by default) puts that many messages in flight at once, which removes
delivery order entirely. Ordered handling requires `max_ack_pending: 1` **and** serial
processing, and it costs throughput — take it deliberately. Otherwise use `sequence` to
*detect* reordering rather than assuming its absence. A handler written on the assumption that
`per_subject` meant per-subject *delivery* has a bug the contract used to endorse.

The consequence is a hard rule on every consumer:

> **Consumers are idempotent on `(source, id)`.** That pair is the de-duplication key. A
> handler that is not safe to run twice is not merged.

This is not a burden bolted onto the event system — it is the same property the operator model
already requires (see [operator-model.md](operator-model.md) §3), which is why the two fit
together. An operator that converges from any state does not care that it saw an event twice.

The fourth path in `contracts/events/subjects.v1.yaml` is the important one: **operator
reconcile is not an event path at all.** Events are a notification that a reconcile should
happen sooner. Losing every event on the bus must cost latency, never correctness, because the
periodic resync still converges. Any design that would break if an event were dropped is
rejected at review.

## 4. Versioning and compatibility

Within a major version, change is **additive only**:

- new event types — additive
- new **optional** fields in `data` — additive, subject to the consumer obligation below
- new subjects under an existing stream filter — additive
- a new domain in `subjects.v1.yaml` — additive
- a new stream, or a *widened* filter on an existing one — additive
- a **relaxed** `minLength`/`maxLength` on an envelope attribute or a payload property — additive.
  Every value that validated before still validates. The gate passes it deliberately: a gate that
  blocked a widening would teach people to regenerate the baseline past red

**A new optional `data` field is additive only because consumers are required to tolerate it.**
Every schema in `contracts/events/data/` is `additionalProperties: false`, which is correct for a
producer validating what it emits and wrong for a consumer validating what it receives: a consumer
that validates an incoming payload against the copy it shipped against would *reject* every event
carrying a field added after that copy. So the obligation is normative, not advisory — see §6.
The gate pins each stable type's payload properties, its `required` list, each property's
`minLength`/`maxLength` window (`payload-length-narrowed`, one direction only) and the
`additionalProperties` flag itself, so neither side of this can drift silently. It does **not** yet
pin a payload property's `pattern`, `enum`, `minimum` or `maximum` — narrowing one of those is
still a silent break on this side, and is the next residual to close.

**New envelope attributes are not unilaterally additive.** `envelope.v1.schema.json` is
`additionalProperties: false`, so a producer that ships a new attribute has its events
*rejected* by any consumer still validating against an older copy of the file. Adding one is a
**coordinated rollout** — every validator updated first, producers second. The gate pins the
envelope attribute by attribute, not just its `required` array: the property set in both
directions (`envelope-attribute-added`, `envelope-attribute-removed`), each attribute's declared
type (`envelope-attribute-retyped`), each attribute's `pattern`, `format` and `const`
(`envelope-pattern-changed`), each attribute's `minLength`/`maxLength` window in the narrowing
direction only (`envelope-length-narrowed`), and the `additionalProperties` flag this whole
paragraph rests on (`envelope-additional-properties-changed`). Pinning `required` alone could not
see any of it: an
attribute added *optionally* is the exact hazard described here and is not required, and deleting
`sequence` outright removed it from `properties` and `required` together, so the diff was
invisible to the gate. Payload schemas were pinned property by property while the one file every
event on the bus validates against was pinned by an eight-element string array — the weaker guard
on the more dangerous file. (ADR-038, D1.)

Everything else needs `…v2` published **alongside** `…v1`, with v1 kept for at least one minor
release of the platform. The breaking set the gate rejects outright:

- removing a `stable` type, or **demoting it to `experimental`**
- moving a type's subject
- changing its interaction pattern
- weakening its delivery guarantee (`at_least_once` → `at_most_once`) or its ordering
- replacing its `dataschema` in place, or **emptying its body with `dataless: true`**
- **reassigning its `producer`** — that is a trust boundary, see §5
- **repointing a `wq` type's `completion`**, which requesters are waiting on
- adding *or removing* an attribute from a type's `requires`. `requires` is equally a promise
  **to consumers** that the attribute is always present, which is why they do not null-check it
- adding or removing a required **envelope** attribute
- adding or removing a required **payload** property, removing a payload property outright, or
  changing a payload property's declared type. `dataschema` files are boundary contracts: pinning
  the *path* while leaving the contents unpinned is the same defect as a gate that is green on a
  stream the broker refuses
- **narrowing a `minLength`/`maxLength` window** on an envelope attribute or a payload property —
  raising `minLength`, lowering `maxLength`, or introducing either where the schema declared none
  (no bound is *unbounded*, so adding one rejects values that validated a moment ago).
  `source.maxLength` 253 → 64 rejects every fully-qualified service URI longer than 64 characters,
  and the comparator was blind to it while its own doc comment claimed to pin "every constraint that
  can reject a value which used to validate". Relaxing a window is additive — see the list above
- **closing a payload schema to additions** (`additionalProperties` `true` → `false`) on a stable
  type, which withdraws the additive path above from every consumer validating against it
- deleting or breaking a payload schema a stable type points at, which silently un-pins every
  property it was guarding
- **narrowing a stream's subject filter, or a sourced stream's source filter** — the events
  stop being captured, and `no-stream` only fires when *nothing* matches
- **shortening a stream's `max_age`**, or changing its `retention` or `discard` policy
- **changing the subject grammar**, including `grammar.tokens`

Most of these are only checkable because the baseline pins more than the type list. It pins the
subject grammar (otherwise the gate compiles the grammar from the file under test and validates
it happily against itself), the envelope's `required` array, the whole stream set, and each stable
type's payload properties. Payload pinning is top-level only, so the baseline diff stays readable
by eye; a nested break surfaces as a type change on the property that contains it. For the same
reason the payload projection keeps `properties` a flat name → type map and records length windows
in a sibling `lengths` map, present only for the properties that declare one; on the envelope side,
where each attribute is already an object, `minLength`/`maxLength` sit on the attribute itself. In
both places a *missing* pin is adopted by the next `baseline --write` rather than failing the build,
which is what lets an older baseline take a new pin in one reviewable diff.

`bun scripts/contract-check.ts baseline --write` regenerates the baseline after a genuinely
additive change. It is not a bypass to be hidden in: it produces a visible diff in the pull
request, and that diff is what review is for.

Strengthening a guarantee is always allowed: a consumer written for at-most-once already
tolerates loss, and being idempotent it tolerates repeats.

`status: experimental` types are exempt from the gate and **must not be consumed across a
trust boundary**. Experimental is how you iterate inside one component, not how you skip the
contract.

## 5. Trust boundaries

Two boundaries cross this bus, and data crossing either is validated and authorized:

1. **Tenant.** `tenant` is enforced at the NATS account and subject-permission level — a
   subscriber is never *delivered* an event it is not authorized for. Consumer-side filtering
   is not authorization; it is a filter that a bug removes.
2. **Producer.** One registered type has exactly one owning producer (`producer` in the
   registry). Publish permission is granted per subject prefix to that component's NATS
   credential. A component that can publish another's events can forge them.

Homelab runs a single tenant with the reserved value `local` and the same enforcement wiring,
so the multi-tenant path is exercised by the homelab install rather than existing only in
enterprise. That is the point of a shared contract: the seam is used on both surfaces, not
just declared for one.

## 6. Consumer obligations

- Durable pull consumer. Ephemeral consumers are for human debugging only — a service using
  one has no replay story after a restart.
- `ack_policy: explicit`, `max_deliver: 5`, `ack_wait: 30s`, `max_ack_pending: 256` (see §3
  before assuming that last one is free).
- **Ignore unknown `data` properties.** A consumer MUST NOT reject an event because its payload
  carries a property the consumer's copy of the schema does not know about. In practice: validate
  incoming payloads with `additionalProperties` relaxed, or strip unknowns before validating —
  never by asserting the vendored schema verbatim. The published schemas are
  `additionalProperties: false` so a *producer* cannot emit an unregistered field by accident;
  reusing that same strictness on the receiving side turns §4's additive path into a breaking one
  and is the single easiest way for one consumer to make every producer undeployable.
- **`.ev` consumers** are named `<component>-<domain>-v<major>`.
- **`PF_WORK` consumers bind exactly one fully-specified subject, never a wildcard**, and are
  named `<component>-<entity>-<action>-v<major>`. On a work-queue stream consumer filters must
  be unique and non-overlapping — the server rejects the second with `filtered consumer not
  unique on workqueue stream (10100)` — and `PF_WORK` spans every domain, so the first
  component to create a domain-wide `wq` consumer would permanently foreclose every other
  component in that domain, and you would find out in whichever environment the second
  component deployed to. The domain-scoped naming rule above is for `.ev` only.
- **That rule assumes one NATS account, and therefore one `PF_WORK`, per tenant.** A
  fully-specified subject names a concrete `<tenant>` token while the consumer name grammar has
  none, so the two are consistent only when the tenant is constant within the account. Stated
  normatively because the single-account reading fails silently: **a durable consumer create with
  an existing name is an *update*, not a conflict.** Two tenants' `platform-api` deployments both
  create `platform-api-deployment-promote-v1`, and the second silently repoints the first's
  filter — no error, no `10100`, which only fires on an overlapping filter under a *different*
  name. The first tenant's queued `wq` work then has no consumer; a work queue retains rather
  than drops it, so nothing alerts, and 24h later `max_age` deletes it down the no-advisory path
  in `PF_WORK`'s `silent_loss`. Onboarding a second tenant would silently destroy the first
  tenant's durable requests a day later, by routine deployment rather than misconfiguration.
- **Republish to the `dl` subject on final failure.** On the delivery where `max_deliver`
  exhausts, or on an error the handler knows is not retryable, the consumer republishes the
  **full original envelope** to the `dl` subject derived from the message's own subject (same
  seven tokens, `wq` → `dl`) preserving the original `id`, `source` and `correlationid`, and
  *then* calls `Term()`. The consumer does this itself because only the consumer holds the body.
  A component with no `dl` path has no failure path and fails the boundary quality gate.
  JetStream's `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>` advisory is a useful counter and
  alert source but it is **not** the dead-letter path: it carries no payload, no subject and no
  `correlationid`, so an operator holding one cannot tell what the work was without stream-admin
  rights the failing component does not have — and it only fires on the next fetch attempt after
  exhaustion, so a consumer that crashes at exhaustion emits nothing at all.
- **Never consume a `.ev` subject through core NATS.** An Argo Events `nats` EventSource is a
  core-NATS subscribe — at-most-once, no durability, no replay — and pointing one at a `.ev`
  subject silently downgrades an at-least-once path to at-most-once, with nothing in its own
  documentation to warn you. The bridge to the Argo Events bus is an explicit component with a
  named durable consumer, never an event source pointed at `pf.>`.
- Filter by subject, never by decoding the body and discarding. Body-level filtering hides the
  real coupling and defeats the wildcard guarantees above.
- **Be idempotent on `(source, id)`.** Every path above is at-least-once.

### A durable request has no reply

`rq` is answered on the requester's `_INBOX.…`. `wq` is not: an inbox does not survive the wait
that made the request durable in the first place. So every `wq` type **names a `completion`
type** in the registry — a registered `.ev` event carrying the same `correlationid` — and that
is how the requester learns the work finished. The gate rejects a `wq` type without one, a
completion that is not an `.ev` type, and a completion that does not require `correlationid`.
This reuses the pub/sub path and its durability instead of inventing a fourth delivery path.

## 7. Blast radius

The bus being down stops event-driven *acceleration*: golden-path triggers do not fire,
dashboards go stale, Argo Events sensors idle. It does not stop reconciliation and it does not
break serving workloads, because of the rule in §3. Losing JetStream file storage loses at
most `max_age` of history (7 days on `PF_EVENTS`, 365 on `PF_AUDIT`, 30 on `PF_DLQ`) — which is
why anything that must survive that loss lives in Postgres or in a CRD's `status`, never only
in a stream.

**`PF_WORK` is the exception, and it is named here rather than left to be discovered.** Age
expiry on a work-queue stream is a **silent data-loss path**: `max_age` deletes unacked
messages with no per-message signal of any kind. There is no advisory for age-based deletion,
and the max-deliveries advisory does not fire because nothing was ever redelivered. A consumer
outage longer than `max_age` destroys every queued request without a trace. Two things contain
it, and neither is optional:

1. `max_age` on `PF_WORK` is **24h** — deliberately longer than the worst consumer outage the
   platform intends to survive, which a one-hour setting was not. Shortening it is a breaking
   change the gate rejects.
2. The loss is covered by a **stream-level** monitor, not a consumer advisory: alert when
   `PF_WORK`'s oldest unacked message approaches `max_age`, from the stream's `state.first_ts`
   (`$JS.API.STREAM.INFO.PF_WORK`, exported by prometheus-nats-exporter). The exact metric name
   is pinned by the SRE & Observability Engineer against the deployed exporter; the requirement
   that the alert exists is contract, and a `PF_WORK` consumer without one fails the boundary
   quality gate.

Poison messages are contained separately, by the `dl` republish rule in §6 — without it a
failed message sits in the work queue undeliverable and unclaimable (no second consumer can
take its subject, see the `10100` rule) until `max_age` deletes it, at which point the silent
path above applies.
