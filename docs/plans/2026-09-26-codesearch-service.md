# Cluster-wide codesearch service

Tracking: bd epic `homelab-3m8`. Supersedes the per-session wrapper first pushed to PR #422.

## Goal

One `codesearch serve` for the whole cluster, reached over streamable HTTP MCP at
`http://codesearch.codesearch.svc.cluster.local:39725/mcp`, so any agent (Paperclip first) can
search code without running codesearch itself.

## Decisions

| Topic | Decision | Why |
|-------|----------|-----|
| Source code | codesearch clones a configured list of git repositories onto its own PVC, fetches them on an interval and asks serve for an incremental reindex | A cluster service cannot read other pods' volumes; indexes the default branch only |
| Access | NetworkPolicy only: namespaces labelled `codesearch-client: "true"`, plus `monitoring` | User choice. serve refuses a network bind without `CODESEARCH_SERVE_API_KEY` and then demands it on every route, so serve binds `127.0.0.1:39726` and a `socat` container forwards `0.0.0.0:39725` to it |
| Host check | `CODESEARCH_ALLOWED_HOSTS=codesearch,codesearch.codesearch,codesearch.codesearch.svc,codesearch.codesearch.svc.cluster.local,localhost,127.0.0.1` | `/mcp` rejects any Host not listed (exact match) |
| Tier / wave | addons, wave 13 (after argo-workflows 12, before applications) | Gate workflows and alerts on `argo-workflows.enabled` / `codesearch.enabled`; CRD order rule needs wave >= 13 for Argo CRs |
| Image | `ghcr.io/<owner>/homelab-codesearch`, `Dockerfile.codesearch`, `images.codesearch` pin, codesearch binary from `tools.codesearch` release (sha256-checked), model baked in, bun for the helper scripts, `STOPSIGNAL SIGINT` | No upstream image; glibc >= 2.39 needs debian trixie; serve only handles SIGINT |
| Storage | one PVC (`STORAGE_CLASS_ISCSI_SSD`, `Prune=false,Delete=false`): `/data/home` (HOME, `~/.codesearch`) and `/data/repos/<name>` (clones + in-repo `.codesearch.db`) | LMDB + tantivy want block storage; RWO, Deployment `Recreate`, 1 replica (MCP sessions are in memory) |
| Backup | Argo `CronWorkflow` daily: `mdb_copy` of the embedding cache + `repos.json` into a tarball, output artifact to a dedicated `codesearch-backups` bucket on the argo-workflows versitygw store, excluded from the 30-day log retention; own retention (keep N) | No VolumeSnapshot CRDs and no pause API: only LMDB (via `mdb_copy`) can be copied consistently while serve runs. Indexes are derived; the cache makes rebuilding cheap |
| Restore | Argo `WorkflowTemplate` `codesearch-restore` (param: backup key, default latest): stage the tarball on the PVC, delete the codesearch pod; an init container swaps the staged cache in before serve starts; sync then re-registers and force-reindexes every repo from the cache | Never replace files under a running serve |
| Metrics | ServiceMonitor on `/metrics` through the forwarder | Native Prometheus endpoint; no auth on loopback bind |
| Alerts | `homelab-codesearch` group in `additionalPrometheusRulesMap` with promtool tests | Repo convention (`task test:alerts`) |
| Paperclip | MCP entry `{"type":"http","url":".../mcp"}`; paperclip namespace gets the client label and an egress NetworkPolicy to codesearch:39725; the in-pod codesearch install and `codesearch-mcp.ts` wrapper are removed | No codesearch process per agent session |

## Components

1. `Dockerfile.codesearch`, `codesearch/` (bun TS: `sync.ts`, `backup.ts`, `restore.ts` + unit tests), `.github/workflows/codesearch-image.yml` (amd64, PR build, main publish, smoke on read-only rootfs).
2. `charts/codesearch/`: Deployment (init `restore-swap`; containers `serve`, `proxy`, `sync`), Service, PVC, NetworkPolicy, ServiceMonitor, CronWorkflow, WorkflowTemplate, RBAC (workflow SA: `workflowtaskresults`; restore: delete pods in namespace), OnePasswordItems (artifacts; optional git token).
3. `charts/addons/templates/codesearch.yaml` + values; `configuration/`: `CODESEARCH_ENABLED`, `CODESEARCH_REPOS` (comma-separated https URLs), `CODESEARCH_GIT_1P_PATH` (optional, `GIT_TOKEN`), `images.codesearch`; `helm-addons.tmpl` block.
4. argo-workflows-dependencies: create `codesearch-backups` bucket, exclude it from log retention.
5. Alerts: `CodesearchDown`, `CodesearchDegraded`, `CodesearchRepoIndexFailing`, `CodesearchToolCallsSlow`, `CodesearchBackupMissing` (Argo custom metric `codesearch_backup_last_success_timestamp_seconds`), tests in `tests/alerts/codesearch.test.yaml`.
6. Localdev: enabled with a small repo list; `scripts/localdev-kind.ts` builds and `kind load`s the image when `images.codesearch` is not yet published; e2e `tests/e2e/codesearch` (Healthy + MCP initialize + a search hit); drill `tests/drills/codesearch-restore` (backup and restore commands as Jobs, then search works).
7. Paperclip rewiring (above) + tests + docs.
8. Docs: `docs/apps/codesearch.md`, `docs/runbooks/codesearch.md` (alerts, backup, restore, adding repos, onboarding a client namespace), `docs/runbooks/alerting.md` rows, `docs/runbooks/triage-agent.md` codesearch line, `task docs:check -- --fix`.

## Verification

Level 0 (`task verify:text`), `task test:alerts`, `task test:scripts`, codesearch unit tests, image smoke, Kind loop level 2 with the e2e suite and the restore drill, then production after merge: pod Ready, repos indexed, Paperclip `claude mcp list` shows codesearch connected, first backup artifact present, restore workflow run once.

## Revision 2026-09-26: upstream image and chart

The image and Helm chart are now owned and published by https://github.com/ryanmcafee/codesearch
(`ghcr.io/ryanmcafee/codesearch`, chart `codesearch` at `https://ryanmcafee.github.io/codesearch`).
Homelab consumes them: `charts.codesearch` in `versions.yaml` (Renovate-managed), an addons
Application for the upstream chart (values from `helm-addons.tmpl`), and a
`charts/codesearch-dependencies` child chart for what stays homelab-specific (1Password items, Argo
backup CronWorkflow and restore WorkflowTemplate, RBAC). The upstream chart provides the loopback +
forwarder auth mode, repo sync, ServiceMonitor, PrometheusRule, Grafana dashboard and runbooks;
homelab keeps only `CodesearchBackupMissing`. This PR cannot merge before the upstream release is
published.
