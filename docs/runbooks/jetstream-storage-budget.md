# JetStream storage budget: the file store, the four `max_bytes`, and the sum rule

Every platform stream carries an operator-supplied `max_bytes`
(`contracts/events/subjects.v1.yaml`, ADR-042). `max_bytes` bounds a stream **against itself**. It
does not reserve or partition the JetStream file store, so the contract also states a **sum rule**:

> The four streams' `max_bytes` must total strictly less than the JetStream file store, with
> headroom.

Four streams whose limits sum above the store are individually bounded and collectively unbounded.
The peer then reaches `insufficient resources` (error `10047`) before any stream reaches its own
limit, and **that refusal applies to every stream on the peer**, not to the one that grew. One
stream's retention budget becomes a bus-wide outage, which is the opposite of what `PF_AUDIT`'s
`discard: new` is chosen to buy.

The sum rule is arithmetic an operator applies at sizing time. It cannot be a static check: the
file store size is a cluster fact (`nats.jetstream.storage.size` in `charts/addons`, which the NATS
chart writes as `max_file_store`), not a value in the contract. **These alerts are the runtime half
of the rule.** Without them the first symptom of a mis-summed budget is `10047` on every publish.

75 % is the warning threshold because it is where the contract's own headroom sits: the homelab
`max_bytes_defaults` budget 6 GiB across the four streams against the 8 GiB store their comment
names, and the commercial ones 96 GiB against 128 GiB. On a cluster sized that way the store
reaching 75 % means the *entire declared budget* is spent, and anything beyond it is a stream over
its share, a budget that sums too high, or bytes no `max_bytes` accounts for.

**Check that assumption against your own cluster rather than inheriting it.** The ratio that matters
is the deployed limits against the deployed store, and the query in step 2 below prints it. A store
larger than the defaults assume — `nats.jetstream.storage.size` currently defaults to `10Gi`, not
the 8 GiB the contract comment describes — puts the whole budget below 75 %, so the warning then
means "something is consuming past the budget" rather than "the budget is spent". Both readings are
actionable and the diagnosis below covers both; the threshold does not need retuning per cluster.

## What the exporter gives you

`prometheus-nats-exporter` runs as the `promExporter` sidecar of the NATS chart with `-jsz=all`
`-prefix=nats`. The nats chart pins it at **0.20.1** (chart 2.15.0); the names below were read from
`collector/jsz.go` at both 0.20.1 and 0.18.0, which are identical in the storage surface.

| Metric | Source field | Meaning |
|---|---|---|
| `nats_server_max_storage` | `JSInfo.Config.MaxStore` | the store ceiling this peer enforces |
| `nats_account_storage_used` | `AccountDetail.Store` | file bytes this account has on the store |
| `nats_stream_total_bytes` | `StreamState.Bytes` | bytes in one stream |
| `nats_stream_limit_bytes` | `StreamConfig.MaxBytes` | that stream's `max_bytes`; **-1 means unbounded** |
| `nats_stream_last_seq` | `StreamState.LastSeq` | newest sequence, so: whether writes are landing |
| `nats_stream_source_lag` | `StreamSourceInfo.Lag` | messages in the origin stream the sourcing stream has not stored yet |

Two things do **not** exist and the rules cannot use them:

- **`nats_server_jetstream_storage_used_bytes`**, the metric ADR-042 named, is not exported under
  that or any name. This is the same failure ADR-038 recorded when it named `state.first_ts`: the
  requirement was right and the input was invented. Pin names against the deployed exporter.
- **No metric counts a refused write.** A `10047` or a `discard: new` rejection is answered to the
  publisher and never appears in `/jsz`; `JetStreamStats.API.Errors` counts JetStream *API* calls,
  covers neither, and the exporter does not export it anyway. Every refusal signal here is derived;
  for a sourced stream like `PF_AUDIT` the source lag is what makes that derivation possible.

**Why `nats_account_storage_used` and not `nats_server_total_message_bytes`.** Both look like "how
full is the store". Only the first is the number the server compares: `wouldExceedLimits` tests
`js.storeUsed` against `config.MaxStore`, and `js.storeUsed` is the sum of exactly these per-account
totals. `nats_server_total_message_bytes` is the sum of stream *message* bytes and omits the index
and metadata the store also holds — the reason the sum rule demands headroom at all. Using it would
under-report the thing that fills the disk.

**Why no kube-state-metrics fallback.** The NATS chart writes `max_file_store` from
`fileStore.pvc.size` whenever a PVC is enabled (`files/config/jetstream.yaml`), so
`nats_server_max_storage` already *is* the PVC capacity, read from the process that enforces it. A
PVC-derived denominator would be the same number with an extra hop and would miss a
`max_file_store` an operator set by hand.

