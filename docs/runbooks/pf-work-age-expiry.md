# PF_WORK age expiry: the silent data-loss path and the alerts that cover it

`PF_WORK` is the JetStream work-queue stream for durable requests (`pf.*.*.*.*.*.wq`,
`contracts/events/subjects.v1.yaml`). Its `max_age` is **24h**. When that budget runs out
JetStream deletes the messages — including messages no consumer has acked — and **says nothing**:

- there is no advisory for age-based deletion;
- `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>` never fires, because nothing was redelivered;
- the only message that produces any signal at all is one that was in flight on a consumer when
  the budget ran out: that one gets a `io.nats.jetstream.advisory.v1.terminated` advisory. Work
  that was queued and never delivered — the shape of every consumer outage — produces nothing.

Measured on `nats-server 2.10.22` with `max_age` shortened to 8s: three messages accepted with a
`PubAck` at t+0, one fetched and never acked, all three gone between t+8s and t+10s; the stream
went `messages 3 → 0`, `first_seq 1 → 4`, and exactly one `terminated` advisory was published for
the in-flight one. A consumer outage longer than `max_age` therefore destroys durable requests
with no trace, which is why ADR-030 fails a `PF_WORK` consumer that has no stream-level alert.

## What the exporter does and does not give you

`prometheus-nats-exporter` (the `promExporter` sidecar of the NATS chart, run with `-jsz=all`
`-prefix=nats`) exports **no message age and no timestamp**. There is no `first_ts`, no
`last_ts` and no equivalent; verified against 0.20.1 (the version the NATS chart pins), 0.18.0 and
the exporter's `main` branch (`collector/jsz.go`), none of them different. The full stream surface
is:

| Metric | Meaning |
|---|---|
| `nats_stream_first_seq` | sequence of the oldest message still in the stream |
| `nats_stream_last_seq` | sequence of the newest message |
| `nats_stream_total_messages` | messages in the stream |
| `nats_stream_total_bytes` | bytes in the stream |
| `nats_stream_consumer_count`, `nats_stream_subject_count` | consumers, subjects |
| `nats_stream_limit_messages`, `nats_stream_limit_bytes` | configured limits (no age limit) |
| `nats_consumer_ack_floor_stream_seq` | lowest stream sequence this consumer has acked past |
| `nats_consumer_delivered_stream_seq`, `nats_consumer_num_pending`, `nats_consumer_num_ack_pending` | consumer progress |

So the SLI has to be built, not read. **`nats_stream_first_seq` is the age signal**: on a
work-queue stream the head is removed when it is acked, so a `first_seq` that does not move is a
head message that nobody has taken. `first_seq` frozen for 12h while the stream was never empty
means the oldest message is at least 12h old.

Queue depth cannot do this job: a queue holding three messages nobody is taking and a queue
holding three messages being worked through look identical in `nats_stream_total_messages`. The
"never empty" clause matters too — a drained work queue leaves `first_seq` at `last_seq + 1`, so
the next publish reuses that sequence and the head looks frozen when it is a second old.

## Which server's view counts

The exporter reports one series per NATS server, so a 3-node cluster publishes three
`nats_stream_first_seq` series for `PF_WORK` and only the stream leader's is authoritative — a
follower can lag or report an older sequence. Deduplicating on `is_stream_leader="true"` is what
reduces those three to one.

**A single node also reports `is_stream_leader="true"`**, by two independent upstream paths:
nats-server synthesizes a cluster block naming itself leader for a stream with no raft group
(`server/jetstream_cluster.go`, v2.15.0), and the exporter defaults the label to `"true"` when the
block is absent (`collector/jsz.go`, 0.20.1 and 0.18.0). So the filter selects the only server
rather than nothing. That is upstream behaviour in two projects, not a contract, and the
non-clustered case is not rare: `contracts/events/subjects.v1.yaml` sets
`replicas_defaults.homelab: 1` deliberately (a hard-coded 3 leaves a single-node fork unable to
create a stream at all, nats-server error 10074), so it is the Kind loop and every single-node
fork.

Three recording rules resolve leadership once, and every alert reads them instead of the raw
metric:

| Recorded series | Source |
|---|---|
| `homelab:nats_stream_first_seq:authoritative` | `nats_stream_first_seq` |
| `homelab:nats_stream_total_messages:authoritative` | `nats_stream_total_messages` |
| `homelab:nats_consumer_ack_floor_stream_seq:authoritative` | `nats_consumer_ack_floor_stream_seq` |

Each prefers the series labelled leader and falls back to every server when no series carries that
label, so one expression is correct on both topologies and stays correct if either upstream changes
how it labels a standalone stream. Two consequences worth knowing when you debug: the alerts carry
no `is_stream_leader` label (it is aggregated away), and during a leader election the fallback
briefly supplies the followers' view rather than leaving a gap.

## The alerts

All four are in the `homelab-nats-jetstream` group of
`charts/addons/templates/kube-prometheus-stack.yaml` and route by `severity`
([alerting.md](./alerting.md)). They are silent on a cluster with no NATS: no series, no alert.

