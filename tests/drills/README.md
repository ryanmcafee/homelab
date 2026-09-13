# Restore drills (Chainsaw)

Drills prove that a backup can actually be restored, not just that a backup job ran.
They run against the localdev Kind cluster (never production, ADR-009) and back
`docs/disaster-recovery.md` "Verified claims".

## Quick start

```bash
task drill:restore   # Kind -> ArgoCD -> operators (sync --warm) -> task test:drill
task test:drill      # the drills only, against a running Kind loop (localdev:warm is enough)
task test:drill -- --skip-delete   # keep the drill namespace for debugging
```

`.github/workflows/restore-drill.yml` runs `task drill:restore` every Monday 05:23 UTC and
on demand; a failure opens (or comments on) an issue labelled `restore-drill`, the next
passing run closes it.

## cnpg-restore

1. `cloudnative-pg` and `cnpg-barman-cloud` Applications are Healthy, both Deployments Available.
2. versitygw (`images.versitygw`, POSIX backend on an emptyDir, bucket = directory) serves
   S3 in the test namespace; `ObjectStore drill-store` points at it.
3. `Cluster drill-src` archives WAL through the Barman Cloud Plugin (`ContinuousArchiving`).
4. 1001 rows plus a marker that embeds the random test namespace are written.
5. `Backup drill-backup` (`method: plugin`) reaches `completed`.
6. `Cluster drill-restore` bootstraps from the object store only (`externalClusters` plugin,
   `serverName: drill-src`) and must return the same marker and row count.

## Layout and conventions

| Path | Purpose |
|------|---------|
| `.chainsaw.yaml` | assert 15m, exec 10m, cleanup 5m, one drill at a time, fail fast |
| `cnpg-restore/` | the CloudNativePG backup/restore drill above |

- Image tags come from `configuration/versions.yaml` through chainsaw values
  (`task test:drill` writes them with `yq`); never hard-code a tag in a drill.
- Every container has requests/limits and runs non-root; credentials are throwaway values
  for a gateway that exists only inside the drill namespace.
- Chainsaw runs with `--kube-context kind-homelab-localdev`; a new drill needs no Taskfile change.