## The alerts

All five rules are in the `homelab-nats-jetstream` group of
`charts/addons/templates/kube-prometheus-stack.yaml` and route by `severity`
([alerting.md](./alerting.md)). They are silent on a cluster with no NATS: no series, no alert.

| Alert | Severity | Fires when |
|---|---|---|
| `JetStreamFileStoreFillingUp` | warning | the store is above 75 % of `max_file_store` for 15 m |
| `JetStreamFileStoreFillingUp` | critical | above 90 % for 5 m |
| `JetStreamFileStoreMetricsAbsent` | warning | the exporter reported account storage in the last 6 h and no longer does, for 30 m |
| `JetStreamStreamApproachingMaxBytes` | warning / critical | one stream is above 75 % / 90 % of its own `max_bytes` |
| `PFAuditRefusingWrites` | critical | `PF_AUDIT` is at its ceiling, `last_seq` has not moved and its source lag has stayed above zero, for 15 m |

Both `FillingUp` severities share one `alertname`, as do both `ApproachingMaxBytes` severities, so
Alertmanager's severity inhibition drops the warning notification once the critical fires.

At the shipped budgets the four platform streams cannot fill the store on their own: their limits
total 30 % of it on homelab (6 GiB of 20 GiB) and 56 % on localdev (1.125 GiB of 2 GiB). So
`JetStreamStreamApproachingMaxBytes` is what fires first under ordinary growth, and
`JetStreamFileStoreFillingUp` is the backstop for bytes no `max_bytes` accounts for — an unbounded
or non-platform stream, index and metadata overrun, or a `fileStoreSize` that no longer matches the
PVC. A quiet store alert while a stream alert fires is the expected ordering, not a gap.

The file-store rules aggregate **per server**, because the store and the `10047` refusal are
per-peer. `JetStreamFileStoreMetricsAbsent` does not: it aggregates the whole vector away and
answers one question — is anything measuring the store at all. It watches the *numerator*
deliberately. Dropping `-jsz=all` from the sidecar leaves the exporter serving plain `/jsz`, which
has no account block, so `nats_account_storage_used` disappears while `nats_server_max_storage`
keeps arriving and the ratio silently stops existing. A single exporter sidecar of several going
dark is `TargetDown`'s job (the chart's `defaultRules`, which stay on), not this rule's.

## When `JetStreamFileStoreFillingUp` fires

The store is filling. The first question is always **whose bytes** — that decides which of two very
different fixes applies. Substitute the namespace the NATS Application deploys into for `nats`; the
alert carries it as the `namespace` label.

1. **Get the shape of it.** Per-stream share of the store, largest first:

   ```promql
   topk(10, nats_stream_total_bytes{is_stream_leader="true"})
   nats_stream_total_bytes{is_stream_leader="true"} / (nats_stream_limit_bytes{is_stream_leader="true"} > 0)
   ```

2. **Add up the limits and compare them to the store.** This is the sum rule, evaluated against
   what is actually deployed rather than against the contract's defaults:

   ```promql
   sum(nats_stream_limit_bytes{is_stream_leader="true"} > 0) / max(nats_server_max_storage)
   ```

   Above `1` the budget is over-committed and `10047` is arithmetically guaranteed before the last
   stream fills. Above roughly `0.9` the headroom is too thin for index and metadata. The chart
   refuses to render above `maxBytesBudgetFraction` (`0.75`), and the shipped defaults sit well
   under that ceiling — `0.30` on homelab, `0.5625` on localdev. A ratio far below `0.75` is normal
   here; it does not mean the query is wrong or the budget is unset.

3. **Look for bytes no `max_bytes` accounts for** — an unbounded stream, or a stream outside the
   four the contract declares:

   ```promql
   nats_stream_limit_bytes{is_stream_leader="true"} == -1
   ```

   Anything here is invisible to `JetStreamStreamApproachingMaxBytes` by construction and can fill
   the store on its own. An unbounded *platform* stream is a contract violation — `task
   contracts:check` (`discard-without-limit`, `max-bytes-hardcoded`) should have refused it, so
   treat a hit on `PF_*` as a gate escape and file it.

### Telling a mis-summed budget from genuine growth

| What you see | What it is | What to do |
|---|---|---|
| Store over 75 %, **no** stream over 75 % of its own `max_bytes` | the limits sum too high, or headroom is too thin. The store is filling from the collective, exactly as the sum rule predicts | re-budget (below). Raising any single limit makes it worse |
| One stream over 90 % of its `max_bytes` and the store crossing 75 % together | genuine growth in that stream, inside its declared share | its share is undersized for real volume: re-budget, or accept the discard policy acting |
| Store over 75 % while the deployed limits sum well below it | bytes outside the four streams — an unbounded stream, a fork's own stream, or index and metadata overrun | step 3 above; bound whatever is unbounded |
| Store climbing with no stream growing | not the streams. Check the PVC itself for non-JetStream files | `kubectl -n nats exec` the pod and look at the store dir |

