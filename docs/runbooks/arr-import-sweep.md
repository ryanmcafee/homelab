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
4. **Non-English removal** (`importSweep.removeNonEnglish`, on in homelab): a matched release whose
   languages, as the app parses the name rewritten to the matched title, are known and exclude
   English is blocklisted and its folder deleted. A release with English among its languages
   (`DUAL`, `MULTi`, `GERMAN.DUBBED.DL`) is kept; `Unknown` is never removed. Blocklisting removes
   the queue item (`DELETE /api/v3/queue/{id}?removeFromClient=true&blocklist=true`), else marks
   the grab failed (`POST /api/v3/history/failed/{id}`, matched by download id, then title); both
   start a replacement search. Without either, the folder is still deleted and the log line is
   `WARN ... NOT blocklisted`. Deletion only removes a real (not symlinked) direct child of the
   category folder, through a read-write mount of the app's downloads volume. The log notes when
   the language was inferred from the series' original language rather than tagged in the name.

Upgrades and every other app rejection stay the app's decision. API calls retry connection errors,
429 and 5xx five times over about two minutes; a command whose POST or poll was lost is looked up
in the app's commands (or its files are checked) before it is ever sent again. The API key is
field `api-key` of Secret `sonarr-api-key` / `radarr-api-key`, a OnePasswordItem from
`SONARR_1P_PATH` / `RADARR_1P_PATH` (default `vaults/homelab/items/sonarr` and `.../radarr`), so
the pod has no node affinity and runs on any worker. The field must equal `<ApiKey>` in the app's
`config.xml`: create the items before the sweep is enabled, and update the item whenever the key is
regenerated in the app's UI (a stale key fails the run with 401; a missing item leaves the pod in
`CreateContainerConfigError`). Without 1Password (`SECRETS_PROVIDER` other than `onepassword`, as
on Kind) the key is read from `config.xml` on the app's ReadWriteOnce config claim instead, with a
podAffinity to the app's node. The TMDb key is `tmdb-api-key` of Secret `plex` (optional).

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
  --app sonarr --url http://localhost:18989 --path /downloads/completed/tv --remove-non-english --dry-run
```

`--dry-run` sends no POST and deletes nothing, and prints `would remove` with the language evidence
and the blocklist action for each non-English release; `--only <text>` limits it to matching
entries. `importSweep.dryRun: true` does the same in the CronJob.

## Entries that stay

| Reason | Action |
|--------|--------|
| `already has a file` | The episode/movie is in the library: delete the folder, or import it by hand as an upgrade |
| `custom format score -10000 < profile minimum 0` | Rejected by the profile (e.g. `Not English`): delete it, or change the profile |
| `best score ... < 60` / `best leads the next by ...` | No unambiguous series/movie: add it or import by hand |
| `no video files the app can import` | Failed or incomplete download: delete the folder |
