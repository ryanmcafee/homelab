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
`last_ts` and no equivalent; verified against 0.18.0, the version the chart pins, and against the
exporter's `main` branch (`collector/jsz.go`), which is no different. The full stream surface is:

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

Each aging rule carries a coverage guard (`count_over_time(...[12h]) >= 11 *
count_over_time(...[1h])`) so a Prometheus with only a few hours of history cannot page: a 12h
window over 3h of data is trivially "unchanged". The cost of the guard is that on a fresh
Prometheus the rule waits for ~11h of samples, and a scrape gap larger than ~1h inside the window
suppresses it — which is what `PFWorkStreamMetricsAbsent` is for.

## When `PFWorkOldestUnackedAging` fires

You have 12h (warning) or 6h (critical) before the queue is deleted. The commands below use
`-n nats`; substitute the namespace the NATS Application actually deploys into (issue
[#50](https://github.com/ryanmcafee/homelab/issues/50)) — the alerts carry it as the `namespace`
label, and `nats_stream_first_seq{stream_name="PF_WORK"}` shows it. In order:

1. **Confirm the head is really stuck** and see how bad it is. `first_ts` is not in Prometheus but
   it is in the stream itself, so ask the server:

   ```bash
   kubectl -n nats exec -it deploy/nats-box -- nats stream info PF_WORK
   # or, without nats-box:
   kubectl -n nats port-forward svc/nats 8222 &
   curl -s 'localhost:8222/jsz?streams=1&consumers=1&accounts=1' \
     | jq '.account_details[].stream_detail[] | select(.name=="PF_WORK") | .state'
   ```

   `state.first_ts` is the age of the oldest message; `now - first_ts` against `config.max_age`
   (24h) is exactly how long you have.

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

1. Snapshot the evidence before it ages out of Prometheus:
   ```promql
   nats_stream_first_seq{stream_name="PF_WORK"}
   nats_consumer_ack_floor_stream_seq{stream_name="PF_WORK"}
   nats_stream_total_messages{stream_name="PF_WORK"}
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

Nothing is watching the 24h budget while this is firing, and the budget keeps running.

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
fresh publish, and a queue drained by real acks. Verified against a real
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
