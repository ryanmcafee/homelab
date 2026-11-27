# Sonarr/Radarr release policy (no remux)

Two CronJobs, `media/sonarr-release-policy` (chart `charts/sonarr-config`) and
`media/radarr-release-policy` (chart `charts/radarr-config`), run hourly at minute 41 and keep
remux releases out of both apps. Remuxes are untouched Blu-ray streams (often 30-80 GB per
movie) and are not worth the space. Script: `files/arr-release-policy.ts` (identical in both
charts, run by `oven/bun` next to `arr-import-sweep.ts`, whose API client it reuses; tests in
`scripts/arr-release-policy_test.ts`).

## What it does

1. Ensures a custom format `Remux` with one release title specification `remux` (the apps match it
   case-insensitively). A format of that name with other specifications is overwritten.
2. In every quality profile:
   - scores `Remux` at `-10000`, below the profile minimum (0), so the app rejects every release
     whose title contains `remux`, whatever quality it parses;
   - disallows every quality whose name contains `remux` (`Remux-1080p`, `Remux-2160p` in Radarr;
     `Bluray-1080p Remux`, `Bluray-2160p Remux` in Sonarr);
   - moves a cutoff that pointed at a disallowed quality to the best allowed one below it.

A compliant app gets no write, so UI edits that re-allow remux are reverted within the hour.
Files already in the library are not deleted; on a profile with upgrades enabled, the app replaces
them when a smaller allowed release appears.

## Configuration

`releasePolicy` in `charts/{sonarr,radarr}-config/values.yaml`: `enabled`, `schedule`, `dryRun`
and `banned.{formatName,titleRegex,qualityRegex,score}`. App, URL, API key source, config claim,
user and image come from the chart's `importSweep` block.

## Operate

```bash
kubectl -n media logs job/<name>                       # one line per change, then a summary
kubectl -n media create job --from=cronjob/radarr-release-policy radarr-release-policy-now
ARR_URL=http://localhost:7878 ARR_API_KEY=... bun charts/radarr-config/files/arr-release-policy.ts --dry-run
```

| Log | Meaning |
|-----|---------|
| `profile X would have no allowed quality` | Every allowed quality in X is a remux: allow a non-remux quality in X, or delete X |
| `done: N profiles, 0 updated, 0 failed` | Already compliant |
