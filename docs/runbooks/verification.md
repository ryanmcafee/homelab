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
with one line per problem. Paste the JSON summary in PR descriptions; CI re-runs it and
uploads its own copy as the `verify-level0` artifact.

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
| `gitops/<env>/secret-refs` | Every `secretKeyRef`/`secretRef`/`existingSecret` is produced in the same namespace by a rendered `Secret`, `OnePasswordItem`, `Certificate`, or is listed with a reason in `tests/gitops/known-secrets.yaml`. | Add the `OnePasswordItem` to the `*-config` chart, or register a known secret (with `reason`). |
| `gitops/<env>/namespaces` | Every destination namespace is declared as a `Namespace` object, created with `CreateNamespace=true`, or is a system namespace. | Declare it (with pod-security labels) or add the sync option. |
| `gitops/<env>/ssa` | Charts on the huge-CRD list (`tests/gitops/huge-crd-charts.yaml`) use `ServerSideApply=true`. Reports `skip`, not `pass`, when the list is empty. | Add the sync option. |
| `gitops/<env>/unique-names` | No duplicate Application `namespace/name`. | Rename. |
| `snapshot/<env>/<chart>` | The render is byte-identical to `tests/snapshots/<env>/<chart>.yaml`. | Review the diff; if intended run `task test:snapshot -- --update` and commit. |
| `policy/<env>` | conftest policies in `tests/policy/` pass (finalizers, sync waves, SSA, automated sync, no `:latest`, resources on every container, no inline secrets, hostnames under the configured domain). | Fix the chart, or add `homelab.ryanmcafee.com/policy-exempt: "<rule-id>"` plus `homelab.ryanmcafee.com/policy-exempt-reason` on the object. |

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
health and runs e2e once) first. A local sync leaves every Application `OutOfSync` against
GitHub `main` by design, so sync status is deliberately not part of the contract; health
and the last operation are.

| Check name | What it proves | Fix when it fails |
|---|---|---|
| `argocd/<app>` | `status.health.status == Healthy` and `status.operationState.phase == Succeeded`. `detail` is `sync=<status> health=<status> op=<phase>`; `findings` lists condition messages and every resource whose health is not Healthy (`kind/ns/name: status message`). | `task localdev:diagnose` prints conditions, events and failing pod logs; `task localdev:sync -- --only <app>` re-syncs one Application from the working tree. |
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

1. Add the chart under `charts/<name>` (and `charts/<name>-config` for its `OnePasswordItem`s).
2. Add the Application template to `charts/addons/templates/` or `charts/applications/templates/`
   with a finalizer, a `sync-wave`, `ServerSideApply=true`, automated `prune`+`selfHeal`.
3. If it installs CRDs, add its API group to `tests/gitops/crd-providers.yaml` and its name to
   `tests/gitops/huge-crd-charts.yaml`; add the CRD kinds you render to `tests/schemas/sources.yaml`
   and run `task schemas:vendor`.
4. Run `task verify:text`, fix findings, then `task test:snapshot -- --update`.
5. If it runs in localdev: add a `smoke:` block (URL + expected codes) to its values, seed any
   Secret it needs by name in `localdev/fakes/secrets.yaml`, and add `tests/e2e/<name>/`
   (see `tests/e2e/README.md`). Add health Lua + fixtures for any new custom resource kind
   (`tests/health/README.md`).
6. `task localdev:up && task verify:text LEVEL=2` on Kind.
7. Commit; the pre-commit hook re-runs level 0, CI re-runs level 0 (`verify.yml`) and level 2
   (`tilt-ci.yml`) on the PR.

## Renovate bumps

A chart bump changes rendered output, so the `snapshot` job fails — for Renovate exactly
as for a human. Nothing is committed on your behalf. On a pull request the job also
regenerates the snapshots inside the runner's working tree, uploads them as the
`snapshots-regenerated` artifact, and posts a sticky comment with the diff stat and the
full manifest diff, so the reviewer sees what the bump changes before accepting it.

To accept a bump: run `task test:snapshot -- --update` locally and commit, or download
the `snapshots-regenerated` artifact from the run and commit it. The job stays red until
`tests/snapshots` matches.

The job deliberately does not auto-commit. A commit pushed with `GITHUB_TOKEN` triggers
no workflows, so the PR would keep a stale, green-looking status; and Renovate stops
managing a branch that carries commits it did not write. `renovate.json5` automerges
patch bumps, which is the other half of the reason: a green snapshot job on a bump that
changed the render would merge an unreviewed manifest change.

A bump of an operator that ships CRDs must also re-vendor schemas
(`task schemas:vendor`); the `schemas` job fails until that commit is added.

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
