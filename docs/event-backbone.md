# The event backbone: NATS and JetStream

How the platform bus is deployed and operated. The **contract** it implements —
subjects, schemas, delivery guarantees — is normative elsewhere and is not re-decided
here:

| What | Where |
|---|---|
| Subject grammar, stream set, guarantees | [`contracts/events/subjects.v1.yaml`](../contracts/events/subjects.v1.yaml) |
| Registered event types | [`contracts/events/registry.v1.yaml`](../contracts/events/registry.v1.yaml) |
| Reasoning | [`docs/contracts/event-contract.md`](contracts/event-contract.md) |
| Decisions | ADR-026, revised by ADR-038 |

> **This bus is unauthenticated and single-tenant. Read this before you attach anything
> to it.**
>
> There is no NATS account, no user, no credential and no subject permission in this
> deployment. `config.authorization` is unset, so every client connects anonymously: any
> pod that can reach `nats.nats.svc.cluster.local:4222` has full access to the bus.
>
> That makes the `<tenant>` token in every subject on this page a **naming convention, not
> a boundary**. Anyone can publish under any tenant, bind any consumer and read any
> stream. The contract calls tenant isolation "enforced at the NATS account and
> subject-permission level" (ADR-026 D5, `event-contract.md` section 5); on this deployment it is
> not enforced at all. **Do not attach a second tenant to this bus.**
>
> `$JS.API` is open for the same reason, so a client can create, update, delete or purge
> any stream. The stream set being GitOps state is therefore a convention the operators
> keep, not a control the server imposes.
>
> This is a deliberate posture for a single-tenant, ClusterIP-only homelab, not an
> oversight. How enforcement lands is decided in ADR-043 and tracked on MCAA-363. A fork
> that puts a second tenant, an untrusted workload or a shared cluster on this bus needs
> that work first.

This page covers the deployment: what runs, how the streams get created, what the
dead-letter path actually does, and how to follow one event end to end.

## What is deployed

Three ArgoCD Applications, in wave order:

| Wave | Application | Chart | What it is |
|---|---|---|---|
| 10 | `nats` | `nats` | The NATS servers, JetStream file store, and the Prometheus exporter sidecar |
| 11 | `nack` | `nack` | The JetStream controller; ships the `jetstream.nats.io` CRDs |
| 12 | `nats-config` | `charts/nats-config` | The stream set and its consumers, as `Stream`/`Consumer` resources |

The streams are **GitOps state, not an imperative `nats stream add`**. That is the whole
reason NACK is in the path: a stream's retention and replica count are reviewable in a
diff, and a drifted stream is a sync status rather than a discovery during an incident.

```
                    producers (CloudEvents, structured JSON)
                                  │
                      publish  pf.<tenant>.<domain>.<entity>.<action>.<v>.<suffix>
                                  │
          ┌───────────────────────┼────────────────────────┬─────────────────┐
          │ .ev                   │ .wq                    │ .rq             │ .dl
          ▼                       ▼                        ▼                 ▼
     ┌──────────┐            ┌──────────┐            (core NATS,        ┌──────────┐
     │PF_EVENTS │            │ PF_WORK  │             no stream,        │  PF_DLQ  │
     │  7d      │            │ 24h      │             at-most-once)     │  30d     │
     │ limits   │            │workqueue │                  │            │ limits   │
     └────┬─────┘            └────┬─────┘             reply to          └────┬─────┘
          │                       │                   _INBOX.…              │
   sources│ (identity, control)   │                                         │
          ▼                       │                                         │
     ┌──────────┐                 │                                         │
     │ PF_AUDIT │                 │                                         │
     │  365d    │                 │                                         │
     └────┬─────┘                 │                                         │
          │                       │                                         │
          ▼                       ▼                                         ▼
   durable pull consumers   one consumer group          dlq-reporter-observability-v1
   <component>-<domain>-v<major>   per subject
                                   │
                                   │ max_deliver exhausted, or a non-retryable error
                                   └──> consumer republishes the FULL envelope to the
                                        `.dl` subject, THEN Term()s the original
```

