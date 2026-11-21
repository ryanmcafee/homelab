# Sonarr/Radarr import sweep

Two CronJobs, `media/sonarr-import-sweep` (chart `charts/sonarr-config`) and
`media/radarr-import-sweep` (chart `charts/radarr-config`), run every 30 minutes and ask the app
to import every release left in `/downloads/completed/tv` or `/downloads/completed/movies`.
Script: `files/import-sweep.sh` (identical in both charts).

## What it does

The app treats a scan path as a single release, so the Job sends one
`POST /api/v3/command` per entry (`DownloadedEpisodesScan` / `DownloadedMoviesScan`,
`importMode: Move`) and polls `GET /api/v3/command/<id>` until it ends. An accepted release is
moved into the library and its folder removed. The API key is read from `config.xml` on the app's
config claim, mounted read-only (the pod has a podAffinity to the app's node, since the claim is
ReadWriteOnce). It runs only where the NFS downloads export exists (`MEDIA_PROVIDER=nfs`).

## Reading a run

```bash
kubectl -n media logs job/<job> | tail
```

Each entry logs `moved`, `left` or `FAILED`; the last line counts entries before and after.
The Job fails (`KubeJobFailed`) only when a command fails, the API is unreachable or the run
passes 50 minutes; a rejected release is `left`, not a failure.

## Entries that stay

A `left` entry was rejected by the app; the reason is in its debug log
(`/config/logs/*.debug.txt`) and in Activity -> Queue -> Manual Import. Seen so far:

| Reason | Action |
|--------|--------|
| `Unknown Series` / unknown movie | Add the series or movie, or delete the folder |
| `Not a Custom Format upgrade` | The library already has an equal or better file: delete the folder |
| `0 video files were found` | Failed or incomplete download: delete the folder |
