# Sonarr/Radarr import sweep

Two CronJobs, `media/sonarr-import-sweep` (chart `charts/sonarr-config`) and
`media/radarr-import-sweep` (chart `charts/radarr-config`), run every 30 minutes and import what
the app left in `/downloads/completed/tv` or `/downloads/completed/movies`. Script:
`files/arr-import-sweep.ts` (identical in both charts, run by `oven/bun`; tests in
`scripts/arr-import-sweep_test.ts`). It runs only where the NFS downloads export exists
(`MEDIA_PROVIDER=nfs`).

## What it does

1. **Automatic pass**: one `DownloadedEpisodesScan` / `DownloadedMoviesScan` (`importMode: Move`)
   per entry. The app treats a scan path as one release, so the parent folder cannot be scanned.
2. **Match pass**, for every entry still there: the app's `/api/v3/parse` gives title, year and
   episodes; each library series/movie is scored on title similarity, year (for a series, the first
   year or the year its episodes aired), TMDb search results, grab history and whether the episodes
   exist and are wanted. Only a single candidate with at least `minScore` (60) that leads the next by
   `minMargin` (20) is used.
3. **ManualImport** (move) of the files `/api/v3/manualimport?folder=` lists, only into monitored
   episodes/movies **without a file**, with a quality the profile allows and a custom format score
   at or above the profile minimum (scored by the app on the name rewritten to the matched title).
   When several releases fill the same episode, the one the profile prefers is imported.

Nothing is deleted by the Job; upgrades and every other app rejection stay the app's decision.
The API key comes from `config.xml` on the app's ReadWriteOnce config claim (podAffinity to the
app's node); the TMDb key is `tmdb-api-key` of Secret `plex` (optional).

## Reading a run

```bash
kubectl -n media logs job/<job>
```

Per entry: `would import` / `imported`, or `left` with the reason (best candidates and scores, or
the file's blocker). The last line counts every outcome. The Job fails (`KubeJobFailed`) only
when a command fails, the API is unreachable or the run passes 50 minutes.

## Dry run

```bash
kubectl -n media port-forward svc/sonarr 18989:8989
ARR_API_KEY=... TMDB_API_KEY=... bun charts/sonarr-config/files/arr-import-sweep.ts \
  --app sonarr --url http://localhost:18989 --path /downloads/completed/tv --dry-run
```

`--dry-run` sends no POST; `--only <text>` limits it to matching entries. `importSweep.dryRun: true`
does the same in the CronJob.

## Entries that stay

| Reason | Action |
|--------|--------|
| `already has a file` | The episode/movie is in the library: delete the folder, or import it by hand as an upgrade |
| `custom format score -10000 < profile minimum 0` | Rejected by the profile (e.g. `Not English`): delete it, or change the profile |
| `best score ... < 60` / `best leads the next by ...` | No unambiguous series/movie: add it or import by hand |
| `no video files the app can import` | Failed or incomplete download: delete the folder |
