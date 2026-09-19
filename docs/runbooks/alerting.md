# Alerting: Alertmanager routes, receivers and rules

Prometheus alerts reach you through Alertmanager (kube-prometheus-stack, wave 9). Critical
alerts go to Pushover and Slack, warnings to Slack, everything else is dropped. The
credentials live in one 1Password item; nothing secret is committed.

| Severity | Receiver(s) | Why |
|---|---|---|
| `critical` | `pushover-critical` **and** `slack` | wakes you up; Slack keeps the record |
| `warning` | `slack` | look during the day |
| `info`, `Watchdog`, `InfoInhibitor` | `null` | the chart's heartbeat and inhibitor plumbing; never a page |

A `critical` alert inhibits the `warning`/`info` alert of the same `alertname` in the same
namespace. Groups form on `alertname, namespace, severity`; a group waits 30 s, updates every
5 m and repeats every 4 h. Resolved notifications are sent to both receivers.

Where it is defined: `charts/addons/templates/kube-prometheus-stack.yaml` (`alertmanager.config`,
`alertmanagerSpec.secrets`, `additionalPrometheusRulesMap`), values from
`configuration/templates/helm-addons.tmpl` (`kube-prometheus-stack.alertmanager.notifications`),
the Secret from `charts/prometheus-config/templates/alertmanager-notifications.yaml`.

## The 1Password item

`ALERTMANAGER_1P_PATH` (default `vaults/homelab/items/alertmanager-notifications`) names one
item with three fields. The 1Password operator turns it into Secret `alertmanager-notifications`
in `monitoring`; Alertmanager mounts it at `/etc/alertmanager/secrets/alertmanager-notifications/`
and every receiver reads a `*_file` there, so the values never appear in an Application spec.

| Field | Value | Where to get it |
|---|---|---|
| `slack_webhook_url` | Incoming webhook URL | Slack: app *Incoming Webhooks* on the alerts channel |
| `pushover_token` | Application API token | pushover.net: *Create an Application/API Token* |
| `pushover_user_key` | Your user (or group) key | pushover.net dashboard |

`ALERT_SLACK_CHANNEL` (default `#homelab-alerts`) is the channel Alertmanager names in the
payload; the webhook decides the workspace. Change either key in
`configuration/environments/homelab.yaml`.

Until the item exists the `alertmanager-notifications` OnePasswordItem is Degraded and the
Alertmanager pod stays Pending (its Secret volume is missing); creating the item resolves
both without a sync. Without a secret store (`SECRETS_PROVIDER=none`, Kind) Alertmanager is
off entirely, so localdev renders nothing of this.

## Test delivery

Push a synthetic alert straight into Alertmanager from inside the cluster; it is routed like
any other. Use `task prod:kubeconfig` first if you have no admin context (the read-only
`homelab-readonly` context cannot exec).

```bash
POD=alertmanager-kube-prometheus-stack-alertmanager-0
# warning -> Slack only
kubectl -n monitoring exec "$POD" -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 \
  alert add DeliveryTest severity=warning namespace=monitoring \
  --annotation=summary="Slack delivery test" --end="$(date -u -v+2M +%Y-%m-%dT%H:%M:%SZ)"
# critical -> Pushover and Slack
kubectl -n monitoring exec "$POD" -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 \
  alert add DeliveryTest severity=critical namespace=monitoring \
  --annotation=summary="Pushover delivery test" --end="$(date -u -v+2M +%Y-%m-%dT%H:%M:%SZ)"
# what Alertmanager did with it
kubectl -n monitoring logs "$POD" -c alertmanager | rg -i "notify|slack|pushover" | tail
```

Both end after two minutes and send a resolved notification. The Alertmanager UI is not
exposed; port-forward when you need it: `kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093`.

## Silence, inspect, change

```bash
kubectl -n monitoring exec "$POD" -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 alert          # firing now
kubectl -n monitoring exec "$POD" -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 \
  silence add alertname=HomelabNodeNotReady node=worker-1 --duration=2h --comment="planned reboot"
kubectl -n monitoring exec "$POD" -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 silence
```

To change routing or receivers edit `alertmanager.config` in the Application template and
prove the result before pushing:

```bash
task chart:template:addons | yq -r 'select(.kind=="Application" and .metadata.name=="kube-prometheus-stack") | .spec.source.helm.values' | yq -r '.alertmanager.config' > /tmp/am.yaml
amtool check-config /tmp/am.yaml        # go install github.com/prometheus/alertmanager/cmd/amtool@latest
```

Alertmanager's own `{{ }}` templating inside that file is written as ``{{`{{ ... }}`}}`` so Helm
leaves it alone; the snapshot in `tests/snapshots/homelab/addons.yaml` shows the final text.

## Rules

The chart's `defaultRules` stay on (node, kubelet, volumes, targets, etcd once scraped). Homelab
rules live in `additionalPrometheusRulesMap`:

| Group | Alert | Severity | Fires when |
|---|---|---|---|
| homelab-control-plane | `KubeAPIServerErrorsHigh` | critical | apiserver 5xx > 0.5/s for 2 m |
| homelab-control-plane | `NodeDiskWriteLatencyHigh` | warning | sda write latency > 50 ms for 10 m |
| homelab-control-plane | `EtcdMetricsAbsent` | warning | no `kube-etcd` target up for 15 m |
| homelab-infrastructure | `HomelabNodeNotReady` | critical | a node NotReady for 5 m |
| homelab-infrastructure | `HomelabNodeUnderPressure` | warning | Memory/Disk/PID pressure for 10 m |
| homelab-infrastructure | `HomelabEtcdQuorumAtRisk` | critical | fewer than 2 etcd members up for 5 m |
| homelab-infrastructure | `HomelabPostgresClusterDown` | critical | a CloudNativePG cluster reports no PostgreSQL up for 5 m |

Add a rule next to these (Prometheus `$labels` escaped as in the file), give it a `severity`
label the table above routes, and run `task verify:text`: kubeconform validates the
Application and the snapshot records the change. Metrics that are not scraped today (ArgoCD,
cert-manager) need a ServiceMonitor before a rule on them can fire; their CRD only exists
after wave 9, so such monitors belong in a `*-config` child, not the chart that installs the
component.

## Related

- `docs/runbooks/control-plane-storage.md`: the etcd alerts and what to do when they fire
- `docs/secrets.md`: how 1Password items reach the cluster
- `docs/project_notes/decisions.md` ADR-017: why routes and receivers live in the Application and not in an AlertmanagerConfig CR