`PF_AUDIT` **sources from `PF_EVENTS` and ingests nothing directly.** Two streams in one
NATS account may not have overlapping subject filters — a real server refuses the second
with `subjects overlap with an existing stream (10065)` — so the audit retention policy is
applied by sourcing rather than by a second set of filters. One publish still produces one
PubAck and therefore one unambiguous envelope `sequence`.

Its two filters — the identity and control subsets — go in `subjectTransforms` on a
**single** source, not in one source each. `prometheus-nats-exporter` 0.20.1 labels
`nats_stream_source_*` by `source_name` alone, so a second source from the same origin
stream emits two series with an identical label set, and Prometheus's registry then fails
the whole scrape with `collected before with the same name and label values` — a 500 that
removes **every** `nats_*` series, not just the source ones. `nats-server` accepts either
shape, so nothing but the scrape tells you. `a stream sources each origin stream exactly
once` in `scripts/nats-streams-contract_test.ts` is the level 0 guard; the
`exporter-label-set` step in `tests/e2e/nats/chainsaw-test.yaml` is the level 2 one.

## Two buses, and the boundary between them

Argo Events runs its **own** JetStream, in its own namespace, on its own storage:

| Wave | Application | Chart | What it is |
|---|---|---|---|
| 12 | `argo-events` | `argo-events` | The controller, the admission webhook, and the `argoproj.io` EventBus/EventSource/Sensor CRDs |
| 13 | `argo-events-config` | `charts/argo-events-config` | The `EventBus` named `default`, which is the bus those CRDs describe |

That is a deliberate separation, not duplicated infrastructure. The platform bus is the
durable record: 168h of `.ev`, a year of `PF_AUDIT`, replayable from sequence one. The
Argo Events bus is trigger plumbing with 72h of history, and a Sensor that falls behind
and catches up is doing its job. Putting triggers on the platform bus would let a Sensor's
consumer state and a workflow's retries move stream state that an audit reader depends on.

**Nothing bridges the two implicitly.** `no_core_nats_bridge` in
`contracts/events/subjects.v1.yaml` is specific about the trap: an Argo Events `nats`
EventSource is a **core-NATS subscribe** — at-most-once, no durability, no replay — so
pointing one at a `.ev` subject silently converts an at-least-once path into an
at-most-once one, and neither Argo Events' own documentation nor its status conditions
say so. A component that needs platform events to reach a Sensor binds a **named durable
pull consumer** on the platform bus and publishes onward; that consumer appears in
`charts/nats-config` like every other one.

Three chart defaults are wrong here and are overridden in
`configuration/templates/helm-addons.tmpl` rather than left to the operator:

- `configs.jetstream.streamConfig.replicas` defaults to **3**. Argo Events reuses the bus
  pod count as its stream replica count, so on a one-pod bus the streams it creates never
  become ready. `ARGO_EVENTS_BUS_REPLICAS` sets both, and Argo Events accepts only 1, 3
  or 5 — `charts/argo-events-config/templates/eventbus.yaml` fails the render on anything
  else rather than deploying a bus that cannot form.
- The bus `version` is pinned to a concrete NATS version, held in
  `configuration/versions.yaml` as `images.argo-events-bus-nats`. The controller-config
  maps a version string to an image and also accepts `latest`, which is a floating tag.
  That key carries no Renovate annotation on purpose: it is not a free image tag but a key
  the chart must already declare in `configs.jetstream.versions`, so it moves with the
  argo-events chart. Because the CRD preserves unknown fields, a version the chart does not
  declare renders clean, passes level 0, and fails at reconcile.
- `streamConfig.maxBytes` defaults to **`1GB`** — and that default is inert. Argo Events
  reads the value with viper's `GetInt64`
  (`pkg/eventbus/jetstream/base/jetstream.go`), which returns **0** for a suffixed string,
  and `0` means unlimited in JetStream. So the upstream default leaves the trigger bus
  bounded only by `maxMsgs` and `maxAge`, free to fill its PVC and then refuse every
  publish. Both size bounds are now supplied as plain integers, and
  `charts/argo-events-config/templates/_helpers.tpl` refuses to render a `maxBytes` above
  `maxBytesBudgetFraction` (0.75) of the PVC — the same rule ADR-042 applies to the
  platform bus. Argo Events creates exactly one stream, `default` with subjects
  `default.*.*`, so that ceiling is the whole message budget and there is no sum over
  streams to check.