| Alert | Severity | Fires when | Budget left |
|---|---|---|---|
| `PFWorkOldestUnackedAging` | warning | `first_seq` unmoved for 12h while the stream was never empty | 12h |
| `PFWorkOldestUnackedAging` | critical | the same for 18h | **6h** |
| `PFWorkMessagesExpiredUnacked` | critical | the head advanced further than every consumer ack floor did: messages left the stream unacked | none, loss already happened |
| `PFWorkStreamMetricsAbsent` | warning | the exporter reported `PF_WORK` in the last 6h and no longer does | unknown — the monitor is blind |

Both aging rules share one `alertname`, so Alertmanager's severity inhibition drops the warning
notification when the critical fires.

All four carry `account`, `namespace` and `job`, so every one of them names the NATS account and
install it is about, and Alertmanager routing and inhibition keyed on `namespace` reach all four.
The recording rules and the two loss rules aggregate `by (account, stream_name, namespace, job)`
and never by `stream_name` alone. `PF_WORK` exists once per NATS account (ADR-043) and once per
install, and `prometheus-nats-exporter` (0.20.1) labels every stream and consumer series with
`account`. Dropping either label collapsed several streams into one series:
`PFWorkMessagesExpiredUnacked` netted one stream's head advance against another's consumer acks,
`PFWorkOldestUnackedAging` followed whichever head was highest, and `PFWorkStreamMetricsAbsent`
could not fire while any other stream still reported. `tests/alerts/pf-work-age-expiry.test.yaml`
asserts the label set on every fired alert, and cases 8 and 9 assert two namespaces are reported
separately; `tests/alerts/pf-work-per-account.test.yaml` does the same for two accounts in one
install.

Each aging rule carries a coverage guard (`count_over_time(...[12h]) >= 11 *
count_over_time(...[1h])`) so a Prometheus with only a few hours of history cannot page: a 12h
window over 3h of data is trivially "unchanged". The cost of the guard is that on a fresh
Prometheus the rule waits for ~11h of samples, and a scrape gap larger than ~1h inside the window
suppresses it — which is what `PFWorkStreamMetricsAbsent` is for.

## When `PFWorkOldestUnackedAging` fires