### The operator's options, and the one that is not an option

`max_bytes` and the store are one budget. There are exactly three legitimate moves:

1. **Re-budget: raise one `max_bytes` and lower another**, keeping the sum where it was. This is the
   cheapest fix and the only one that needs no new disk. Shrinking a stream's `max_bytes` below its
   current bytes makes its discard policy act immediately — `discard: old` drops the oldest
   messages, `discard: new` refuses publishes — so take the retention the contract declares for that
   stream into account before you choose which one shrinks.
2. **Grow the file store**, then raise limits into the new space. `nats.jetstream.storage.size` is
   set per surface in `configuration/templates/helm-addons.tmpl` (homelab `20Gi`, localdev `2Gi`);
   the `10Gi` in `charts/addons/values.yaml` is the chart's standalone default and editing it does
   not resize a deployed cluster. Growing it grows the PVC and `max_file_store` together, and the
   parent Application injects the new size as the chart's `fileStoreSize`, so the render-time sum
   rule re-checks against the real store. Update the surface's restated `fileStoreSize`
   (`charts/nats-config/values.yaml` for homelab, `values-localdev.yaml` for localdev) in the same
   change, or the drift gate — *each surface budgets against the file store its parent Application
   injects* — fails level 0. The PVC's StorageClass must allow expansion, and this is a chart edit
   through GitOps, not a live `kubectl edit`.
3. **Reduce what is stored** — shorten a retention window, or stop publishing something. `max_age`
   is contract and the gate rejects shortening it (`retention-shortened`), so this is an ADR, not an
   incident action.

**Never raise one `max_bytes` alone.** It is the one change that looks like a fix and re-creates
precisely the failure ADR-042 exists to remove: the limits now sum above the store, so each stream
is bounded, the set is not, and the next refusal is a `10047` on an unrelated stream's publish
rather than a policy decision on the stream you changed. Through GitOps the chart now stops you —
`nats-config.assertMaxBytesBudget` fails the render with the offending total. A live `nats stream
edit` does not render, so no static gate sees it; that path is why these alerts exist, and
`JetStreamFileStoreFillingUp` is the only thing left watching it.

## When `JetStreamStreamApproachingMaxBytes` fires

One stream is approaching its own ceiling; the store may be nearly empty. At the ceiling the
stream's `discard` policy takes effect, and the two differ in who notices:

- **`discard: old`** (`PF_EVENTS`, `PF_DLQ`) deletes the oldest messages to make room. Retention
  silently becomes shorter than the declared `max_age` — a 7 d window that in practice holds 2 d.
  Nothing fails, so nothing reports it; this alert is the only warning.
- **`discard: new`** (`PF_AUDIT`, `PF_WORK`) refuses the publish. `PF_WORK` refusing is intended
  backpressure and the producer sees the error. `PF_AUDIT` refusing is covered separately below.

Confirm against the server, which has the `max_bytes` and the discard policy together:

```bash
kubectl -n nats exec -it deploy/nats-box -- nats stream info PF_AUDIT
# or, without nats-box:
kubectl -n nats port-forward svc/nats 8222 &
curl -s 'localhost:8222/jsz?streams=1&accounts=1&config=1' \
  | jq '.account_details[].stream_detail[] | {name, max_bytes: .config.max_bytes, discard: .config.discard, bytes: .state.bytes}'
```

Then re-budget with the options above. Do not treat this as "the stream needs more room" by reflex:
a stream that grows past a share sized from its own retention window usually means the volume
assumption changed, and that belongs in the contract's `max_bytes_defaults`, not only in one
cluster's values file.

## When `PFAuditRefusingWrites` fires

`PF_AUDIT` holds 365 d of identity and control-plane history and is `discard: new`, so at its
ceiling it stops accepting new audit records while the rest of the bus keeps running. That
isolation is what ADR-042 buys over a bus-wide `10047`, and it is strictly better — but the cost is
that **audit events stop reaching the audit trail and nothing else reports it**. This alert is the
thing that stops the isolation from simply relocating the silence.

**Who is refused.** `PF_AUDIT` has no subjects of its own; it sources the identity and control
events from `PF_EVENTS` (ADR-044). Producers publish to `PF_EVENTS` and are never refused. The
refused writer is `PF_AUDIT`'s internal source consumer: nats-server retries it at the same sequence
(`processInboundSourceMsg`, `retrySourceConsumerAtSeq`) and logs nothing for a `max_bytes` refusal.
So the events are **waiting, not yet lost** — each is lost from the audit trail only when `PF_EVENTS`
drops it, at its 7 d `max_age` or earlier if `PF_EVENTS` itself fills and discards old.

