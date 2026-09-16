# Verification Overhaul — Sections C + D: previews, read-only prod, upgrades, drills, scaffolder, agent contract

> **For agentic workers:** each work package (WP) below is owned by exactly one subagent. Steps use
> checkbox (`- [ ]`) syntax. Read "Global Constraints" and "Cross-package interfaces" before starting.

**Goal:** Finish issue #261 (items 16–22) in a single PR: per-PR preview environments on the homelab
cluster, a sticky Kind report on every PR, read-only production access for agents over Tailscale plus
ArgoCD deploy notifications, Renovate-aware upgrade verification with an automerge gate, a weekly
CloudNativePG restore drill, an app scaffolder, and the verification contract wired into the agent loop
(PostToolUse hook, PR-body claim checked by CI, gitops-test skill rewritten around it).

**Spec:** https://github.com/ryanmcafee/homelab/issues/261 (Sections C and D) + ADR-009..012 in
`docs/project_notes/decisions.md`. Sections A (PR #264) and B (PR #270) are merged.

**Worktree:** `$HOME/Projects/homelab-issue-261-cd`, branch `feat/issue-261-sections-c-d`,
branched from `origin/main` (68abdbf). Never touch `$HOME/Projects/homelab` (the main checkout).

## Global Constraints

- Work only inside the worktree. Prepend `$HOME/.local/share/mise/shims` to `PATH` in every shell
  (`go`, `helm`, `deno`, `task`, `kubectl`, `argocd`, `chainsaw`, `kind`, `yq`, `conftest` are mise-managed;
  helm is pinned to 4.3.0 and the golden snapshots are byte-exact against it).
- Serena is rooted at the main checkout, not this worktree: use Read/Edit/Write/Bash for files here.
- Forbidden CLI: `grep`, `find`, `cat`, `ls` in scripts/docs you write (`rg`, `rg --files`, `sed -n` are fine
  for your own exploration). `eza`, `fd`, `bat` are not installed.
- TypeScript (Deno) for every script (ADR-005). Shebang `#!/usr/bin/env -S deno run --allow-...` with the exact
  permissions, `--help`, `--dry-run` where anything is mutated, colour log helpers (cyan INFO, green OK,
  red ERROR, yellow WARN), exit 0/1 (2 = usage). Pure logic in exported functions with
  `scripts/<name>_test.ts`; CI runs `deno fmt --check scripts/`, `deno check scripts/*.ts`, `deno test scripts/`.
- Go: cobra commands in `cmd/homelab/commands`, exit codes from `exitcode.go` (`ExitOK/ExitFailure/ExitUsage`,
  `NewUsageError`), reuse the **global** `--dry-run` (`commands.DryRun`) — never define another. Table-driven
  tests. The JSON contract is `internal/verify/types.go` `Result{level, checks[], pass, duration_ms}` /
  `Check{name, status pass|fail|skip, duration_ms, detail?, findings?}`. Check exit codes with a built
  binary (`go build -o bin/homelab ./cmd/homelab`), not `go run` (it collapses exit codes to 1).
- **Never** regenerate `tests/snapshots/**` or run `task test:snapshot -- --update` — the integrator does that
  once. Judge your work with `task verify:text` ignoring `snapshot/*` and `render/localdev/_committed-values`
  failures caused by template changes. Exceptions are stated per WP (schemas for your own new CRD source;
  WP-D may regenerate the committed localdev values to sync its addon in Kind).
- Every rendered Application: finalizer `resources-finalizer.argocd.argoproj.io`, numeric sync-wave,
  `ServerSideApply=true`, `automated` wrapped in `{{- if .Values.global.automatedSync }}`; every container:
  cpu+memory requests and limits; no `:latest`; no inline secrets (Secret data keys only
  `name,url,type,enableOCI,project,insecure`); hostnames under the env domain (`tests/policy/`).
- Versions: `configuration/versions.yaml` is the single source of truth, each entry with a Renovate marker
  (`# renovate: datasource=... depName=... [registryUrl=...]` on the line above, value double-quoted).
  Workflow tool pins mirror it with Renovate markers.
- ADR-009: agents may mutate **only Kind**. Nothing in this PR applies anything to production; production
  changes happen after merge through ArgoCD. Human-only steps (GitHub App, 1Password items, Tailscale ACL
  grants, repo settings) are documented, never performed.
- Shared worktree, seven agents in parallel. Each WP owns the files listed under it. For the few shared files
  (named per WP) **re-read immediately before every edit**, keep edits local (append a block or change a
  line; never reformat or reorder), and never revert someone else's change. If the Go build breaks in a file
  you do not own, wait and retry (another WP is mid-edit); do not fix it — report it.
- Do not commit, push or open PRs. Do not create or delete Kind clusters unless your WP says so.
- Finish with a report: files created/modified, commands run and their results, anything left open.

## Task contract (pre-added to Taskfile.yml by the integrator — edit only your own tasks)

| Task | Command | Owner |
|---|---|---|
| `localdev:report` | `deno run ... scripts/localdev-argocd.ts report {{.CLI_ARGS}}` | WP-R |
| `drill:restore` | `localdev:kind` → `localdev:argocd` → `localdev:sync -- --warm` → `test:drill` | WP-D |
| `test:drill` | chainsaw over `tests/drills/` with the image values from `versions.yaml` | WP-D |
| `scaffold` | `go run ./cmd/homelab scaffold {{.CLI_ARGS}}` | WP-S |
| `test:scaffold` | `deno run ... scripts/scaffold-selftest.ts {{.CLI_ARGS}}` | WP-S |
| `verify:upgrade` | `go run ./cmd/homelab verify upgrade {{.CLI_ARGS}}` | WP-U |
| `verify:prod` | `go run ./cmd/homelab verify prod --kube-context homelab-readonly {{.CLI_ARGS}}` | WP-A |
| `prod:kubeconfig` / `prod:status` / `prod:diff` | `deno run ... scripts/prod-readonly.ts <sub> {{.CLI_ARGS}}` | WP-A |
| `verify:claim` | level-0 JSON piped into `scripts/verify-claim.ts render` | WP-C |

## Cross-package interfaces

- **Preview mode (WP-P)** is `global.preview.pr` (string, empty = off) + `global.preview.apps`
  (comma-separated) in `charts/applications`, set by the CMP from plugin env `PREVIEW_PR` / `PREVIEW_APPS`.
  Preview Applications live in namespace `preview-<pr>` (ArgoCD "apps in any namespace",
  `application.namespaces: preview-*`), project `previews`, names `<app>-pr<pr>`, hostnames
  `<app>-pr<pr>.<domain>`. Level 0 renders it as env `homelab-preview` (applications chart only).
- **ArgoCD bootstrap values** (`charts/bootstrap/values-homelab.yaml`) are shared by WP-P
  (`configs.params."application.namespaces"`) and WP-A (`configs.cm` accounts, `configs.rbac`,
  `notifications`). Re-read before editing.
- **`charts/gitops`** is shared by WP-P (new `templates/previews-*.yaml`, `previews:` values) and WP-A
  (notification subscription annotations on `templates/{addons,applications,bootstrap}.yaml`,
  `notifications:` values). Different files/keys.
- **Addons** (`charts/addons/values.yaml`, `configuration/templates/helm-addons.tmpl`) are shared by WP-D
  (`cnpg-barman-cloud` block) and WP-A (`agentReadonly` block, tailscale `apiServerProxyConfig`). Append new
  blocks next to related ones; re-read before editing.
- **`tests/schemas/sources.yaml`** is shared by WP-P (add `ApplicationSet` to the argo-cd source kinds) and
  WP-D (new `plugin-barman-cloud` source). Each runs `task schemas:vendor -- --only <its source>` only.
- **`tests/gitops/*.yaml`** registries: WP-D adds `barmancloud.cnpg.io: cnpg-barman-cloud`.
- **`cmd/homelab/commands/verify.go`** (subcommand registration) is shared by WP-U (`upgrade`) and WP-A
  (`prod`): one `AddCommand` line each. `cmd/homelab/main.go` is WP-S only (`scaffold`).
- **Sticky comment headers** (marocchino/sticky-pull-request-comment, same pin as `verify.yml`):
  `snapshot-diff` (exists), `kind-preview` (WP-R), `upgrade-diff` (WP-U), `verify-claim` (WP-C).
- **Automerge gate** (WP-U): commit status context `upgrade/automerge-gate` on `renovate/*` branches.
- **Regeneration bot identity** (WP-U): commits authored by
  `homelab-regen-bot <homelab-regen-bot@users.noreply.github.com>`, listed in Renovate `gitIgnoredAuthors`.
- Docs owned by the integrator: `docs/project_notes/*`, `CLAUDE.md`, `docs/runbooks/verification.md`
  (WPs send the text they want added in their report; WP-U and WP-C may edit the sections named in their WP).

---

## WP-P: Per-PR preview environments (item 16)

**Files:** Create `charts/gitops/templates/previews-appproject.yaml`, `charts/gitops/templates/previews-applicationset.yaml`,
`charts/applications/templates/_preview.tpl`, `tests/policy/applicationset.rego` (+ `_test.rego`, negative fixture under
`tests/policy/negative/`), `docs/runbooks/previews.md`. Modify `charts/gitops/values.yaml`, `charts/gitops/values-homelab.yaml`,
`charts/gitops/values-localdev.yaml` (previews off), every template in `charts/applications/templates/`,
`charts/applications/values.yaml` (`global.preview` defaults), `cmp/plugin.yaml`, `charts/bootstrap/values-homelab.yaml`
(one key, shared), `tests/schemas/sources.yaml` (shared), `internal/verify/{render,snapshot,gitops,policy}.go` + tests for the
`homelab-preview` env, `cmd/homelab/commands/verify_*.go` only if env parsing needs it.

- [ ] **P1 ApplicationSet + AppProject** (homelab only, `previews.enabled`, false in base/localdev). ApplicationSet `previews`
  (`argocd`, `goTemplate: true`, `goTemplateOptions: ["missingkey=error"]`) with a `pullRequest.github` generator
  (`owner`/`repo` = `github.com/ryanmcafee/homelab`, `labels: [preview]`, `requeueAfterSeconds: 300`, optional `tokenRef` from
  `previews.github.tokenSecret` — the repo is public, anonymous works). Template: Application `preview-pr{{.number}}` in
  `argocd`, project `previews`, finalizer, sync-wave, source `global.repoUrl` @ `{{.head_sha}}`, path `charts/applications`,
  plugin `homelab-config-helm-v1.0` env `ENVIRONMENT=homelab`, `FORMAT=helm-apps`, `PREVIEW_PR={{.number}}`,
  `PREVIEW_APPS=<labels "preview:<app>" joined by ",">` (empty → chart default), destination `preview-{{.number}}`,
  automated prune+selfHeal, `CreateNamespace=true`, `ServerSideApply=true`, `managedNamespaceMetadata` PSA labels
  (`baseline`). Escape the ApplicationSet `{{ }}` from Helm (backtick strings). AppProject `previews`: `sourceRepos`
  = repo + `oci.trueforge.org/truecharts`; `destinations` = in-cluster `preview-*` only; `sourceNamespaces: [preview-*]`;
  `clusterResourceWhitelist` = Namespace only; `namespaceResourceWhitelist` = the kinds a preview actually renders
  (derive them from `helm template oci://oci.trueforge.org/truecharts/sonarr --version <versions.yaml>` with the rendered
  values; include `argoproj.io/Application`, `batch/Job`, core, apps, networking, traefik.io, cert-manager.io,
  `ResourceQuota`, `LimitRange`); explicitly no `onepassword.com`. Add
  `configs.params."application.namespaces": "preview-*"` to `charts/bootstrap/values-homelab.yaml`.
- [ ] **P2 Preview mode in `charts/applications`.** `global.preview: {pr: "", apps: "", allowedApps: [sonarr, radarr,
  prowlarr, nzbget, tautulli, lazylibrarian, flaresolverr], defaultApps: [sonarr], storageSize: 1Gi, quota: {...}}`.
  Helpers in `_preview.tpl`: enabled; `appName` (`<app>` or `<app>-pr<pr>`); Application metadata namespace (`argocd` or
  `preview-<pr>`); destination namespace; `project` (`default`/`previews`); `appEnabled` (normal: `.enabled`; preview:
  enabled ∧ in (apps or defaultApps) ∧ in allowedApps); host rewrite (`<x>.<domain>` → `<x>-pr<pr>.<domain>` with
  `regexReplaceAll` on the rendered inline values); TrueCharts persistence transform (drop `existingClaim`, set size +
  storage class, NFS mounts → `emptyDir`). In preview mode: only the selected main Applications render (no `*-config`
  children, no `oci-repositories.yaml`, no prod namespaces, no renovate/duckdns/plex/homeassistant/mosquitto);
  `namespaces.yaml` renders `Namespace preview-<pr>` + `ResourceQuota` + `LimitRange`; smoke Jobs target the preview
  namespace (rewrite `.<ns>.svc` in the URL). Normal render must stay byte-identical except where a helper replaced a
  literal (verify: `task verify:text` → the `snapshot/*/applications` diffs must be empty for localdev and homelab).
- [ ] **P3 CMP.** `cmp/plugin.yaml`: validate `ARGOCD_ENV_PREVIEW_PR` (`^[0-9]+$` or empty) and `ARGOCD_ENV_PREVIEW_APPS`
  (`^[a-z0-9,-]*$`), exit 1 otherwise; when set append `--set-string global.preview.pr=...` and
  `--set-string global.preview.apps=<commas escaped as \,>` to `helm template`. POSIX sh only (no bash-isms).
- [ ] **P4 Level 0.** New env `homelab-preview`: the homelab two-stage render of **only** `charts/applications` plus
  `--set-string global.preview.pr=123 --set-string global.preview.apps=<all allowedApps>`; runs render, lint, kubeconform,
  pluto, policy, snapshot (`tests/snapshots/homelab-preview/applications.yaml` — the integrator generates it) and the
  gitops rules that make sense (`unique-names`, `namespaces`, `paths`, `waves`; `repo-secrets` reports `skip` with detail
  "provided by the homelab env"). Included in `verify all` by default (`--env` accepts it). Add `ApplicationSet` to the
  argo-cd kinds in `tests/schemas/sources.yaml` and run `task schemas:vendor -- --only argo-cd`. Rego for
  ApplicationSet templates (finalizer, SSA, project ≠ default, automated) with unit tests and one negative fixture.
- [ ] **P5 Docs.** `docs/runbooks/previews.md`: how to request (`preview` + `preview:<app>` labels), URLs, teardown (close
  or unlabel), limits (quota, fresh storage, no 1Password, no CRD/operator installs — vcluster not implemented; say so),
  trust model (maintainer-applied label; fork PRs run code from the fork in the homelab cluster).
- [ ] **P6 Verify.** `go test ./internal/verify/... ./cmd/...`, `conftest verify -p tests/policy`, `task test:policy`,
  `task verify:text` (only snapshot/committed-values failures), `helm template` of the gitops chart for homelab shows the
  ApplicationSet/AppProject; `sh -n cmp/plugin.yaml`-equivalent check of the script (extract and run `sh -n`).

## WP-R: Kind report + sticky PR comment (item 17)

**Files:** Modify `scripts/localdev-argocd.ts`, `scripts/localdev-argocd_test.ts`, `.github/workflows/tilt-ci.yml`.

- [ ] **R1 `report` subcommand.** `--out <md>` (default stdout), `--verify-json <file>`, `--max-diff-bytes 50000`,
  `--no-diff`. Reads Applications (`kubectl --context kind-homelab-localdev -n argocd get applications.argoproj.io -o json`),
  and for every Application whose `status.sync.status != Synced` runs `argocd app diff <app> --exit-code=false`
  (reuse the script's existing port-forward/login helpers). Because the root app targets GitHub `main` and the tree is
  synced with `--local`, that diff is exactly **PR head vs `main`**; child chart Applications show spec changes on their
  parent — say so in the report. Markdown: title "Kind preview (level 2)", pass/fail line from the verify JSON, table
  `| Application | Health | Last operation | vs main |`, failing level-2 checks with findings, then one collapsed
  `<details>` per app diff (```diff```), truncated with a note. Export pure `renderReport`, `statusRows`,
  `truncateDiffs`; unit-test them with fixture JSON.
- [ ] **R2 Workflow.** `kind-argocd`: job permissions `contents: read`, `pull-requests: write`; after the verify/summary
  steps, `if: always() && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository`:
  `task localdev:report -- --out kind-report.md --verify-json verify-level2.json` (continue-on-error), append to the job
  summary, sticky comment header `kind-preview`, upload `kind-report.md` with the level-2 artifact. When `localdev:ci`
  failed before ArgoCD was reachable the report says so instead of failing.
- [ ] **R3 Verify.** `deno fmt/check/test` on the script; `yamllint -c .yamllint .github/workflows/tilt-ci.yml`;
  `actionlint` if installed. Do not run against a cluster (the integrator runs the loop).

## WP-A: Read-only production access + deploy notifications (item 18)

**Files:** Create `charts/agent-readonly/{Chart.yaml,values.yaml,values-homelab.yaml,values-localdev.yaml,templates/*}`,
`charts/addons/templates/agent-readonly.yaml`, `scripts/prod-readonly.ts` (+ `_test.ts`),
`internal/verify/prod.go` (+ test) or reuse in `cluster.go`, `cmd/homelab/commands/verify_prod.go` (+ exit tests),
`tests/e2e/agent-readonly/chainsaw-test.yaml`, `docs/runbooks/readonly-access.md`. Modify
`charts/addons/templates/tailscale-operator.yaml`, `charts/addons/values.yaml` + `configuration/templates/helm-addons.tmpl`
(shared), `charts/bootstrap/values-homelab.yaml` (shared) and the bootstrap template only if needed for the
OnePasswordItem, `charts/gitops/templates/{addons,applications,bootstrap}.yaml` + `charts/gitops/values*.yaml`
(`notifications` key, shared), `cmd/homelab/commands/verify.go` (one line), `configuration/schema/*.schema.yaml` only for
new keys (each must be referenced by a template — contract test).

- [ ] **A1 RBAC chart.** Namespace `agent-access` (addon template, baseline PSA), ServiceAccount `agent-readonly`, Secret
  `agent-readonly-token` (`type: kubernetes.io/service-account-token`, annotation `kubernetes.io/service-account.name`),
  ClusterRoleBinding to the built-in `view`, ClusterRole `homelab-agent-readonly` (get/list/watch on nodes, namespaces,
  persistentvolumes, storageclasses, ingressclasses, customresourcedefinitions, events, and the CR groups this repo uses:
  argoproj.io, cert-manager.io, traefik.io, cilium.io, postgresql.cnpg.io, barmancloud.cnpg.io, monitoring.coreos.com,
  onepassword.com, tailscale.com, externaldns.k8s.io) + binding; **no** secrets, no write verbs. Bind the same roles to
  Group `homelab:agent-readonly` (future Tailscale impersonation). Enabled in both envs (Kind proves the RBAC).
- [ ] **A2 Tailscale.** `apiServerProxyConfig.mode: "noauth"` (the proxy forwards the caller's bearer token; the
  kube-apiserver authorises it as the ServiceAccount). Document the human ACL step (grant the agent device/tag access to
  `tag:k8s-operator:443`; `policy.sops.hujson` is SOPS-encrypted — never edit it here).
- [ ] **A3 ArgoCD.** In `charts/bootstrap/values-homelab.yaml` under `argocd.values`: `configs.cm."accounts.agent": apiKey`,
  `configs.rbac."policy.csv": "g, agent, role:readonly"` (keep any existing rbac). GitHub notifications, all gated by one
  flag (`argocd.notificationsGithub.enabled`, default **false** — the GitHub App does not exist yet): `notifications.notifiers`
  `service.github` (appID/installationID/privateKey from `$github-*` keys), templates `app-deployed`, `app-sync-failed`,
  `app-health-degraded` with `github.status` (context `argocd/<app>`) and `github.pullRequestComment` (deploy status on the
  PR that produced the synced revision), triggers `on-deployed` (oncePer revision), `on-sync-failed`,
  `on-health-degraded`; `notifications.secret.create: false` + a `OnePasswordItem argocd-notifications-secret` in `argocd`
  (item path from values); subscription annotations on the `bootstrap`, `addons`, `applications` Applications in
  `charts/gitops` when `notifications.github: true` (gitops values; default false). Health Lua exists for OnePasswordItem.
- [ ] **A4 `homelab verify prod`.** `--kube-context` (required, default `homelab-readonly`; refuse `kind-*` with a usage
  error — that is what level 2 is for), `--json`. Runs only the read-only Application-state check with names
  `prod/argocd/<app>` (reuse `ArgoCDApps` from `internal/verify/cluster.go` with a name prefix), `Result.Level = 2`.
  Tests with the fake runner + exit-code tests.
- [ ] **A5 `scripts/prod-readonly.ts`.** `kubeconfig` (reads the token with `op read <ref>` default
  `op://homelab/k8s-agent-readonly/credential`, `--server https://<hostname>.<tailnet>.ts.net` from `--tailnet` +
  `--hostname tailscale-operator`, writes `~/.kube/homelab-readonly.yaml` mode 0600 with context `homelab-readonly`,
  `--dry-run` prints it with the token redacted), `status` (Application table via that context), `diff <app>`
  (`argocd app diff <app> --server <argocd host> --auth-token $(op read ...)` read-only account; `--grpc-web`). Export
  `renderKubeconfig` and unit-test it (no token in logs).
- [ ] **A6 e2e.** `tests/e2e/agent-readonly`: assert the Application Healthy; script steps with
  `kubectl auth can-i --as=system:serviceaccount:agent-access:agent-readonly` — yes for `list pods -A`,
  `get applications.argoproj.io -n argocd`, `list customresourcedefinitions`; no for `get secrets -A`, `create configmaps`,
  `delete pods`. Follow `tests/e2e/README.md`.
- [ ] **A7 Docs.** `docs/runbooks/readonly-access.md`: what exists, the human steps (ACL grant, `kubectl create token`/token
  Secret → 1Password, `argocd account generate-token --account agent` → 1Password, GitHub App + 1Password item + flipping
  the two notification flags), and the agent commands (`task prod:kubeconfig`, `task verify:prod`, `task prod:status`,
  `task prod:diff -- <app>`).
- [ ] **A8 Verify.** `go test`, `task verify:text` (snapshot/committed-values failures only), `deno fmt/check/test`,
  `helm template charts/agent-readonly`. No cluster.

## WP-U: Renovate-aware upgrade verification (item 19)

**Files:** Create `internal/verify/upgrade.go` (+ `_test.go`), `cmd/homelab/commands/verify_upgrade.go` (+ tests),
`.github/workflows/upgrade.yml`. Modify `.github/renovate.json5`, `cmd/homelab/commands/verify.go` (one line),
`docs/runbooks/verification.md` section "Renovate bumps" only.

- [ ] **U1 `homelab verify upgrade --base <ref>`** (`--env homelab` default, `--json`, `--report <md>`, `--keep`,
  `--max-diff-lines 400`). Render the base ref in a temporary `git worktree add --detach` (removed afterwards unless
  `--keep`) and the working tree with the existing render pass. Collect every `Application` (all charts, both renders)
  whose source is a Helm chart (`spec.source.chart` or `spec.sources[].chart`): repoURL, chart, targetRevision,
  `helm.values`/`valuesObject`/`parameters`, releaseName, destination namespace. For each app whose chart source differs
  (added, removed, version or values changed) run `helm template` of the upstream chart at base and at head (OCI repos as
  `oci://<repoURL>/<chart>`, others with `--repo`), `--include-crds`, namespace, release name, values; normalise
  (drop `helm.sh/chart` and `app.kubernetes.io/version` labels) and diff with the existing `labelledDiff`. Checks
  `upgrade/<env>/<app>`: `pass` with detail `unchanged` or `manifest diff: +A -D lines` (+ findings = diff lines, capped),
  `fail` when the head render fails, `skip` when the base render fails. List CRDs whose spec changed in the detail.
  Markdown report: summary table + one `<details>` per changed app. Runner abstraction for git/helm; tests with fakes
  (extraction, normalisation, OCI vs https args, report).
- [ ] **U2 Workflow `upgrade.yml`** (pull_request on `configuration/versions.yaml`, `charts/**`; same pins/renovate
  markers as `verify.yml`): `fetch-depth: 0`; `task verify:upgrade -- --base origin/<base> --json --report upgrade-report.md`;
  then re-extract CRD schemas into the runner tree (`task schemas:vendor`) and re-run `go run ./cmd/homelab verify render
  --env homelab --env localdev --json` to prove every CR still validates against the new CRDs (nothing committed);
  append that result to the report; sticky comment `upgrade-diff`; job fails when any `upgrade/*` or render check fails.
  On `renovate/*` heads set commit status `upgrade/automerge-gate` on the head SHA (`statuses: write`): `success`
  ("no rendered manifest changes") when every upgrade check is `unchanged` and revalidation passed, else `failure`
  ("rendered manifests changed — human review required, automerge blocked").
- [ ] **U3 Regeneration** (job `regenerate`, only `renovate/*` heads, only when secrets `HOMELAB_BOT_APP_ID` and
  `HOMELAB_BOT_PRIVATE_KEY` exist — otherwise a `::notice::` and exit 0): mint a token with
  `actions/create-github-app-token` (pin by SHA), check out the head branch with it, run `task config:export:localdev`,
  `task schemas:vendor`, `task test:snapshot -- --update`, commit as the regeneration bot identity
  (`chore(deps): regenerate snapshots, schemas and localdev values`) and push. Skip when nothing changed or the head
  commit is already the bot's (loop guard). An App-token push triggers the other workflows, unlike `GITHUB_TOKEN`.
- [ ] **U4 Renovate.** Fix the pre-existing hazard: the patch rule sets `platformAutomerge: true` while the `main` ruleset
  requires no status checks, so GitHub platform automerge would merge without waiting for CI — set it `false`
  (Renovate then merges itself only when every check is green). Add `gitIgnoredAuthors:
  ["homelab-regen-bot@users.noreply.github.com"]`. Add automerge (`automergeType: pr`, `platformAutomerge: false`) for
  non-major chart/image bumps in `configuration/versions.yaml` (keep majors, infrastructure tools and ksops manual), and
  `prBodyNotes` explaining the gate. `task renovate:validate` must pass (or `npx --yes renovate-config-validator` if the
  task needs it).
- [ ] **U5 Docs.** Rewrite the "Renovate bumps" section of `docs/runbooks/verification.md`: upstream manifest diff comment,
  CRD revalidation, automerge gate, optional regeneration bot (human step: create the GitHub App with `contents: write`
  on this repo, store its id/key as the two secrets). Note it supersedes the "no auto-commit" stance for the bot only.
- [ ] **U6 Verify.** `go test ./internal/verify/... ./cmd/...`; run `go run ./cmd/homelab verify upgrade --base origin/main`
  locally (network) and paste the summary; `yamllint` the workflow; renovate validation.

## WP-D: Scheduled CNPG restore drill (item 20)

**Files:** Create `charts/addons/templates/cnpg-barman-cloud.yaml`, `tests/drills/.chainsaw.yaml`,
`tests/drills/README.md`, `tests/drills/cnpg-restore/chainsaw-test.yaml`, `.github/workflows/restore-drill.yml`.
Modify `configuration/versions.yaml` (add `charts.plugin-barman-cloud: "0.8.0"` with
`# renovate: datasource=helm depName=plugin-barman-cloud registryUrl=https://cloudnative-pg.github.io/charts` and
`images.versitygw: "v1.8.0"` with `# renovate: datasource=docker depName=versity/versitygw`), `charts/addons/values.yaml`
+ `configuration/templates/helm-addons.tmpl` (shared), `tests/schemas/sources.yaml` (shared) + vendored schema,
`tests/gitops/crd-providers.yaml`, `docs/disaster-recovery.md`, `charts/addons/templates/cloudnative-pg.yaml` (its sync-wave
comment says 8, the annotation says 10, helm-addons.tmpl says 2 — fix the comments to the truth), Taskfile `drill:restore` /
`test:drill` only.

Why the plugin: CloudNativePG 1.29 (chart 0.28.3) still ships native `barmanObjectStore`, but it is deprecated and removed
in 1.31; the Barman Cloud Plugin (chart `plugin-barman-cloud` 0.8.0, image v0.15.0, CRD `objectstores.barmancloud.cnpg.io`,
needs cert-manager, installs into `cnpg-system`) is the supported path. Why versitygw: no object store exists in either
environment and MinIO no longer publishes community images; `versity/versitygw` (Apache-2, POSIX backend) is maintained.

- [ ] **D1 Addon.** Application `cnpg-barman-cloud` (chart `plugin-barman-cloud`, repo `https://cloudnative-pg.github.io/charts`,
  namespace `cnpg-system`, sync-wave after `cloudnative-pg`, SSA, resources set, Kind sizing under `$localdev`), enabled
  wherever `cloudnative-pg` is. Registries: `barmancloud.cnpg.io: cnpg-barman-cloud` in `tests/gitops/crd-providers.yaml`;
  `plugin-barman-cloud` source with `kinds: [ObjectStore]` in `tests/schemas/sources.yaml`; `task schemas:vendor -- --only
  plugin-barman-cloud`.
- [ ] **D2 Drill.** `tests/drills/cnpg-restore/chainsaw-test.yaml` (own `.chainsaw.yaml`: generous timeouts, parallel 1):
  assert `cloudnative-pg` + `cnpg-barman-cloud` Applications Healthy; deploy versitygw (Deployment + Service + credentials
  Secret created by the test, image from chainsaw values `($values.versitygwImage)`, bucket directory created by an init
  container, resources + non-root securityContext); `ObjectStore drill-store`; `Cluster drill-src` (1 instance, local-path 1Gi,
  plugin `barman-cloud.cloudnative-pg.io` as WAL archiver); seed a marker row with `kubectl exec` + `psql`; `Backup` with
  `method: plugin`; wait `completed`; `Cluster drill-restore` bootstrapped with `recovery.source` from an `externalClusters`
  entry using the plugin (`serverName: drill-src`); assert healthy; read the marker back and fail if it differs. `catch:` with
  events, describes, operator + plugin + instance logs.
- [ ] **D3 Tasks.** `test:drill` writes a values file from `versions.yaml` (`yq`) and runs chainsaw on `tests/drills`;
  `drill:restore` = kind → argocd → `sync --warm` → `test:drill`.
- [ ] **D4 Workflow `restore-drill.yml`.** `schedule: cron '23 5 * * 1'` (weekly) + `workflow_dispatch`; tool install and caches
  copied from `tilt-ci.yml` `kind-argocd` (same pins, Renovate markers); `task drill:restore`; diagnostics on failure; on
  failure open (or comment on) an issue labelled `restore-drill` (`issues: write`, create the label if missing); on success
  close any open `restore-drill` issue with a comment.
- [ ] **D5 Run it for real.** You are the only WP allowed to use Kind: `task localdev:down` if a stale cluster exists, then
  `task config:export:localdev` (regenerates the committed localdev values; fine — the integrator regenerates again),
  `task drill:restore`. Iterate until the drill passes (other WPs' in-progress chart edits may break a full sync; if so use
  `task localdev:sync -- --only <apps>` for cert-manager, cloudnative-pg, cnpg-barman-cloud and their parents, or helm-install
  the plugin directly to iterate on the drill — but the final run must be `task drill:restore`). Leave the cluster running.
- [ ] **D6 DR doc.** Add a "Verified claims" section near the top of `docs/disaster-recovery.md`: a table of every concrete claim
  with status *Verified weekly (restore drill)*, *Implemented, not drilled*, or *Not implemented* (be honest: Velero, B2,
  the etcd CronJob and the `postgres-backup` CronJob do not exist in this repo); fix the broken `runbooks/talos-recovery.md`
  link; describe the CNPG backup path (plugin + ObjectStore) and that production has no object store yet.

## WP-S: Scaffolder (item 21)

**Files:** Create `internal/scaffold/` (package, `embed.FS` templates under `internal/scaffold/templates/<pattern>/`, tests),
`cmd/homelab/commands/scaffold.go` (+ tests), `scripts/scaffold-selftest.ts` (+ `_test.ts`). Modify `cmd/homelab/main.go`
(register), `.github/workflows/verify.yml` (new job `scaffold` only), Taskfile `scaffold`/`test:scaffold` only.

- [ ] **S1 Command.** `homelab scaffold app <name> --pattern operator|helm|deps-main-config` with `--tier addons|applications`
  (default: operator/deps-main-config → addons, helm → applications), `--namespace`, `--chart-repo`, `--chart-name`,
  `--chart-version`, `--port`, `--health-path`, `--expect 200`, `--crd-group`, `--crd-kinds`, `--huge-crds`, `--no-regenerate`;
  global `--dry-run` prints a unified diff of every file it would create or change and writes nothing. Validates `<name>`
  (DNS label, not already present). Exit 2 on usage errors.
- [ ] **S2 What it writes** (following the three existing patterns: cloudnative-pg = operator, sonarr = helm,
  traefik-external = deps-main-config): Application template(s) in `charts/<tier>/templates/<name>.yaml` (finalizer,
  waves `-dependencies` < main < `-config`, SSA, automated gate, smoke include); values block in
  `charts/<tier>/values.yaml`; export-template block in `configuration/templates/helm-{addons,apps}.tmpl` (version from
  `.Versions.Charts`, enabled, namespace, `$localdev` sizing, hostname from a new schema key, smoke URL); schema key
  `<NAME>_HOSTNAME` (const `<name>.{{.DOMAIN}}`) in the right `configuration/schema/*.schema.yaml` for apps with an ingress;
  `configuration/versions.yaml` entry with Renovate marker (inserted in the `charts:` map); child charts
  `charts/<name>-dependencies/` and `charts/<name>-config/` (Chart.yaml, values*.yaml, a minimal template) for
  deps-main-config; `tests/e2e/<name>/chainsaw-test.yaml`; for operator: `tests/gitops/crd-providers.yaml`,
  `huge-crd-charts.yaml` (with `--huge-crds`), `tests/schemas/sources.yaml`, `charts/bootstrap/files/health/<group>_<Kind>.lua`
  (Ready-condition template) + `tests/health/<group>_<Kind>/{healthy,progressing,degraded}.yaml`; the TrueCharts package
  list in `.github/renovate.json5` when the repo is `oci.trueforge.org/truecharts`; a doc stub `docs/apps/<name>.md`.
  Then (unless `--no-regenerate` or `--dry-run`) regenerate the committed localdev values and the snapshots in-process
  (internal/config export + internal/verify snapshot update) and print the remaining steps (`task schemas:vendor` for
  operators, `task verify:text`, `task localdev:up && task verify:text LEVEL=2`).
- [ ] **S3 Tests.** Golden tests per pattern into a temp copy of the needed repo files; the scaffolded tree must pass the
  config contract tests (`internal/config`) logic. `scripts/scaffold-selftest.ts`: copy the repo (`git ls-files`) to a temp
  dir, build the binary, scaffold one app per pattern, run `homelab verify all --level 0 --json` there (network-free:
  operator pattern uses `--crd-group` with an existing vendored group or the check allowance you document) and fail on
  any failing check; `--keep` to inspect. `verify.yml` job `scaffold` runs `task test:scaffold`.
- [ ] **S4 Verify.** `go vet ./... && go test ./internal/scaffold/... ./cmd/...`, `task test:scaffold` locally,
  `deno fmt/check/test`. Update `docs/runbooks/verification.md` "Adding a new chart or application" by sending the text in
  your report (integrator owns the file).

## WP-C: Agent contract (item 22)

**Files:** Create `scripts/claude-verify-hook.ts` (+ `_test.ts`), `scripts/verify-claim.ts` (+ `_test.ts`),
`.claude/settings.json`, `.github/pull_request_template.md`, `.github/workflows/pr-contract.yml`. Modify `.gitignore`
(`!.claude/settings.json`), `.claude/skills/gitops-test/SKILL.md` (rewrite), `.claude/commands/gitops-test.md`,
`AGENTS.md` (Proactive Skill Invocation + Validation Flow sections only), Taskfile `verify:claim` only,
`docs/runbooks/verification.md` new section "Agent contract" only.

- [ ] **C1 Hook.** `scripts/claude-verify-hook.ts`: read the PostToolUse JSON on stdin; collect edited paths
  (`tool_input.file_path`, `tool_input.edits[]`, `tool_input.notebook_path`); act only when a path is under `charts/` or
  `configuration/` of `$CLAUDE_PROJECT_DIR`; `HOMELAB_VERIFY_HOOK=off` disables; a lock file in the OS temp dir skips a run
  while another is in flight; run `go run ./cmd/homelab verify all --level 0 --json` (timeout 150 s) in the project dir;
  pass → exit 0 with no output; fail → exit 2 with a compact stderr summary (failing check names, detail, ≤5 findings each,
  ≤60 lines total, a hint that `snapshot/*` drift after an intended change is fixed with `task test:snapshot -- --update`).
  `.claude/settings.json`: `hooks.PostToolUse` matcher `Edit|Write|MultiEdit` → `deno run --allow-read --allow-write
  --allow-run --allow-env "$CLAUDE_PROJECT_DIR/scripts/claude-verify-hook.ts"`, timeout 180. Nothing else in that file.
- [ ] **C2 Claim.** `scripts/verify-claim.ts render` (stdin = `homelab verify all --json`; prints the PR-body block:
  `<!-- verify-level0 -->` + fenced ```json``` with `{"level":0,"pass":bool,"checks":{"<name>":"<status>",...}}` sorted,
  compact); `compare --actual <ci json> [--body-file <f>|env PR_BODY]`: missing block → exit 1 with instructions; level
  must be 0; the check-name sets must match; `pass`↔`fail` differences and a different overall `pass` are failures;
  `skip`↔`pass` differences are warnings; prints a markdown result (for the sticky comment) and exits 0/1.
  `task verify:claim`.
- [ ] **C3 CI.** `.github/pull_request_template.md` (Summary, Verification with the marker and instructions, Test plan).
  `pr-contract.yml`: `pull_request` types opened/edited/synchronize/reopened/ready_for_review, no paths filter; skip
  `renovate/*` heads and drafts; same tool pins as `verify.yml` (Renovate markers); `task verify` → strip to the JSON
  object (as `verify.yml` does) → `compare` with `PR_BODY: ${{ github.event.pull_request.body }}` via env (never inline
  the body in the script); job summary + sticky comment `verify-claim` (`pull-requests: write`); fail on mismatch.
- [ ] **C4 Skill + agent docs.** Rewrite `.claude/skills/gitops-test/SKILL.md` around the single contract: level 0 is automatic
  (hook) and mandatory, `task verify LEVEL=1|2` on Kind, `task verify:claim` into the PR body, previews via labels
  (`docs/runbooks/previews.md`), read-only production (`task verify:prod`, `task prod:status`, `docs/runbooks/readonly-access.md`),
  Renovate flow. **Remove** the Tier 3/Tier 4 sections and every apply-to-prod / repoint-prod command from the skill (not
  "retired": gone), and remove the real domain it mentions. Keep the component-specific read-only diagnostics that are
  still useful. Update `.claude/commands/gitops-test.md` to match. `AGENTS.md`: Validation Flow reflects the hook, the claim
  and the read-only prod commands.
- [ ] **C5 Verify.** `deno fmt/check/test`; feed the hook a sample stdin JSON for a charts/ path and a non-matching path and
  show both behaviours; `task verify:claim` output pasted in your report; `yamllint` the workflow.

## Integration (owner: integrator, after the wave)

1. `task config:export:localdev`, `task schemas:check`, `task test:snapshot -- --update` (creates
   `tests/snapshots/homelab-preview/`, `*/agent-readonly.yaml`), `task verify:text`, `go vet ./... && go test ./...`,
   `task test:policy`, `task test:health`, `deno fmt --check scripts/ && deno check scripts/*.ts && deno test scripts/`,
   `yamllint -c .yamllint .`, `task renovate:validate`, `task test:scaffold`.
2. Real loop on the workstation: `task localdev:down; task localdev:ci`, `task verify LEVEL=2`, `task localdev:report`,
   `task drill:restore` (or `task test:drill` on the warm cluster). Fix what fails.
3. Docs: ADR-013 (Section C: previews, read-only prod, notifications) and ADR-014 (Section D: upgrade gate + regeneration
   bot, restore drills, scaffolder, agent contract), `bugs.md`, `key_facts.md`, `issues.md`, `CLAUDE.md` Taskfile table +
   `task docs:embedme`, `docs/runbooks/verification.md`, Serena memory, auto-memory.
4. `pre-commit run --all-files`, commit (semantic), push, `gh pr create` with `Closes #261` and the `task verify:claim` block,
   watch checks, fix until green. Close bd `homelab-lpw.3`, `homelab-lpw.4`, `homelab-lpw`.