You have 12h (warning) or 6h (critical) before the queue is deleted. The commands below use
`-n nats`; substitute the namespace the NATS Application actually deploys into (issue
[#50](https://github.com/ryanmcafee/homelab/issues/50)) — all four alerts carry it as the
`namespace` label, and `nats_stream_first_seq{stream_name="PF_WORK"}` shows it. In order:

1. **Confirm the head is really stuck** and see how bad it is. `first_ts` is not in Prometheus but
   it is in the stream itself, so ask the server:

   ```bash
   kubectl -n nats exec -it deploy/nats-box -- nats stream info PF_WORK
   # or, without nats-box:
   for pod in $(kubectl -n nats get pod -l app.kubernetes.io/name=nats -o name); do
     kubectl -n nats port-forward "$pod" 8222 >/dev/null & pf=$!
     sleep 1
     curl -s 'localhost:8222/jsz?streams=1&consumers=1&accounts=1&config=1' \
       | jq --arg pod "$pod" '.account_details[]? | .name as $account | .stream_detail[]?
           | select(.name=="PF_WORK")
           | {pod: $pod, account: $account, state: .state, max_age: .config.max_age}'
     kill "$pf"
   done
   ```

   Three things about that command are easy to get wrong under pressure. The monitoring port is
   on the pods and on `nats-headless`, never on `svc/nats` — the chart leaves
   `service.ports.monitor` disabled, so `port-forward svc/nats 8222` fails to resolve rather than
   degrading. Do not enable it to shorten the command: 8222 is unauthenticated, and
   `/jsz?accounts=1` and `/connz` would expose every stream and connection cluster-wide. `/jsz`
   answers only for the server you reached, and `PF_WORK` is single-replica
   (`replicas_defaults.homelab: 1`), so on a 3-server cluster exactly one pod returns each
   account's copy (ADR-043: one `PF_WORK` per account), and it need not be `nats-0` — the loop is
   why you do not have to guess which. And `config=1` is what makes the server return `max_age`
   at all; without it `.config` is absent.

   `state.first_ts` is the age of the oldest message; `now - first_ts` against `max_age`
   (`86400000000000`, i.e. 24h in nanoseconds) is exactly how long you have.

2. **Find out why nothing is consuming.** `nats_consumer_num_pending` high with
   `nats_consumer_num_waiting` at 0 means no worker is fetching at all (pod down, crash-looping,
   or never deployed); `num_ack_pending` pinned at `max_ack_pending` means workers are fetching
   and not finishing. `kubectl -n <ns> get pods` on the consuming component, then its logs.

3. **Get a consumer running.** Restoring the consumer is the fix — the queue drains and
   `first_seq` moves. Nothing needs to be done to the stream.

4. **If you cannot restore a consumer inside the remaining budget, copy the work out.** Do this
   before the budget expires; there is no recovery afterwards. Either
   ```bash
   nats stream backup PF_WORK ./pf-work-backup            # whole stream to disk
   ```
   or drain it into a file with an ephemeral consumer and replay later
   (`nats consumer next PF_WORK <durable> --count N --raw >> pf-work.ndjson`). Both need
   stream-admin rights: use the admin kubeconfig, not `homelab-readonly`.

5. **Do not raise `max_age` to buy time.** It is contract
   (`contracts/events/subjects.v1.yaml`) and the contract gate rejects shortening it later
   (`retention-shortened`), so a panic bump becomes permanent. Escalate instead — a
   platform-wide extension is an ADR, not an incident action.

## When `PFWorkMessagesExpiredUnacked` fires

Durable requests were destroyed. `$value` is how many. This is data loss, not a warning:

1. Snapshot the evidence before it ages out of Prometheus. The raw metrics show every server's
   view; the recorded series are the ones the alert did its arithmetic on:
   ```promql
   nats_stream_first_seq{stream_name="PF_WORK"}
   nats_consumer_ack_floor_stream_seq{stream_name="PF_WORK"}
   nats_stream_total_messages{stream_name="PF_WORK"}
   homelab:nats_stream_first_seq:authoritative{stream_name="PF_WORK"}
   homelab:nats_consumer_ack_floor_stream_seq:authoritative{stream_name="PF_WORK"}
   ```
   The sequence gap tells you the range of lost sequences: everything between the old and the new
   `first_seq` that the ack floors did not cover.
2. Rule out the benign causes, which this alert cannot distinguish from expiry: a `nats stream
   purge`, a manual message delete, or a stream re-create. The NATS server log and
   `$JS.EVENT.ADVISORY.STREAM.>` show those.
3. Identify what was lost from the producer side, not the stream — the messages are gone. The
   envelope's `correlationid` is the join key: the producer's logs or `PF_EVENTS` (7d retention)
   carry the request that was never answered. Re-publish what still matters.
4. Write the postmortem and file the fix. A `PF_WORK` consumer that can be down for 24h without
   anyone noticing is the defect; the alert firing is the symptom.

**It undercounts in one case.** A message that was in flight on a consumer when it expired moves
that consumer's ack floor (the `terminated` path), so it cancels out of the arithmetic. If every
lost message was in flight, this rule stays silent — the aging alerts are what cover that, and
they fire 6h earlier. The rule also assumes one consumer group per stream, as the contract
requires; several consumers with disjoint subject filters each advance their own ack floor over
sequences they do not own, and the arithmetic would have to move to per-filter streams.

## When `PFWorkStreamMetricsAbsent` fires

Nothing is watching the 24h budget while this is firing, and the budget keeps running. The rule is
per account and install: it fires for each `(account, namespace, job)` that reported `PF_WORK` in
the last 6h and no longer does, so the alert's own `account` and `namespace` labels are the ones to
act on — another account or a second NATS still reporting does not suppress it.

1. `kubectl -n nats get pods` — the exporter is a sidecar of the NATS pods, so a restarting NATS
   pod takes it with it.
2. Check the sidecar still has `-jsz=all`: without it the exporter serves `varz` only, and every
   `nats_stream_*` series disappears while the pod looks healthy.
   `kubectl -n nats get statefulset nats -o jsonpath='{.spec.template.spec.containers[?(@.name=="prom-exporter")].args}'`.
3. Check the PodMonitor is still matched (`kubectl -n monitoring get podmonitor`), and that the
   scrape interval is 60s or below — a longer interval starves the coverage guard in the aging
   rules and silently disables them.
4. While it is firing, watch the stream directly with the `jsz` command in step 1 above.

## Changing or testing these rules

```bash
task test:alerts          # promtool unit tests against the rules the chart renders
```

The expressions are extracted from the rendered Application, so the tests cannot drift from what
deploys. `tests/alerts/pf-work-age-expiry.test.yaml` brackets every threshold from both sides
(silent at 11h of head age, warning at 12h, warning-only at 17h, critical at 18h) and includes the
three cases that must **not** page: a busy queue with constant depth, an idle queue that gets a
fresh publish, and a queue drained by real acks. Two cases feed `PF_WORK` series from two namespaces
and assert two separately attributed alerts, and `tests/alerts/pf-work-per-account.test.yaml` does
the same for two accounts in one namespace; together they pin the aggregation to `by (account,
stream_name, namespace, job)`. Verified against a real
`nats-server 2.10.22` + `prometheus-nats-exporter 0.18.0` + Prometheus 3.12: with every window
scaled by 720x (`12h` → `60s`, `max_age` → `120s`), the warning fired at t+64s (≙ 12.8h), the
critical at t+89s (≙ 17.8h), the deletion landed at t+124s (≙ 24.8h) and
`PFWorkMessagesExpiredUnacked` fired on the same evaluation.

## Related

- [alerting.md](./alerting.md): how these severities reach Pushover, and how to test delivery
- `contracts/events/subjects.v1.yaml`: `PF_WORK.silent_loss`, the normative statement of this
  failure and of the alert requirement
- `docs/contracts/event-contract.md` §7: blast radius
- `docs/project_notes/decisions.md` ADR-038 (the contract review that found this), ADR-030 (the
  boundary quality gate that requires the alert)
