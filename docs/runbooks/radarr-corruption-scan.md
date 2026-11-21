# Radarr corrupted-movie scan

A daily CronJob, `media/radarr-corruption-scan` (chart `charts/radarr-config`, script
`charts/radarr-config/files/corruption-scan.sh`), finds movie files that cannot play and has
Radarr replace them.

## What it does

For every movie Radarr reports as having a file (`GET /api/v3/movie`), at the path Radarr
reports (the Job mounts the same movies export read-only at the same `/movies` path):

1. `ffprobe` must open the file and find a video stream.
2. At 5 %, 50 % and 95 % of the duration (`samplePoints`) it demuxes a 10 s window
   (`sampleSeconds`) and requires a video packet at or past the window's start (catches
   truncated files, whose header still claims the full duration), then decodes that window's
   keyframes with `-xerror` (catches a damaged bitstream).

For each corrupt file, through the Radarr API:

1. the most recent grab of the movie is marked failed (`POST /api/v3/history/failed/{id}`),
   which blocklists that release so the search does not fetch it again (`blocklistRelease`),
2. the movie file is deleted (`DELETE /api/v3/moviefile/{id}`; Radarr's recycle bin applies),
3. Radarr's automatic search runs for those movies (`POST /api/v3/command`, `MoviesSearch`).

## Safety guards

| Guard | Value | Effect |
|-------|-------|--------|
| `maxDeletions` | 5 | More corrupt files in one run aborts the run, deleting nothing, and fails the Job (`KubeJobFailed`): that many at once is far likelier a NAS or mount fault |
| `minAgeMinutes` | 360 | Files changed recently are skipped (import or upgrade in progress) |
| missing file | — | Skipped; Radarr's own disk scan handles missing files |
| `probeTimeoutSeconds` | 120 | A probe that times out is inconclusive, never a deletion |
| `dryRun` | false | `true` logs what would be done and changes nothing |

## API key

By default the Job reads `<ApiKey>` from Radarr's `config.xml`: it mounts Radarr's config claim
(`RADARR_CONFIG_PVC`) read-only, and because that claim is ReadWriteOnce the pod has a required
`podAffinity` to the Radarr pod, so it runs on the same node. If Radarr is not running the Job
stays Pending and fails at `activeDeadlineSeconds` (6 h); the next day's run tries again.
To use a Secret instead, set `corruptionScan.apiKeySecret.name` (and `.key`); the config mount
and affinity are then dropped.

## Operating it

```bash
# Run it now (on Kind; production is read-only for agents, ADR-009)
kubectl -n media create job --from=cronjob/radarr-corruption-scan radarr-corruption-scan-manual
kubectl -n media logs -f job/radarr-corruption-scan-manual

# Read the last run on production
kubectl --context homelab-readonly -n media logs job/<latest radarr-corruption-scan job>
```

A run that aborted on `maxDeletions` lists every file it judged corrupt (`CORRUPT:` lines). Check
the movies mount and the NAS first; if the files really are broken, rerun with a higher
`maxDeletions` for that run or let the daily runs work through them.
