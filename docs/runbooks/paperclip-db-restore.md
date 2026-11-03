# Paperclip database backup and restore

The Paperclip database (CloudNativePG Cluster `paperclip-postgres`) is dumped once a day, and a
single workflow puts any dump back. Both are Argo Workflows in namespace `paperclip`, rendered by
`charts/paperclip-database/templates/backup.yaml` wherever the argo-workflows addon runs (not in
Kind).

| Piece | What it does |
|---|---|
| CronWorkflow `paperclip-db-backup` | Daily at `backup.schedule` (03:15, `TIMEZONE`): runs the backup template |
| WorkflowTemplate `paperclip-db-backup` | `pg_dump --format=custom` to `/backups/paperclip-<UTC>.dump`, checks it with `pg_restore --list`, then deletes dumps older than `retentionDays` (14), always keeping the newest `keep` (3) |
| WorkflowTemplate `paperclip-db-restore` | The restore below |
| PVC `paperclip-postgres-backups` | 20Gi on `STORAGE_CLASS_NFS` (HDD pool), apart from the database's iSCSI volume; `Delete=false`, so Argo CD never prunes it |

Backups and restores share the mutex `paperclip-db`, so they never overlap.

## Back up now

Run this before any change that migrates the schema, such as a Paperclip image bump:

```bash
argo submit -n paperclip --from workflowtemplate/paperclip-db-backup --wait --log
```

## List the dumps

Every backup log ends with the listing. To look without taking one, mount the PVC in a throwaway
pod (`kubectl cp` from the same pod copies a dump off the cluster):

```bash
kubectl -n paperclip run backups-ls --rm -it --restart=Never --image=busybox --overrides='{"spec":{
  "containers":[{"name":"backups-ls","image":"busybox","command":["ls","-lh","/backups"],
  "volumeMounts":[{"name":"b","mountPath":"/backups"}]}],
  "volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"paperclip-postgres-backups"}}]}}'
```

## Restore

```bash
argo submit -n paperclip --from workflowtemplate/paperclip-db-restore \
  -p confirm=restore-paperclip [-p backup=paperclip-20260927T031500Z.dump] --wait --log
```

`backup` defaults to `latest`, the newest `paperclip-*.dump`. Without `confirm=restore-paperclip`
the workflow refuses and changes nothing. The steps:

1. **preflight**: resolves the dump and checks it with `pg_restore --list`
2. **pause-argocd**: annotates Application `argocd/paperclip` with
   `argocd.argoproj.io/skip-reconcile: "true"`, which stops its auto-sync and self-heal. The parent
   `applications` syncs with server-side apply, so it leaves the annotation alone
3. **suspend**: sets `spec.suspended: true` on Instance `paperclip`; the operator scales the
   StatefulSet to 0 and **wait-stopped** waits for it
4. **safety-dump**: saves the current database to `/backups/prerestore-paperclip-<UTC>.dump`
5. **pg-restore**: ends the app role's remaining sessions, then
   `pg_restore --clean --if-exists --single-transaction`: it all applies or nothing does
6. **resume** (exit handler, after any confirmed run, failed or not): clears `spec.suspended` and
   the annotation, then waits until `paperclip-0` is Ready. Argo CD reconciles the Application again.
   A refused run never reaches it, so it leaves an Application or Instance paused by hand alone

To undo a restore, restore the pre-restore dump:
`-p backup=prerestore-paperclip-<UTC>.dump`.

## Roll back an image upgrade

A newer Paperclip image migrates the schema on start and the old image cannot read it. Back up
first, then to go back: revert the `images.paperclip` pin, let it sync, and restore the dump taken
before the upgrade.

## If a restore is interrupted

The exit handler does not run when the workflow is deleted or its pod is lost. Resume by hand:

```bash
kubectl -n paperclip patch instance paperclip --type merge -p '{"spec":{"suspended":null}}'
kubectl -n argocd annotate application paperclip argocd.argoproj.io/skip-reconcile-
```

The database is either untouched or fully restored: `pg_restore` runs in one transaction.
