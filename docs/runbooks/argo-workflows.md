# Argo Workflows retention

Completed workflows and their step logs stay reviewable in the Argo Workflows UI for
`argo-workflows.retentionDays` (30) days, long after the cluster has deleted the Workflow and its
pods.

| Piece | Where |
|---|---|
| Live-object GC | `workflowDefaults` in `configuration/templates/helm-addons.tmpl`: Workflow TTL 1 day on success, 7 days otherwise; succeeded pods deleted 10 min after completion (`podGC: OnPodSuccess`). A Workflow's own `ttlStrategy`/`podGC` wins |
| Workflow archive | CloudNativePG Cluster `argo-workflows-postgres` (`charts/argo-workflows-dependencies`, wave 11); `persistence.archiveTTL` deletes rows after the retention |
| Log archive | `artifactRepository.archiveLogs`: every step uploads its `main` log to the versitygw S3 store `argo-workflows-logs` (key `<namespace>/<workflow>/<pod>/main.log`); its `retention` sidecar deletes objects older than the retention every hour |
| Controller + server | `charts/addons/templates/argo-workflows.yaml`, wave 12 (exits while the archive database is unreachable, so it syncs after it) |

## Setup

The log archive needs a secret store (`SECRETS_PROVIDER=onepassword`). Create the 1Password item
`ARGO_WORKFLOWS_ARTIFACTS_1P_PATH` (default `vaults/homelab/items/argo-workflows-artifacts`) with
two fields before the sync:

```bash
op item create --vault homelab --category login --title argo-workflows-artifacts \
  "accessKey[text]=argo-workflows" "secretKey[password]=$(openssl rand -hex 32)"
```

Every namespace that runs workflows needs that item as Secret `argo-workflows-artifacts`, or the
executor cannot upload logs and the step errors. `charts/triage-agent` reads it into
`triage-agent`; a new workflow namespace adds the same `OnePasswordItem`.

## Review

- UI: `https://<WORKFLOWS_HOSTNAME>` -> Archived Workflows; a step's Logs tab reads the archived
  log once the pod is gone.
- CLI: `argo archive list -n <namespace>`, `argo archive get <uid>`.
- Database: `kubectl -n argo-workflows exec -it argo-workflows-postgres-1 -- psql argo -c 'select name, phase, finishedat from argo_archived_workflows order by finishedat desc limit 20'`.
