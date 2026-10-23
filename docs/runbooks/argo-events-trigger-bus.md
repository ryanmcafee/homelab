# Argo Events trigger bus: the silent-drop path and the alerts that cover it

The Argo Events `EventBus` named `default` (`charts/argo-events-config`) is its own JetStream,
separate from the platform NATS ([event-backbone.md](../event-backbone.md)). Argo Events creates one
stream on it, `default`, with `retention: limits`, `discard: old` and no dead-letter queue. When
the stream reaches `maxAge`, `maxBytes` or `maxMsgs` it deletes its **oldest** triggers, whether or
not a Sensor consumed them, and reports nothing. A Sensor that is down longer than `maxAge` loses
every trigger it missed. Without these alerts, the first symptom is automation that never ran.

The rules are the `homelab-argo-events-trigger-bus` group in
`charts/addons/templates/kube-prometheus-stack.yaml`. They render only when `argo-events.enabled`
is true and take every threshold from the same `argo-events.bus` values the EventBus is built from.
No cluster name, domain or namespace is hard-coded.

## Where the metrics come from

The EventBus StatefulSet runs a `metrics` sidecar (`prometheus-nats-exporter`, `-jsz=all
-prefix=nats`, port 7777). Argo Events creates no monitor for it, so
`charts/argo-events-config/templates/podmonitor.yaml` scrapes it and sets `job` to
`argo-events-trigger-bus`. Every rule selects on that job.

The sidecar is exporter **0.14.0**, which the argo-events chart pins for bus version `2.10.29`. It
has no `nats_stream_limit_bytes` or `nats_stream_limit_messages`, so the platform's
`JetStreamStreamApproachingMaxBytes` has no denominator on this bus and stays silent. That is why
this group renders the limits into the expression instead of reading them from the exporter.

## Alerts

| Alert | Severity | Fires when |
|---|---|---|
| `ArgoEventsTriggerBusExporterDown` | warning | no `up{job="argo-events-trigger-bus"} == 1` for 15 m, including a target that never existed |
| `ArgoEventsTriggerBusApproachingLimit` | warning / critical | the `default` stream is above 75 % / 90 % of `maxBytes` or `maxMsgs` (label `limit`) |
| `ArgoEventsTriggerUnprocessedNearMaxAge` | warning / critical | a consumer's ack floor has not moved for 2/3 / 5/6 of `maxAge` (48 h / 60 h at 72 h) while it had triggers pending the whole time |

### Why age is measured per consumer, not on the stream head

On a `limits` stream an acked message is not removed. With steady traffic the oldest message is
**always** close to `maxAge`, and deleting it is normal. A trigger is lost only when it ages out
before a consumer acks it. So the age signal is a consumer's ack floor
(`nats_consumer_ack_floor_stream_seq`) frozen while `nats_consumer_num_pending +
nats_consumer_num_ack_pending` stayed above zero for the whole window. The trigger just past the
ack floor has then waited at least that long. A coverage guard (the window minus 1 h of samples)
keeps a freshly started Prometheus quiet, the same way the `PF_WORK` age rules do
([pf-work-age-expiry.md](./pf-work-age-expiry.md)).

## Operator actions

### ArgoEventsTriggerBusExporterDown

Every other alert on this page is blind while this one fires.

1. `kubectl -n <argo-events namespace> get pods -l eventbus-name=default`. Check that the pods are
   Running and that the `metrics` container is ready.
2. `kubectl -n <argo-events namespace> get podmonitor argo-events-trigger-bus`. If it is missing,
   the `argo-events-config` Application has not synced.
3. In Prometheus, open Status -> Targets and look for `argo-events-trigger-bus`. A target that is
   down with `connection refused` points at the sidecar. A target that never appears points at
   the PodMonitor selector or Prometheus's PodMonitor namespace selector.

### ArgoEventsTriggerBusApproachingLimit

At the limit, `discard: old` starts deleting the oldest triggers.

1. Find the cause before raising anything. A Sensor that stopped acking also fires
   `ArgoEventsTriggerUnprocessedNearMaxAge`. An EventSource publishing far more than usual shows
   as a steep rise in `nats_stream_last_seq{job="argo-events-trigger-bus"}`.
2. If the load is real, raise `maxBytes` (or `maxMsgs`) in `configuration/templates/helm-addons.tmpl`
   (`argo-events.bus`). The render refuses a `maxBytes` above `maxBytesBudgetFraction` of the PVC,
   so grow `storage.size` with it.

### ArgoEventsTriggerUnprocessedNearMaxAge

`consumer_name` identifies the Sensor's durable consumer on the bus.

1. `kubectl -n <argo-events namespace> get sensors,pods`. Find the Sensor that owns the consumer
   and why it is not acking (CrashLoopBackOff, a trigger that keeps failing, a deleted Sensor whose
   consumer remains).
2. Get it running and acking. Once the ack floor moves the alert resolves.
3. If it cannot recover before `maxAge`, record which triggers were pending (for example with
   `nats stream view default` against the bus) so the automation they represent can be re-run by
   hand. Once the critical has fired, less than `maxAge / 6` remains.

## Proof

`tests/alerts/argo-events-trigger-bus.test.yaml` (both renders) and
`tests/alerts/<env>/argo-events-trigger-bus-max-bytes.test.yaml` (one per render, because
`maxBytes` differs) hold a positive firing assertion for every alert and severity. They include a
cold-start case with no series at all for the exporter rule, and a quiet case for a healthy
consumer and an idle one. `task test:alerts` runs them against the rendered chart.
