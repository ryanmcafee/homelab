# Sonarr episode size cap

The CronJob `media/sonarr-size-policy` (chart `charts/sonarr-config`) runs hourly at minute 11 and
keeps every episode at or below 10 GB (Sonarr's GB, 1024^3 bytes). UHD Blu-ray encodes run 30-40 GB
per episode and are not worth the space. Script: `files/arr-size-policy.ts` (run by `oven/bun` next
to `arr-import-sweep.ts`, whose API client it reuses; tests in `scripts/arr-size-policy_test.ts`).

## What it does

1. Caps every quality definition at `maxMbPerMinute` (170 MB/min, 10 GB for 60 minutes). Sonarr
   multiplies it by the runtime of every episode in a release, so season packs are capped per
   episode.
2. Ensures a custom format `Oversize` (Size > 10 GB and Release Type single episode) scored
   `-10000` in every profile: a hard cap for single episodes whatever their runtime. Season packs
   are left to step 1, because the Size condition measures the whole release.
3. Removes larger queued downloads from the download client and blocklists them; Sonarr searches
   for another release.
4. Replaces up to `replaceLimit` (5) larger episode files per run, largest first. An interactive
   search must return a release within the cap that only the existing file rejects; then the file
   is deleted and an `EpisodeSearch` grabs the replacement. Without such a release the file stays
   and the log says `no release within the cap, file kept`.

Sonarr has no recycle bin configured, so step 4 deletes for good; the episode is missing until the
replacement imports. A compliant app gets no write.

## Configuration

`sizePolicy` in `charts/sonarr-config/values.yaml`: `enabled`, `schedule`, `dryRun`,
`maxEpisodeGB`, `maxMbPerMinute`, `format.{name,score}`, `replaceLimit` (0 stops replacing files),
`searchTimeoutSeconds`.

## Operate

```bash
kubectl -n media logs job/<name>                         # one line per change, then a summary
kubectl -n media create job --from=cronjob/sonarr-size-policy sonarr-size-policy-now
ARR_URL=http://localhost:8989 ARR_API_KEY=... bun charts/sonarr-config/files/arr-size-policy.ts --dry-run
```

| Log | Meaning |
|-----|---------|
| `N episode files larger than 10 GB` | Still to replace; drops by up to `replaceLimit` per run |
| `no release within the cap, file kept` | Nothing smaller is indexed yet; retried next run |
| `quality X minimum ... exceeds the cap` | Lower that quality's minimum size or raise `maxMbPerMinute` |
| `done: 0 changes, 0 failed` | Compliant |
