# The event contract: CloudEvents over NATS

Normative. Decision record: ADR-026 in [`docs/project_notes/decisions.md`](../project_notes/decisions.md).
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
| `tenant` and `sequence` required extensions | `tenant` is the trust boundary; `sequence` is the only honest ordering token. |

The major version lives in **both** the `type` and the subject, and `task contracts:check`
fails if they disagree. Redundancy is deliberate: a reader who has only one of them can still
tell which contract they are looking at.

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
| `ev` | Pub/sub via `PF_EVENTS` (and `PF_AUDIT` for identity/control) | **at-least-once** | per subject |
| `wq` | Durable request via the `PF_WORK` work-queue stream | **at-least-once** | none |
| `rq` / `rs` | Synchronous request/reply on core NATS, never persisted | **at-most-once** | none |

## 3. Delivery-guarantee honesty

**No path on this platform is exactly-once end to end, and nothing in the documentation may
imply otherwise.** JetStream's `duplicate_window` de-duplicates *publishes* on `Nats-Msg-Id`
(the SDK sets it to the CloudEvents `id`), which makes a 2-minute publish retry burst
effectively-once. It does not make delivery exactly-once, because a consumer can always crash
between handling a message and acking it.

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
- new optional envelope attributes — additive
- new optional fields in `data` — additive
- new subjects under an existing stream filter — additive
- a new domain in `subjects.v1.yaml` — additive

Everything else needs `…v2` published **alongside** `…v1`, with v1 kept for at least one minor
release of the platform. The breaking set the gate rejects outright:

- removing a `stable` type
- moving a type's subject
- changing its interaction pattern
- weakening its delivery guarantee (`at_least_once` → `at_most_once`) or its ordering
- replacing its `dataschema` in place
- adding a newly *required* envelope attribute

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

- Durable pull consumer, named `<component>-<domain>-v<major>`. Ephemeral consumers are for
  human debugging only — a service using one has no replay story after a restart.
- `ack_policy: explicit`, `max_deliver: 5`, `ack_wait: 30s`.
- **Subscribe to the max-deliveries advisory.** After `max_deliver`, JetStream emits on
  `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>`. A component with no subscriber there has no
  failure path and fails the boundary quality gate.
- Filter by subject, never by decoding the body and discarding. Body-level filtering hides the
  real coupling and defeats the wildcard guarantees above.

## 7. Blast radius

The bus being down stops event-driven *acceleration*: golden-path triggers do not fire,
dashboards go stale, Argo Events sensors idle. It does not stop reconciliation and it does not
break serving workloads, because of the rule in §3. Losing JetStream file storage loses at
most `max_age` of history (7 days on `PF_EVENTS`, 365 on `PF_AUDIT`) — which is why anything
that must survive that loss lives in Postgres or in a CRD's `status`, never only in a stream.