One thing no gate in this repo can see: that stream is created by the **first EventSource
or Sensor to connect**, not by the controller, and through `AddStream` rather than an
update. Until a Sensor exists the bus carries no stream at all, so the limits above are a
declared intent that nothing has yet observed on a server.

One thing the level 0 gates cannot do here: all three `argoproj.io` CRDs declare `spec`
and `status` as `x-kubernetes-preserve-unknown-fields`, so the API server accepts any
spec and the vendored kubeconform schemas can only confirm the kind is known. The
admission webhook is the only thing that rejects a malformed Sensor before it fails at
runtime, and the chart ships it **disabled**; this repo enables it.

## Delivery and ordering guarantees

Stated every time, because the alternative is each reader assuming whichever guarantee
suits them. **No path here is exactly-once end to end.**

| Path | Delivery | Ordering | De-duplication |
|---|---|---|---|
| `.ev` via `PF_EVENTS` (mirrored to `PF_AUDIT`) | **at-least-once** | per subject *on the stream*, not on delivery | consumer-side on `(source, id)` |
| `.wq` via `PF_WORK` | **at-least-once** | none | consumer-side on `(source, id)` |
| `.dl` via `PF_DLQ` | **at-least-once** | per subject | consumer-side on the **original** `(source, id)` |
| `.rq` on core NATS | **at-most-once** | none | none at the transport; the responder must be idempotent |
| Argo Events trigger bus (`default`) | **at-least-once, and lossy under either bound** | per subject on the stream | none; a Sensor must tolerate redelivery |

