# codesearch

One [codesearch](https://github.com/ryanmcafee/codesearch) `serve` for the whole cluster. It clones
the repositories in `CODESEARCH_REPOS`, keeps their default branches indexed and answers MCP over
streamable HTTP, so an agent searches code without running codesearch itself:

```
http://codesearch.codesearch.svc.cluster.local:39725/mcp
```

The image, the Helm chart, the service alerts and the Grafana dashboard are published and owned by
the codesearch repository (chart `codesearch` from `https://ryanmcafee.github.io/codesearch`, image
`ghcr.io/ryanmcafee/codesearch`). This repository only consumes them and adds what is
homelab-specific: configuration, the 1Password items, and backup and restore on Argo Workflows.

**Depends on the upstream release:** `configuration/versions.yaml` `charts.codesearch` pins `1.7.0`,
the first release that ships the chart. Until it is published the `codesearch` Application cannot
sync, codesearch stays off in Kind and the e2e test and restore drill wait (bd homelab-3m8.5).

Operations (backup, restore, adding repositories, onboarding a client):
[docs/runbooks/codesearch.md](../runbooks/codesearch.md). Design:
`docs/plans/2026-09-26-codesearch-service.md`.

| Piece | Where |
|---|---|
| Applications | `charts/addons/templates/codesearch.yaml`: `codesearch-dependencies` (wave 13, after Argo Workflows at 12, whose CRDs it uses) and `codesearch` (wave 14, upstream chart) |
| Upstream values | `codesearch:` block of `configuration/templates/helm-addons.tmpl` (`values:` is handed to the chart verbatim; `repos` becomes `repositories.urls`) |
| Homelab chart | `charts/codesearch-dependencies`: OnePasswordItems, CronWorkflow `codesearch-backup`, WorkflowTemplate `codesearch-restore`, RBAC |
| Service alerts, dashboard | upstream chart (`prometheusRule`, `dashboard`; the Grafana sidecar loads ConfigMaps labelled `grafana_dashboard: "1"`) |
| Backup alert | `CodesearchBackupMissing` in `charts/addons/templates/kube-prometheus-stack.yaml`, tests in `tests/alerts/codesearch.test.yaml` |
| Backup store | bucket `codesearch-backups` on the Argo Workflows log store (`charts/argo-workflows-dependencies`) |

## What homelab sets

| Upstream value | Homelab setting | Why |
|---|---|---|
| `auth.mode` | `networkPolicy` | serve binds loopback, a forwarder publishes port 39725, no API key; the NetworkPolicy is the access control |
| `networkPolicy.ingress` | namespaces labelled `codesearch-client: "true"`, `monitoring`, and pods of the `codesearch` namespace | clients, Prometheus, and the smoke, backup and restore pods |
| `persistence` | 20 Gi on `STORAGE_CLASS_ISCSI_SSD`, `Prune=false,Delete=false` | LMDB and tantivy want block storage; rebuilding every index costs hours of CPU |
| `strategy.type` | `Recreate` | one replica on a ReadWriteOnce volume |
| `repositories` | `urls` from `CODESEARCH_REPOS`, `intervalSeconds: 300`, `tokenSecret` `codesearch-git`/`GIT_TOKEN` when `CODESEARCH_GIT_1P_PATH` is set | |
| `serviceMonitor`, `prometheusRule`, `dashboard` | enabled | the upstream alerts and dashboard replace any homelab copy |
| `extraInitContainers` | `restore-apply` | swaps a backup staged by `codesearch-restore` into `/data/home/.codesearch` and touches `force-reindex` before serve starts |

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `CODESEARCH_ENABLED` | `false` | Renders both Applications (localdev: `false` until the chart is published) |
| `CODESEARCH_REPOS` | empty | Comma-separated `https://` URLs; the alias an agent passes as `project` is the repository name |
| `CODESEARCH_GIT_1P_PATH` | empty | 1Password item with field `GIT_TOKEN` for private repositories |
| `charts.codesearch` | `configuration/versions.yaml` | Chart version; the backup workflows run the image tag of the same version |

## Clients

A client namespace needs the label `codesearch-client: "true"` and, when it restricts egress, a
policy to TCP 39725 in namespace `codesearch` (`charts/paperclip/templates/networkpolicy-codesearch.yaml`).
MCP client entry:

```json
{"type": "http", "url": "http://codesearch.codesearch.svc.cluster.local:39725/mcp"}
```