The rule is derived, because no metric counts a refusal. It needs all three, each for 15 m:

- `nats_stream_total_bytes` at 99 % or more of `nats_stream_limit_bytes`;
- `nats_stream_last_seq` unchanged — at the ceiling but still storing is not refusing;
- `nats_stream_source_lag` above zero throughout — matching events are waiting in `PF_EVENTS`. This
  is what makes it a refusal rather than a full stream that nobody has written to. The server sets
  lag to the origin's pending count *after* the refused event, minus one, so one or two waiting
  events read `0`; the alert fires from the third.

1. **Confirm and measure.** `nats stream info PF_AUDIT` as above: `state.bytes` against
   `config.max_bytes`, and `sources[].lag` for how many audit events are waiting.
2. **Recover the room, do not wait it out.** 365 d of `max_age` means the stream will not expire its
   way out of this in any useful time. Re-budget per the options above. Once there is room the
   source consumer resumes from the refused sequence and the backlog drains by itself.
3. **Know the deadline.** Anything still waiting when `PF_EVENTS` drops it is gone from the audit
   trail for good. Check the oldest waiting event's age against `PF_EVENTS`' retention, and
   whether `JetStreamStreamApproachingMaxBytes` is also firing for `PF_EVENTS` — a full
   `PF_EVENTS` shortens that deadline below 7 d.
4. **Account for any gap.** If the room came too late, record the window in the incident, because an
   audit trail with an unrecorded hole is worse than one with a documented one.
5. **File the fix.** `PF_AUDIT` reaching its ceiling means its share was sized against the wrong
   volume assumption. The permanent fix is `max_bytes_defaults` in the contract, not this cluster's
   values file.

## When `JetStreamFileStoreMetricsAbsent` fires

Nothing is watching the store while this fires, and it keeps filling.

1. `kubectl -n nats get pods` — the exporter is a sidecar, so a restarting NATS pod takes it along.
2. Check the sidecar still has `-jsz=all`. Without it the exporter serves plain `/jsz`: the account
   block disappears, every `nats_account_storage_used` series with it, and the pod looks healthy.
   `kubectl -n nats get statefulset nats -o jsonpath='{.spec.template.spec.containers[?(@.name=="prom-exporter")].args}'`
3. Check the PodMonitor is still matched: `kubectl -n monitoring get podmonitor`.
4. While it is firing, read the store directly:
   ```bash
   curl -s 'localhost:8222/jsz?accounts=1' | jq '{max: .config.max_storage, used: .storage}'
   ```

The rule forgets a series 6 h after its last sample, so a cluster that genuinely removed NATS stops
being paged rather than needing a permanent silence.

## Changing or testing these rules

```bash
task test:alerts          # promtool unit tests against the rules the chart renders
```

The expressions are extracted from the rendered Application, so the tests cannot drift from what
deploys. `tests/alerts/jetstream-storage-budget.test.yaml` brackets every threshold from both sides
and asserts the cases that must stay silent: a store at 60 %, a stream at exactly 75 % of its
`max_bytes`, an unbounded stream holding more than another stream's entire limit, a full stream
that is still accepting writes, and a full `PF_AUDIT` with no audit event waiting. It also covers
two properties the expressions depend on — that the store comparison sums *across* accounts (two
accounts at 40 % each page, neither alone would), and that a `max_bytes` of `0` cannot divide to
`+Inf` and page on every scrape.

All were confirmed by mutation: moving the 75 % threshold to 99 % and removing the `> 0` limit guard
each turn `task test:alerts` red, the second with `FORK_LOCAL is +Inf% of its max_bytes`. Removing
the source-lag term from `PFAuditRefusingWrites` fails only the idle case, and removing the
`last_seq` term fails only the still-accepting case.

## Related

- [alerting.md](./alerting.md): how these severities reach Pushover, and how to test delivery
- [pf-work-age-expiry.md](./pf-work-age-expiry.md): the other loss boundary on `PF_WORK`.
  `max_bytes` bounds the queue's **size** and refuses new work loudly; `max_age` bounds its
  messages' **lifetime** and deletes queued work silently. Neither substitutes for the other and a
  consumer outage can end in either
- `contracts/events/subjects.v1.yaml`: `max_bytes_defaults` and `max_bytes_sum_rule`, the normative
  statement of the budget
- `docs/project_notes/decisions.md` ADR-042 (the review that found the unbounded streams), ADR-038
  (`PF_AUDIT`'s `discard: new`), ADR-030 (the boundary gate that requires the alert)
