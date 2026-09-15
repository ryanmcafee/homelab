# Verification Runbook

How to verify GitOps changes before they reach the homelab cluster. Level 0 is the gate
every agent and human runs on every edit: it needs no cluster, no network beyond a cached
copy of the core Kubernetes schemas, and no PII. Levels 1 and 2 read a local Kind cluster
(`task localdev:up`) and are what CI runs on every pull request; they never touch
production (ADR-009). The production feedback loop is tracked in
[issue #261](https://github.com/ryanmcafee/homelab/issues/261).

| Level | Command | Needs | Adds |
|---|---|---|---|
| 0 | `task verify` | nothing | render, lint, kubeconform, pluto, gitops graph, snapshots, policy |
| 1 | `task verify LEVEL=1` | a Kind cluster (`task localdev:kind` is enough) | server-side dry run of every localdev chart |
| 2 | `task verify LEVEL=2` | the synced loop (`task localdev:up` or `localdev:ci`) | ArgoCD Application state, chainsaw e2e suite |

## Quick Start

```bash
task verify                      # level 0, JSON summary on stdout, exit 0/1
task verify:text                 # same checks, human-readable failures first
task verify -- --env homelab     # one environment only (level 0)
task verify:render -- --chart addons --keep   # keep the rendered manifests for inspection

task localdev:up                 # Kind + ArgoCD + every Application synced from the working tree
task verify:text LEVEL=1         # level 0 + kubectl server-side dry run against Kind
task verify:text LEVEL=2         # level 1 + Application health + chainsaw e2e
```

The JSON contract is stable and intended for machines:

```json
{"level":0,"checks":[{"name":"render/homelab/addons","status":"pass","duration_ms":120}],"pass":true,"duration_ms":2900}
```

`status` is `pass`, `fail` or `skip`; failing checks carry `detail` and a `findings[]` list
with one line per problem. Put the `task verify:claim` block (a compact form of this JSON)
in PR descriptions: `pr-contract.yml` re-runs level 0 on the PR head and fails when the
claim disagrees (see "Agent contract" below); `verify.yml` uploads its own copy as the
`verify-level0` artifact.

## What level 0 checks

| Check name | What it proves | Fix when it fails |
|---|---|---|
| `render/<env>/<chart>` | `helm template --include-crds` succeeds for every chart in `charts/` with the values ArgoCD would use. `homelab` renders through the same two-stage path as the CMP (`config export` from `homelab.yaml.example` → helm); `localdev` renders with `values.yaml` + the committed, config-generated `values-localdev.yaml`. | Read the helm error in `findings`. |
| `render/localdev/_committed-values` | `charts/addons/values-localdev.yaml` and `charts/applications/values-localdev.yaml` are byte-identical to `homelab config export --set localdev` from `configuration/`. | Run `task config:export:localdev` and commit the result; never hand-edit those files. |
| `lint/<env>/<chart>` | `helm lint` reports no `[ERROR]`. | Fix the chart. Warnings do not fail. |
| `kubeconform/<env>` | Every rendered object validates against the Kubernetes version in `configuration/versions.yaml` (`tools.kubernetes`) and the vendored CRD schemas in `tests/schemas/`. There is no `-skip` list. | A `could not find schema` finding means a new CRD kind: add it to `tests/schemas/sources.yaml` and run `task schemas:vendor`. Anything else is a real schema violation. |
| `pluto/<env>` | No deprecated or removed apiVersions for the target Kubernetes version. | Bump the apiVersion or the chart. |
| `gitops/<env>/paths` | Every Application `spec.source.path` exists and names value files that exist for that environment (or sets `ignoreMissingValueFiles`). | Create the missing `values-<env>.yaml` or the chart directory. |
| `gitops/<env>/waves` | `<x>-dependencies` syncs before `<x>`; `<x>-config` never shares a wave with `<x>`. | Adjust `argocd.argoproj.io/sync-wave`. |
| `gitops/<env>/crd-order` | Custom resources are synced after the Application that installs their CRD (registry: `tests/gitops/crd-providers.yaml`). A provider Application installs its group's CRDs either from the chart's `crds/` directory (ArgoCD renders with `--include-crds` unless `skipCrds: true`) or from a `crd.create`-style value. Reports `skip`, not `pass`, when the registry has no providers. | Move the consumer to a later wave, or register a new provider. |
| `gitops/<env>/repo-secrets` | Every **OCI** Helm source has a matching `argocd.argoproj.io/secret-type: repository` Secret with `enableOCI: "true"` in the `argocd` namespace. Plain `http(s)` chart repositories are **not** checked: ArgoCD fetches an anonymous `index.yaml` from them and every one this repo uses is public, so no Secret exists to require. The count of skipped https repositories is appended to the check detail. A *private* http(s) repo would need credentials and is not covered. | Add the repository Secret next to the Application. |
| `gitops/<env>/secret-refs` | Every `secretKeyRef`/`secretRef`/`existingSecret` is produced in the same namespace by a rendered `Secret`, `OnePasswordItem`, `Certificate`, or is listed with a reason in `tests/gitops/known-secrets.yaml`. In localdev the `Secret`s seeded by `localdev/fakes/*.yaml` also count as producers (the detail reports `N seeded by localdev/fakes`). | Add the `OnePasswordItem` to the `*-config` chart, or register a known secret (with `reason`); for localdev, seed the Secret in `localdev/fakes/secrets.yaml`. |
| `gitops/<env>/namespaces` | Every destination namespace is declared as a `Namespace` object, created with `CreateNamespace=true`, or is a system namespace. | Declare it (with pod-security labels) or add the sync option. |
| `gitops/<env>/ssa` | Charts on the huge-CRD list (`tests/gitops/huge-crd-charts.yaml`) use `ServerSideApply=true`. Reports `skip`, not `pass`, when the list is empty. | Add the sync option. |
| `gitops/<env>/unique-names` | No duplicate Application `namespace/name`. | Rename. |
| `versions/<env>` | Every chart-sourced Application (`spec.source.chart` or `spec.sources[].chart`) renders the `targetRevision` that `configuration/versions.yaml` `charts:` pins for it (key mapped by chart name, Renovate `depName` or Application name; exact string match; a chart with no mapped key must equal some `charts:` value). Drift listed with a reason in `tests/gitops/version-drift.yaml` is allowed; an entry whose revision no longer renders, whose drift was fixed, or (full render only, `versions/registry`) that matches no Application fails. | Make the export template emit `chart.version` from `.Versions.Charts`, or register the drift with a reason; remove stale entries. |
| `snapshot/<env>/<chart>` | The render is byte-identical to `tests/snapshots/<env>/<chart>.yaml`. | Review the diff; if intended run `task test:snapshot -- --update` and commit. |
| `policy/<env>` | conftest policies in `tests/policy/` pass (finalizers, sync waves, SSA, automated sync, no `:latest`, resources on every container, no inline secrets, hostnames under the configured domain). | Fix the chart, or add `homelab.ryanmcafee.com/policy-exempt: "<rule-id>"` plus `homelab.ryanmcafee.com/policy-exempt-reason` on the object. |

Level 0 renders a third environment, `homelab-preview`: the homelab two-stage render of
`charts/applications` alone in preview mode (`global.preview.pr=123`, every app in
`global.preview.allowedApps`), which is what the `previews` ApplicationSet produces for a
labelled PR. It gets render, lint, kubeconform, pluto, policy, snapshot
(`tests/snapshots/homelab-preview/applications.yaml`) and the gitops rules;
`gitops/homelab-preview/repo-secrets` is always `skip` because the TrueCharts repository
Secret comes from the homelab environment. `tests/policy/applicationset.rego` checks every
ApplicationSet template (finalizer, `ServerSideApply=true`, a project other than `default`,
automated sync). See `docs/runbooks/previews.md`.

## Level 1: server-side dry run against Kind

`task verify LEVEL=1` runs every level-0 check, then applies each rendered **localdev**
chart to the Kind cluster with `kubectl apply --server-side --dry-run=server
--force-conflicts --field-manager homelab-verify`. The API server validates every object
against the CRDs and admission webhooks that are actually installed, which catches what
kubeconform cannot: unknown fields on a CRD version the vendored schema does not model,
webhook rejections (cert-manager, Cilium), immutable-field changes, and namespace or
StorageClass references that do not exist in Kind.

Prerequisites: a Kind cluster reachable through the `kind-homelab-localdev` context
(`task localdev:kind` creates it with Cilium and the fakes; `task localdev:up` also
installs ArgoCD and syncs). `--env` must include `localdev`; `task verify LEVEL=1 -- --env
homelab` is a usage error (exit 2) because the homelab render is never applied anywhere by
an agent. The context is overridable with `-- --kube-context <name>`.

| Check name | What it proves | Fix when it fails |
|---|---|---|
| `dryrun/localdev/<chart>` | The rendered chart is accepted by the Kind API server in a server-side dry run. Empty renders (a chart with nothing enabled in localdev) are skipped. | `findings` carries the kubectl stderr: a missing CRD means the provider Application has not synced (run `task localdev:up`), a field error means the manifest is wrong. |
| `dryrun/cluster` | (Only on failure.) The cluster behind `--kube-context` is reachable. | `task localdev:kind`, or check Docker Desktop. |
| `dryrun/localdev` (`skip`) | kubectl is not installed. | `mise install`. |

## Level 2: Application state and e2e on Kind

`task verify LEVEL=2` runs level 1, then reads every ArgoCD Application in namespace
`argocd` and runs the chainsaw suite in `tests/e2e/` (`-- --e2e-dir` overrides). It does
not sync anything: run `task localdev:up` (or `task localdev:ci`, which also waits for
health and runs e2e once) first. Every Application tracks the PR head (`task localdev:argocd
-- --revision <ref>` / `LOCALDEV_REVISION`, default the upstream branch of HEAD, `main` when
the branch is not pushed), so after a local sync `Synced` means the working tree equals the
pushed head; a local branch may be ahead of its push, so sync status is deliberately not
part of the contract; health and the last operation are.

| Check name | What it proves | Fix when it fails |
|---|---|---|
| `argocd/<app>` | `status.health.status == Healthy` and `status.operationState.phase == Succeeded`. `detail` is `sync=<status> health=<status> op=<phase>`; `findings` lists condition messages and every resource whose health is not Healthy (`kind/ns/name: status message`). An Application whose chart renders no resources (a placeholder `*-dependencies` chart) never gets an operation; `Synced` + `Healthy` with zero resources passes with `detail` ending in `(no resources: nothing to sync)`. A chart that is new on the branch and renders nothing in localdev is left alone by `task localdev:sync` when its path is absent from the tracked revision (only on the `main` fallback for an unpushed branch, since any sync would fail); `Healthy` with zero resources, no operation and a `ComparisonError` containing `app path does not exist` passes with `detail` ending in `(new chart: nothing to sync until it exists on the target revision)` — in Kind only, `verify prod` keeps failing it. | `task localdev:diagnose` prints conditions, events and failing pod logs; `task localdev:sync -- --only <app>` re-syncs one Application from the working tree. |
| `argocd/apps` | (Only on failure.) At least one Application exists in `argocd`. | `task localdev:up` installs the root `gitops` Application and syncs the tree. |
| `e2e/<test>` | The chainsaw test `tests/e2e/<test>/chainsaw-test.yaml` passed; `findings` names the failed steps. | `task test:e2e -- --test-dir tests/e2e/<test>` reproduces it with full output; every test has a `catch:` that dumps events, pod logs and the Application. |
| `e2e/chainsaw` | (Only on failure or skip.) chainsaw ran and wrote a JSON report; `skip` means chainsaw is not installed. | Read the stderr tail in `findings`; `mise install` for the skip. |

Exit codes and the JSON contract are unchanged across levels: `0` when every check
passes, `1` on any failure, `2` on a usage error; `level` in the JSON is the level that
was requested. CI runs level 2 in `.github/workflows/tilt-ci.yml` (job `kind-argocd`) and
uploads `verify-level2.json`.

Level 2 also exercises the PostSync smoke hooks: each enabled application renders a Job
`smoke-<app>` (`argocd.argoproj.io/hook: PostSync`, deleted on success) that curls the
app's Service URL until a code in `<app>.smoke.expect` comes back, so an Application only
reaches `Succeeded` when its HTTP endpoint answers. The URLs live in
`charts/{addons,applications}/values.yaml` under `<app>.smoke` and are the same for both
environments: Plex probes `plex-plex-media-server.media.svc.cluster.local:32400/identity`,
NZBGet `nzbget.media.svc.cluster.local:10057/` (200 or 401, basic auth), Home Assistant
`/api/` (200 or 401), the *arr apps `/ping`, Grafana `/api/health`, Prometheus its
readiness endpoint; mosquitto has `enabled: false` (no HTTP). A failing smoke Job shows up as the Application's operation
`Failed` in `argocd/<app>` and in `task localdev:diagnose`.

On pull requests `kind-argocd` then runs `task localdev:report` and posts the result as the
sticky comment `kind-preview`: the level-2 verdict and failing checks, a table of every
Application (health, sync, last operation, vs the base branch) and one collapsed
`argocd app diff <app> --revision <base>` per git-path Application (`-- --base <ref>`,
default `main`; CI passes the PR's base branch). Every Application tracks the PR head and
the tree was synced with `--local`, so each diff is this PR against its base (`-` base, `+`
PR); chart-sourced Applications are compared on their parent, and a child Application's
chart or values change shows on its parent's diff. The same
Markdown lands in the job summary and in the `verify-level2` artifact (`kind-report.md`).
The step never decides the check, and fork PRs get the summary but no comment. Locally,
`task localdev:report -- --out kind-report.md --verify-json verify-level2.json` prints the
same report (`--no-diff`, `--max-diff-bytes 0` for full diffs); it only reads.

## Related commands

| Command | Purpose |
|---|---|
| `task test:snapshot` / `-- --update` | Diff or regenerate golden snapshots. |
| `task test:policy` | Rego unit tests plus every negative fixture in `tests/policy/negative/` must fail with its `# expect:` rule. |
| `task test:health` | Evaluates every ArgoCD health script in `charts/bootstrap/files/health/` against the fixtures in `tests/health/` with `argocd admin settings resource-overrides health` (the pinned `argocd` CLI); each fixture declares `# expect: <Status>`. Runs in the `policy` CI job. See `tests/health/README.md`. |
| `task test:e2e` | The chainsaw suite against the running Kind loop (`-- --test-dir tests/e2e/<name>` for one test). Level 2 runs the same suite with a JSON report. See `tests/e2e/README.md`. |
| `task localdev:up` / `localdev:warm` / `localdev:ci` | Kind + ArgoCD + sync everything / only addons (no bootstrap Application in localdev) / non-interactive full loop with wait + e2e. See `docs/local-development.md`. |
| `task localdev:diagnose` | Conditions, unhealthy resources, events and failing pod logs for every Application that is not Healthy/Succeeded. |
| `task test:config` | Template ↔ schema ↔ `versions.yaml` contract tests (`internal/config/contract_test.go`). |
| `task test:cmp-parity` | Runs the pinned `ghcr.io/ryanmcafee/homelab-cmp:<tag>` image with Docker and diffs its `config export` against source. Fails when the image tag lags the Go source. A tag bumped in the change under test is not a failure: `cmp-image.yml` pushes the image only on a merge to `main`, so when the pull reports the tag is unknown the script compares it with `--base-ref` (default `origin/main`) and passes if this change bumped it, failing if the tag is unchanged and the image is genuinely absent. The image is published for `linux/amd64` and `linux/arm64`, so it runs natively on an Apple Silicon workstation; `--platform` stays available for testing a tag published before multi-arch (anything at or below `0.1.12`), which is amd64 only. |
| `task schemas:vendor` / `task schemas:check` | Regenerate or verify `tests/schemas/` from the chart versions in `configuration/versions.yaml`. |
| `task gpu:toggle-test` | GPU vendor toggle harness (`scripts/toggle-test.ts`); uses the same Kubernetes version and vendored schemas. |
| `task ci:test` | Everything above that needs no cluster: the local equivalent of the `verify.yml` jobs. |

## Tooling

Run `mise install` after pulling. Core Kubernetes schemas are cached under
`~/.cache/homelab-kubeconform` (first run downloads them; CI caches the directory).

`helm` and `go` are pinned to an exact version in `mise.toml`. The helm pin matters most:
the golden snapshots are byte-exact, so a different helm renders different bytes and every
snapshot check fails. Three files name the helm version and must agree:

| File | Key | Role |
|---|---|---|
| `configuration/versions.yaml` | `tools.helm` | single source of truth, Renovate-tracked |
| `mise.toml` | `helm` | the local renderer |
| `.github/workflows/verify.yml` | `HELM_VERSION` (with a `v` prefix) | the CI renderer |

`kubeconform`, `conftest`, `pluto` and `deno` track `latest` in `mise.toml`; their output
is not byte-compared, so a minor difference between a workstation and CI is tolerable. The
CI pins for those live in `verify.yml`, each with a Renovate marker comment so bumps land
there too.

Levels 1 and 2 add `kind`, `argocd` and `chainsaw`, pinned in `configuration/versions.yaml`
(`tools.kind`, `tools.argocd`, `tools.chainsaw`, plus `images.kind-node` for the node image),
mirrored in `mise.toml` and in the `env:` block of `tilt-ci.yml` (kind, kubectl, helm,
argocd, chainsaw, tilt, task), each with a Renovate marker. `kubectl` in CI follows
`tools.kubernetes`.

## Adding a new chart or application

Start with the scaffolder: `task scaffold -- app <name> --pattern operator|helm|deps-main-config
--chart-repo <https://…|oci://registry/path> --chart-version <v>` (add `--dry-run` to see the
change as a patch that `git apply` accepts; nothing is written).

| Pattern | Modelled on | Generates |
|---|---|---|
| `operator` | cloudnative-pg | one Application (addons, wave 10); the CRD group in `tests/gitops/crd-providers.yaml` (and `huge-crd-charts.yaml` with `--huge-crds`), a `tests/schemas/sources.yaml` source, Ready-condition health Lua + fixtures per `--crd-kinds` |
| `helm` | sonarr | one Application (applications, wave 13) with an Ingress on `<name>.<domain>` (new `<NAME>_HOSTNAME` schema key) and a PostSync smoke hook; TrueCharts charts join the Renovate group |
| `deps-main-config` | traefik-external | `<name>-dependencies` < `<name>` < `<name>-config`, child charts fed through `helm.valuesObject` (ADR-010) |

Every pattern also writes the placeholder block in `charts/<tier>/values.yaml`, the real values
in `configuration/templates/helm-*.tmpl`, the `versions.yaml` pin with its Renovate marker,
`tests/e2e/<name>/` and `docs/apps/<name>.md`, then regenerates the tier's committed localdev
values and the affected snapshots (`--no-regenerate` skips that). Usage errors (a name, key,
CRD group or health check that already exists) exit 2. `task test:scaffold` proves every pattern
passes level 0 in a temporary copy of the repository; `verify.yml` runs it (job `scaffold`).

After scaffolding:

1. Adapt the `values:` block to the chart's own values and check that `smoke.url` names the
   chart's Service; `task config:export:localdev && task test:snapshot -- --update`.
2. Operators: `task schemas:vendor -- --only <name>` (network) before rendering any resource of
   the group, then `task test:health`. An `oci://` chart source cannot be vendored by the script;
   add the CRD kinds from a `github:` source instead.
3. Seed any Secret that 1Password provides in homelab in `localdev/fakes/secrets.yaml`.
4. To offer the app in PR previews, add it to `global.preview.allowedApps` (`docs/runbooks/previews.md`).
5. `task verify:text`, then `task localdev:up && task verify:text LEVEL=2` on Kind.
6. Commit; the pre-commit hook and the PostToolUse hook re-run level 0, CI re-runs level 0
   (`verify.yml`, including the scaffolder self-test) and level 2 (`tilt-ci.yml`).

Doing it by hand follows the same checklist: every file the table names must exist.

## Renovate bumps

Renovate (self-hosted in the cluster, `charts/applications` `renovate`) bumps
`configuration/versions.yaml`. A chart bump there changes one `targetRevision` line in the
rendered Application; level 0 cannot see what the new chart deploys, because it renders
this repository's charts, not the upstream charts an Application points at (ADR-009).
`.github/workflows/upgrade.yml` fills that gap on every PR that touches `versions.yaml` or
`charts/**`.

**Upstream manifest diff.** `task verify:upgrade -- --base origin/main` checks the base
ref out into a temporary `git worktree`, runs the level-0 render there and in the working
tree, and collects every Application Helm chart source (`spec.source.chart` or
`spec.sources[].chart`: repoURL, chart, targetRevision, inline values, valuesObject,
parameters, release name, namespace). Each source that was added, removed or changed is
rendered with `helm template` at both sides (`--include-crds`, the target Kubernetes
version; OCI repositories as `oci://<repoURL>/<chart>`, others with `--repo`), the
`helm.sh/chart` and `app.kubernetes.io/version` labels are dropped, and the manifests are
diffed object by object. Unchanged sources are not re-rendered.

| Check name | Meaning |
|---|---|
| `upgrade/<env>/<app>` | `pass` with detail `unchanged: ...` or `manifest diff: +A -D lines (...)`, the diff in `findings` (capped by `--max-diff-lines`, default 400) and every CRD whose spec changed; `fail` when the chart does not render at head; `skip` when only the base render fails. |
| `upgrade/<env>/_repo` | The level-0 render of this repository's own charts, base vs head, with Application chart sources masked (the per-app checks own them). |
| `upgrade/<env>/_render` / `_base-render` | The working tree (fail) or the base ref (skip) does not render. |

The job posts the report as the sticky `upgrade-diff` comment (bounded to one comment;
the JSON artifact `upgrade-report` carries the capped diffs) and fails only when a render
fails, never because a manifest changed. Locally: `task verify:upgrade -- --base
origin/main --report upgrade.md`, `--keep` to inspect the renders, `--env
homelab,localdev` for both environments. Both sides render with the working tree's helm
(a mise shim is resolved with `mise which helm`, since mise refuses the untrusted
`mise.toml` of a fresh worktree), so the diff shows the charts, not a helm upgrade.

**CRD revalidation.** In the runner's tree only, the job then regenerates the localdev
values (`task config:export:localdev`), re-vendors `tests/schemas` from the bumped
versions (`task schemas:vendor`) and re-runs `homelab verify render --env
homelab,localdev`: kubeconform validates every custom resource this repository renders
against the new CRD schemas. The result and the list of files the bump needs regenerated
are appended to the report. Nothing is committed.

**Automerge gate.** On `renovate/*` branches the job sets the commit status
`upgrade/automerge-gate` on the head SHA: `success` ("no rendered manifest changes")
only when every `upgrade/*` check is `unchanged` and revalidation passed, otherwise
`failure` ("rendered manifests changed — human review required, automerge blocked").
`renovate.json5` automerges non-major, non-0.x chart and image bumps in `versions.yaml`
(`kindest/node`, majors, infrastructure tools and ksops stay manual) and patch bumps
elsewhere, always with `platformAutomerge: false`: Renovate merges itself, and only when
every status on the head commit is green. GitHub native auto-merge is never used because
the `main` ruleset requires no status checks, so it would merge before CI ran. In practice
a bump whose upstream render changes anything (an image tag, a CRD) waits for a human who
reads the `upgrade-diff` comment.

**Regeneration bot (optional).** A chart bump also needs the committed localdev values,
`tests/schemas` and `tests/snapshots` regenerated; until then the `level-0`, `schemas` and
`snapshot` jobs in `verify.yml` stay red. The `regenerate` job in `upgrade.yml` does that
on `renovate/*` branches and pushes one commit, `chore(deps): regenerate snapshots,
schemas and localdev values`, authored by `homelab-regen-bot
<homelab-regen-bot@users.noreply.github.com>`, with a GitHub App token. This supersedes
the "no auto-commit" stance of the `snapshot` job for this bot only, and it answers that
stance's three reasons: an App-token push triggers the other workflows (a `GITHUB_TOKEN`
push does not), `gitIgnoredAuthors` keeps Renovate managing and rebasing the branch, and
the automerge gate blocks any bump whose render changed. A loop guard skips a head commit
that is already the bot's. Human PRs are never committed to.

Without the secrets the job prints a notice and does nothing. To enable it (human step):
create a GitHub App owned by the repository owner with repository permission
**Contents: read and write**, install it on this repository only, and store its App ID and
a private key as the Actions secrets `HOMELAB_BOT_APP_ID` and `HOMELAB_BOT_PRIVATE_KEY`.

To accept a bump without the bot: run `task config:export:localdev`, `task
schemas:vendor` and `task test:snapshot -- --update` on the branch and commit, or commit
the `snapshots-regenerated` artifact of the `snapshot` job, which also posts its own
`snapshot-diff` comment with the in-repository manifest diff.

## Agent contract

Level 0 is wired into the agent loop rather than left to memory, and every pull request
states the result its author saw; CI checks the statement (issue #261 item 22).

| Piece | File | What it does |
|---|---|---|
| PostToolUse hook | `.claude/settings.json` → `scripts/claude-verify-hook.ts` | After every Claude Code `Edit`/`Write`/`MultiEdit` of a file under `charts/` or `configuration/` of `$CLAUDE_PROJECT_DIR`, builds `./cmd/homelab` and runs `verify all --level 0 --json` in the project root (150 s cap, hook timeout 180 s). Pass: silent, exit 0. Fail: exit 2, and Claude Code hands the agent a summary of at most 60 lines (failing checks, `detail`, up to five findings each, hints such as `task test:snapshot -- --update` for intended snapshot drift). A build error or timeout is reported the same way. |
| Claim | `task verify:claim` (`scripts/verify-claim.ts render`) | Prints the level-0 result as a PR-body block (format below). Exit 0 for any valid result; a failing level 0 is recorded as `"pass":false`, never hidden. |
| PR template | `.github/pull_request_template.md` | A Verification section with the marker and a placeholder to replace. |
| CI comparison | `.github/workflows/pr-contract.yml`, job `claim` | On opened/edited/synchronize/reopened/ready_for_review (no paths filter; drafts and `renovate/*` heads skipped): runs `task verify` on the PR **head**, then `verify-claim.ts compare`. Verdict in the job summary and the sticky `verify-claim` comment; the job fails on a missing or mismatched claim. |

The block, one check per line and sorted:

````
<!-- verify-level0 -->
```json
{"level":0,"pass":true,"checks":{
"gitops/homelab/crd-order":"pass",
...
"snapshot/localdev/traefik-internal-dependencies":"pass"
}}
```
````

Compare rules: a missing or unparseable block fails with instructions; the claimed `level`
must be 0; the claimed and CI check-name sets must be identical (a difference means the claim
is stale: re-run `task verify:claim` after the last change); a per-check difference with
`fail` on either side fails; `skip`↔`pass` is only a warning (a tool missing on one side); a
different overall `pass` fails. When the PR template's placeholder and a pasted block are both
present, the last well-formed block counts. Editing the description re-runs the job. A claim
that honestly says `"pass":false` matches; `verify.yml` is what fails the PR for it.

The PR body reaches the script only through `env: PR_BODY`; it is never expanded inside a
`run:` script. The comparison runs on the head commit because that is what the author
verified; `verify.yml` verifies the merge result.

Hook notes:

- `HOMELAB_VERIFY_HOOK=off` (or `0`/`false`/`no`) in the environment disables it; use it for a
  long mechanical edit series and run `task verify:text` at the end.
- A lock file in `$TMPDIR` (one per project root, stale after 200 s) skips a run while another
  is in flight, so the last edit of a fast burst can go unverified: run `task verify:text`
  before committing. The pre-commit hook re-runs level 0 anyway.
- Only `charts/` and `configuration/` are watched. Edits to `tests/**`, `localdev/**` or
  `internal/verify/**` change level 0 too; run `task verify:text` after them.
- The root is `$CLAUDE_PROJECT_DIR`: launch Claude Code from the worktree you edit, or edits in
  another worktree are not verified. The hook needs `deno` on `PATH`; it adds the mise shims
  to the child `PATH` itself, so `go`, `helm`, `kubeconform`, `conftest` and `pluto` resolve
  (in a fresh worktree run `mise trust && mise install` first, or the hook reports mise's
  "not trusted" error).
- `.claude/settings.json` is committed (`.gitignore` exception); personal settings stay in the
  ignored `.claude/settings.local.json`, and Claude Code merges both.

What an agent may do (ADR-009): mutate only Kind. Production is read through the
`homelab-readonly` context and the read-only ArgoCD account: `task verify:prod` (checks
`prod/argocd/<app>`), `task prod:status`, `task prod:diff -- <app>`
(`docs/runbooks/readonly-access.md`). A preview on the homelab cluster is requested with the
`preview` and `preview:<app>` labels, a maintainer action (`docs/runbooks/previews.md`). The
`gitops-test` skill (`.claude/skills/gitops-test/SKILL.md`) and `AGENTS.md` "Validation Flow"
describe the same loop for agents.

## Reading failures from CI

The `level-0` job (`verify.yml`) writes a summary table to the run's Job Summary and uploads
`verify-level0.json`. `jq '.checks[] | select(.status=="fail")' verify-level0.json` lists
every failing check with its findings.

The `kind-argocd` job (`tilt-ci.yml`) does the same for level 2 (`verify-level2.json`), and
its `Diagnostics` step (always run) prints `task localdev:diagnose` plus every Application
and pod, so a red `argocd/<app>` check comes with the conditions, events and pod logs in the
same log. When `task localdev:ci` itself fails, the JSON is absent and the sync or wait log
holds the reason.

## PII guard

`homelab config guard` runs in pre-commit (staged files matching the default scope) and in
CI (`--ci`: every tracked YAML/JSON/Markdown file in scope). The default scope is
`configuration/**` plus `charts/**/values-homelab.yaml` (the committed child-chart values,
which must stay PII-free because derived values reach children through the parent
Application's `helm.valuesObject`, see ADR-010). Real values come from the gitignored
`environments/homelab.yaml` when present; without it the guard still applies shape rules:

- config keys: routable IPs on `*_IP`/`*_VIP` keys, real-looking hostnames and mailboxes on
  domain keys;
- Helm-style keys (`host`, `hostname`, `domain`, `portal`, `staticIP`, `ip`, `address`,
  `email`, `subdomain`, ...): routable host IPs (with or without a port, so
  `172.16.100.150:3260` is caught) and real-looking hostnames or mailboxes;
- list items under `dnsZones`, `allowedDomains`, `hosts`, `dnsNames`, `portals`.

Keys that legitimately carry public hosts (`repoUrl`, `server`, `providerURL`, `url`) are
not checked. Example/template files are held to a closed placeholder allowlist
(`192.168.1.0/24`, `REPLACEME` / `REPLACEME-*` labels, `example.com`, loopback, `.local`):
any other value on a PII-shaped key fails. A new placeholder convention must be added to
the allowlist in `internal/config/guard.go`. Widen or narrow the scope with `--paths`.