That last row is the weakest guarantee on either bus, and it is stated here rather than
left to Argo Events' documentation because it is the one a reader is most likely to assume
is stronger. The bus runs `retention: limits` with `discard: old`, so on reaching `maxAge`
(72h) or `maxBytes` it drops the **oldest** trigger, with no DLQ and no advisory naming
what was dropped. A Sensor down longer than 72h loses what it missed, silently. That is
acceptable for trigger plumbing and would not be acceptable for a platform stream, which is
why the two buses are separate — see [Two buses](#two-buses-and-the-boundary-between-them).

Three consequences that bite in practice:

- **`duplicate_window` (2m) de-duplicates publishes, not deliveries.** It makes a retry
  burst *shorter than the window* effectively-once and nothing more. A consumer can still
  crash between handling a message and acking it, so every handler is idempotent on
  `(source, id)` or it is not merged.
- **`ordering: per_subject` is a property of the stream, not of delivery.** A consumer with
  `max_deliver > 1` observes reordering after any failure, and `max_ack_pending: 256`
  removes delivery order entirely. Use the envelope `sequence` to *detect* reordering
  rather than assuming its absence.
- **`discard` is a property of a bounded stream only.** JetStream applies it when a stream
  reaches `max_bytes`, `max_msgs` or `max_msgs_per_subject`; age expiry is a separate path
  that ignores it. `PF_WORK`'s `discard: new` is what turns a full queue into publisher
  backpressure rather than silent loss, and it can only do that because every stream here
  carries a `maxBytes` ceiling (see [sizing](#sizing-and-why-replicas-are-not-in-the-contract)).
  Remove that ceiling and every `discard` policy on the bus becomes decorative, with no
  error at create time and no alert afterwards.

## The dead-letter path

JetStream has no DLQ primitive, and the obvious substitute does not work:
`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>` carries `stream`, `consumer`, `stream_seq`
and `deliveries` — **no body, no subject, no `correlationid`**. An operator holding one
cannot tell what the work was, and the poison message sits in the work queue undeliverable
until `max_age` deletes it.

So the dead-letter path is the consumer's job, not the server's:

1. On the delivery where `max_deliver` exhausts, or on an error the handler knows is not
   retryable, the consumer **republishes the full original envelope** to the `.dl` subject
   derived from the message's own subject (same seven tokens, `wq` -> `dl`), preserving the
   original `id`, `source` and `correlationid`.
2. Only then does it call `Term()` on the original, so one bad payload is contained instead
   of stalling its consumer.
3. `dlq-reporter-observability-v1` is the durable subscriber on `PF_DLQ`, so a dead-lettered
   message is read rather than sitting in an unread stream.

**A component with no `.dl` republish path has no failure path** and fails the boundary
quality gate (ADR-030). The advisory remains useful as a counter and an alert source; it is
not the dead-letter record.

**What is proven, and what step 1 still owes.** `max-deliveries-exhaustion` in
`tests/e2e/nats/chainsaw-test.yaml` drives one envelope through every delivery of
`verify-workload-v1`, shows the next delivery never comes, captures the advisory, and shows a
later envelope still arriving — so exhaustion terminates and one poison payload does not stall
the consumer. The republish in step 1 is **not** proven by a running consumer: `PF_WORK` has no
declared consumer yet, so `dead-letter-record` publishes the `.dl` envelope itself and proves
the subject, the retention and the durable reader. The first `.wq` consumer to ship owns
closing that gap.

### The silent-loss path that has no advisory

`PF_WORK` age expiry deletes unacked messages with **no per-message signal**. A message in
flight when the budget expires emits one `terminated` advisory; a message that was queued
and never delivered emits *nothing at all* — and that second case is the shape of every
consumer outage, because a consumer that is down fetches nothing.

`max_age` is therefore 24h, chosen to exceed the worst consumer outage the platform intends
to survive, and the loss is covered by **stream-level** alerts rather than a consumer
advisory: `PFWorkOldestUnackedAging`, `PFWorkMessagesExpiredUnacked` and
`PFWorkStreamMetricsAbsent`, in the `homelab-nats-jetstream` rule group. Runbook:
[`docs/runbooks/pf-work-age-expiry.md`](runbooks/pf-work-age-expiry.md).

Those alerts have **no data at all** unless the exporter is on, which is why the nats
Application sets all three of these and none of them are chart defaults:

| Value | Chart default | Why it is set |
|---|---|---|
| `promExporter.enabled` | `false` | Without it there is no `nats_stream_*` series and the age budget runs unwatched |
| `config.jetstream.enabled` | `false` | Gates the exporter's `-jsz=all` argument, which is what produces stream and consumer metrics |
| `promExporter.podMonitor.enabled` | `false` | Without it nothing scrapes the exporter |

The PodMonitor's scrape interval is pinned to **30s** rather than inherited, because the
`PF_WORK` aging rules gate on `min_over_time(nats_stream_total_messages{...}[5m])`. A window with
no sample in it yields nothing, the surrounding `and` chain drops, and the alert silently never
fires — so a fork whose global interval approaches 5m loses the alert without any signal that it
has. The rules' `count_over_time(...[12h]) >= 11 * count_over_time(...[1h])` guard is a ratio and
is invariant in the scrape rate; it is not what the pin protects.

## Sizing, and why replicas are not in the contract

Stream sizing is **operator-supplied**:

| Key | Default | Meaning |
|---|---|---|
| `NATS_SERVER_REPLICAS` | `3` | NATS server pods. `1` runs JetStream non-clustered |
| `NATS_STREAM_REPLICAS` | `1` | JetStream replicas per stream |

`NATS_STREAM_REPLICAS` defaults to `1` and the contract keeps the value a placeholder on
purpose. A hard-coded `3` means a stranger forking this repository onto a single-node Talos
box cannot create **any** stream — the server refuses with `replicas > 1 not supported in
non-clustered mode (10074)`. That is the fork-ability contract failing at stream one.
`NATS_SERVER_REPLICAS` must be at least `NATS_STREAM_REPLICAS`.

`maxBytes` is the second operator-supplied number and is **required on every stream**.
JetStream applies `discard` only when a stream reaches `max_bytes`, `max_msgs` or
`max_msgs_per_subject`; age expiry is a separate path that ignores it. An unlimited stream
therefore never fills, its `discard` policy never runs, and the only thing it can exhaust is
the shared file store — which refuses writes for **every** stream on the peer with
`insufficient resources (10023)`. One stream's retention budget becomes a bus-wide outage.
The per-surface numbers live in `charts/nats-config/values-<surface>.yaml`:

| Stream | Share | homelab | localdev |
|---|---|---|---|
| `PF_EVENTS` | 33.3% | 2 GiB | 384 MiB |
| `PF_AUDIT` | 50% | 3 GiB | 576 MiB |
| `PF_WORK` | 4.2% | 256 MiB | 48 MiB |
| `PF_DLQ` | 12.5% | 768 MiB | 144 MiB |
| total | | 6 GiB of a 20 GiB store | 1.125 GiB of a 2 GiB store |

Both surfaces hold the same split; only the store differs.

The four limits must **sum strictly below the file store**, with headroom. `maxBytes` bounds
a stream against itself; it does not reserve or partition the store, so four limits summing
above it are individually bounded and collectively unbounded and the peer hits 10023 before
any stream hits its own ceiling. Headroom is required because JetStream accounts for index
and metadata alongside message bytes. `charts/nats-config` refuses to render a values file
that breaks the rule — `maxBytesBudgetFraction` (0.75) is the ceiling — and the parent
Application injects the environment's real `fileStoreSize`, so the same assertion runs
against the actual store at sync time rather than against a committed guess. Raising one
stream means lowering another or growing the store (ADR-042).

JetStream's file store takes the **iSCSI SSD** class, never an NFS one: it is a write-ahead
log and needs real fsync semantics.

## Authentication: accounts, principals and credentials

The bus is anonymous until an operator supplies a key, and authenticated from the first one.
`NATS_PRINCIPAL_NKEYS` carries comma-separated `<principal>=<public nkey>` pairs; one pair
renders the server's `accounts {}` block, and a client with no key is then refused at connect
time. There is no `no_auth_user`, so there is no account an unauthenticated connection lands
in. Set it only once every principal a workload runs as is listed -- this is the change that
flips the bus, and a rendered account block without the matching credentials refuses every
client, NACK included.

```text
contracts/events/bus-principals.v1.yaml   the declaration: grants per principal, no keys
              |  bun scripts/render-nats-accounts.ts
              v
charts/addons/files/nats-accounts.gen.yaml   the expansion, committed, <tenant> intact
              |  charts/addons/templates/_nats-accounts.tpl  + NATS_PRINCIPAL_NKEYS
              v
config.merge.accounts  ->  nats.conf  ->  TENANT_LOCAL { jetstream {...} users [...] }
                                          $SYS        { users [] }
```

Permissions are contract and identity is operator-supplied. The declaration holds no key, no
real account name and no tenant token other than `<tenant>`; the public keys come from
configuration and the private seeds reach workloads as Secrets through External Secrets. A
tenant's permission set is generated, never hand-written per customer, which is why the
committed expansion is pinned to its source by `task test:scripts`.

`$SYS` is declared with an empty user list. No platform component holds the system account --
NACK included, which the `nack` chart's `nats-sys-creds` default invites. NACK connects as the
`nack` principal through an `Account` resource using `spec.nkey`, and every `Stream` and
`Consumer` names that account through `spec.account`.

**Measured**, against the `nats.conf` this chart renders, on nats-server v2.15.0:

```text
anonymous connect                     -ERR 'Authorization Violation'
verify, with its nkey                 connected
platform-api -> its own .wq subject   accepted
platform-api -> identity-broker's .ev -ERR 'Permissions Violation for Publish'
verify       -> _INBOX.platform-api.x -ERR 'Permissions Violation for Publish'
verify       -> $JS.API.STREAM.DELETE -ERR 'Permissions Violation for Publish'
nack         -> $JS.API.STREAM.CREATE accepted
nack         -> $JS.API.ACCOUNT.PURGE -ERR 'Permissions Violation for Publish'
platform-api -> pf.other....wq        -ERR 'Permissions Violation for Publish'
```

Two failure modes are worth knowing because neither is visible in the values and neither is
caught by `nats-server -t`:

- `system_account` naming an account the config does not declare exits with `error resolving
  system account: account missing`, so the pod crash-loops on sync rather than failing to
  render. `$SYS` is therefore always declared.
- An account limit above the server's matching store refuses JetStream for *every* account:
  `max_memory` above `max_memory_store` gives `insufficient memory resources (10028)` and
  `max_store` above `max_file_store` gives `insufficient storage resources (10047)`. This
  chart enables only the file store, so `max_memory` is 0 and a non-zero value is refused at
  render rather than at startup.

Rotation is a Secret update plus a config reload: the server holds only public keys. The
drill that proves an old session is actually cut, and the `$SYS` recovery path that works
while the identity service is down, are level-2 conformance (`rotation_and_revocation_drill`
in the declaration) and are not claimed here.

## Operating notes

- **Never purge a stream, delete a consumer group, or reset a namespace.** Every `Stream`
  and `Consumer` sets `preventDelete: true`, so deleting the resource leaves the stream and
  its messages in NATS. Prefer a new consumer or a new stream over a destructive reset.
- **At three or more servers, every pod exports the same stream** and a non-leader reports
  its local replica state. Queries must filter `is_stream_leader="true"` /
  `is_consumer_leader="true"`, which the shipped rules do.
- **`pf.>` is reserved for the platform bus.** No third-party bus — Argo Events, Temporal,
  anything added later — may place a stream, a consumer or a publish permission under it.
  Two streams in one account may not have overlapping filters, so a third-party bus that
  widens into `pf.>` does not degrade the platform bus, it makes a platform stream
  uncreatable.
- **The monitoring port is open too.** Port 8222 is plain HTTP with no auth on every NATS
  pod, published through the `nats-headless` Service (`service.ports.monitor` is off, so
  the `nats` ClusterIP Service carries 4222 only). `/jsz?accounts=true` returns every
  stream's name, subject filters and message counts, and `/connz` returns per-connection
  detail. Accounts partition the client port, so ADR-043 will not close this; restricting
  it is a separate decision.
- **An Argo Events `nats` EventSource is a core-NATS subscribe** — at-most-once, no
  durability, no replay. Pointing one at a `.ev` subject silently downgrades an
  at-least-once path. The bridge between this bus and the Argo Events bus is an explicit
  component with a named durable consumer.

## Verifying it

Level 0 (static, no cluster) checks that the rendered manifests are valid and that the
chart still matches the contract:

```bash
task verify:text                              # level 0
bun test scripts/nats-streams-contract_test.ts  # chart <-> contract drift gate
```

The drift gate is the one that matters for this page: it fails when a stream's retention,
age, discard policy, dedup window, message-size cap, source origin or source filters stop
matching `contracts/events/subjects.v1.yaml`, when a surface leaves a stream without a
`maxBytes`, and when any stream claims exactly-once delivery. Every comparison reads both
sides — a gate that reads one side's optional fields only is a gate against one direction of
drift, which is how a chart capping a stream the contract leaves uncapped used to pass.

Levels 1 and 2 run on Kind and are what prove the streams are actually creatable, that the
sourced `PF_AUDIT` is accepted by a real server, and that the dead-letter path fires:

```bash
task verify:text LEVEL=1
task verify:text LEVEL=2
```

### Following one event end to end

Every hop carries the `correlationid` from the envelope. To follow one event:

```bash
# 1. Stream state, and the head sequence the age alerts watch
kubectl --context kind-homelab-localdev -n nats exec deploy/nats-box -- \
  nats --context verify stream info PF_EVENTS

# 2. Watch a subject live, including the tenant token
kubectl --context kind-homelab-localdev -n nats exec deploy/nats-box -- \
  nats --context verify sub 'pf.local.workload.>'

# 3. What a durable consumer has and has not acked
kubectl --context kind-homelab-localdev -n nats exec deploy/nats-box -- \
  nats --context verify consumer info PF_EVENTS verify-workload-v1

# 4. The dead-letter record, by correlation id
kubectl --context kind-homelab-localdev -n nats exec deploy/nats-box -- \
  nats --context dlq-reporter stream view PF_DLQ
```

Every command names a context, and each context carries one principal's credential. That is
not decoration. `verify` reads `PF_EVENTS` and holds no grant on `PF_DLQ`, so command 4 names
`dlq-reporter` instead -- and command 2 shows only what `verify` is allowed to see. Running
these as one super-user would make the runbook prove less than the system enforces.

`nats` without `--context` is the shape that stops working once the accounts block renders:
the connection is refused with `Authorization Violation` before any subject permission is
consulted. `nats context ls` inside the box lists what the operator has.

Production is read-only for agents: never apply, patch or sync against the homelab cluster.
