# codesearch runbook

The service: [docs/apps/codesearch.md](../apps/codesearch.md). The service alerts (down, degraded,
indexing failures, slow tool calls) and their runbooks ship with the upstream chart: see the
runbooks in the [codesearch repository](https://github.com/ryanmcafee/codesearch). This page covers
what homelab adds. Production is read-only for agents (`docs/runbooks/readonly-access.md`); the
`argo submit` and label commands below are for a human with write access.

## Look around

```bash
kubectl -n codesearch get pods,pvc,cronworkflows,workflows
kubectl -n codesearch logs deploy/codesearch -c restore-apply   # last start: did it apply a backup
argo -n codesearch list
argo -n codesearch cron get codesearch-backup
```

## CodesearchBackupMissing

| Rule | Fires when |
|---|---|
| `reason: stale` | the last successful backup is older than 36 h, for 15 m |
| `reason: absent` | no successful backup recorded for 36 h |

The gauge is an Argo custom metric: the workflow controller exports it as
`argo_workflows_codesearch_backup_last_success_timestamp_seconds` (ServiceMonitor of the
argo-workflows chart, `controller.serviceMonitor` in `helm-addons.tmpl`). A controller restart
clears it until the next backup, which is why the absent rule waits 36 h.

1. `argo -n codesearch list` and `argo -n codesearch logs <workflow>` of the last run.
2. A Pending backup pod: it must share the codesearch pod's node (ReadWriteOnce volume); is the
   codesearch pod running?
3. `mdb_copy: ... MDB_VERSION_MISMATCH`: the image's `mdb_copy` was not built from the LMDB
   codesearch links; fix the image upstream.
4. An artifact upload error: the log store (`kubectl -n argo-workflows get pods`) or the
   `argo-workflows-artifacts` Secret in this namespace.
5. `argo -n codesearch submit --from cronwf/codesearch-backup --watch` runs one now.

## Backup

`codesearch-backup` (CronWorkflow in `charts/codesearch-dependencies`, daily 03:30 UTC) runs on the
codesearch pod's node while serve keeps running:

1. `mdb_copy -c` of every `/data/home/.codesearch/embedding_cache/<model>` LMDB environment (a
   consistent copy under a live writer) and `repos.json`, into `codesearch.tar.gz`;
2. uploads it to `s3://codesearch-backups/codesearch/<UTC timestamp>.tar.gz` and
   `s3://codesearch-backups/codesearch/latest.tar.gz` on the Argo Workflows log store;
3. on success the controller sets the backup gauge.

The indexes are not backed up: they are derived, and the embedding cache makes a rebuild cheap
because unchanged chunks are not embedded again. The log store keeps the newest 14 objects of the
bucket (`logStore.backupBuckets` in `charts/argo-workflows-dependencies`; `latest.tar.gz` always
sorts first); the 30-day log retention never touches it.

## Restore

```bash
argo submit -n codesearch --from workflowtemplate/codesearch-restore --watch            # latest
argo submit -n codesearch --from workflowtemplate/codesearch-restore \
  -p key=codesearch/20260926T033000Z.tar.gz --watch                                     # a given one
```

1. `stage`: downloads the tarball, refuses anything but `repos.json` and
   `embedding_cache/<model>/data.mdb`, unpacks it to `/data/restore-staging/ready`;
2. `restart`: patches the codesearch Deployment's pod template, which replaces the pod;
3. its `restore-apply` init container swaps the cache and `repos.json` in before serve starts and
   touches `/data/home/.codesearch/force-reindex`;
4. the upstream sync re-registers every repository and fully reindexes it from the restored cache.

Nothing under a running serve is ever replaced. A lost volume restores the same way: ArgoCD creates
an empty claim, the pod starts with nothing indexed, and the restore stages into it.

## Add or remove a repository

Edit `CODESEARCH_REPOS` in the environment file (the 1Password env document for production) and let
the CMP re-render. Private repositories need `CODESEARCH_GIT_1P_PATH` pointing at an item whose
`GIT_TOKEN` can read them.

## Onboard a client namespace

1. Label the namespace in its chart: `codesearch-client: "true"`.
2. If the namespace restricts egress, allow TCP 39725 to pods of namespace `codesearch`
   (`charts/paperclip/templates/networkpolicy-codesearch.yaml` is the example).
3. Register the MCP server: `{"type":"http","url":"http://codesearch.codesearch.svc.cluster.local:39725/mcp"}`.
4. Check from a pod there: `curl -s http://codesearch.codesearch.svc.cluster.local:39725/healthz`.
