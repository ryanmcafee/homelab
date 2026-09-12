# Verification Runbook

How to verify GitOps changes before they reach the homelab cluster. Level 0 is the gate
every agent and human runs on every edit: it needs no cluster, no network beyond a cached
copy of the core Kubernetes schemas, and no PII. Levels 1–2 (Kind) and the production
feedback loop are tracked in [issue #261](https://github.com/ryanmcafee/homelab/issues/261).

## Quick Start

```bash
task verify                      # level 0, JSON summary on stdout, exit 0/1
task verify:text                 # same checks, human-readable failures first
task verify -- --env homelab     # one environment only
task verify:render -- --chart addons --keep   # keep the rendered manifests for inspection
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
| `render/<env>/<chart>` | `helm template --include-crds` succeeds for every chart in `charts/` with the values ArgoCD would use. `homelab` renders through the same two-stage path as the CMP (`config export` from `homelab.yaml.example` → helm); `localdev` renders with `values.yaml` + `values-localdev.yaml`. | Read the helm error in `findings`. |
| `lint/<env>/<chart>` | `helm lint` reports no `[ERROR]`. | Fix the chart. Warnings do not fail. |
| `kubeconform/<env>` | Every rendered object validates against the Kubernetes version in `configuration/versions.yaml` (`tools.kubernetes`) and the vendored CRD schemas in `tests/schemas/`. There is no `-skip` list. | A `could not find schema` finding means a new CRD kind: add it to `tests/schemas/sources.yaml` and run `task schemas:vendor`. Anything else is a real schema violation. |
| `pluto/<env>` | No deprecated or removed apiVersions for the target Kubernetes version. | Bump the apiVersion or the chart. |
| `gitops/<env>/paths` | Every Application `spec.source.path` exists and names value files that exist for that environment (or sets `ignoreMissingValueFiles`). | Create the missing `values-<env>.yaml` or the chart directory. |
| `gitops/<env>/waves` | `<x>-dependencies` syncs before `<x>`; `<x>-config` never shares a wave with `<x>`. | Adjust `argocd.argoproj.io/sync-wave`. |
| `gitops/<env>/crd-order` | Custom resources are synced after the Application that installs their CRD (registry: `tests/gitops/crd-providers.yaml`). | Move the consumer to a later wave, or register a new provider. |
| `gitops/<env>/repo-secrets` | Every OCI Helm source has a matching `argocd.argoproj.io/secret-type: repository` Secret with `enableOCI: "true"`. | Add the repository Secret next to the Application. |
| `gitops/<env>/secret-refs` | Every `secretKeyRef`/`secretRef`/`existingSecret` is produced in the same namespace by a rendered `Secret`, `OnePasswordItem`, `Certificate`, or is listed with a reason in `tests/gitops/known-secrets.yaml`. | Add the `OnePasswordItem` to the `*-config` chart, or register a known secret (with `reason`). |
| `gitops/<env>/namespaces` | Every destination namespace is declared as a `Namespace` object, created with `CreateNamespace=true`, or is a system namespace. | Declare it (with pod-security labels) or add the sync option. |
| `gitops/<env>/ssa` | Charts on the huge-CRD list (`tests/gitops/huge-crd-charts.yaml`) use `ServerSideApply=true`. | Add the sync option. |
| `gitops/<env>/unique-names` | No duplicate Application `namespace/name`. | Rename. |
| `snapshot/<env>/<chart>` | The render is byte-identical to `tests/snapshots/<env>/<chart>.yaml`. | Review the diff; if intended run `task test:snapshot -- --update` and commit. |
| `policy/<env>` | conftest policies in `tests/policy/` pass (finalizers, sync waves, SSA, automated sync, no `:latest`, resources on every container, no inline secrets, hostnames under the configured domain). | Fix the chart, or add `homelab.ryanmcafee.com/policy-exempt: "<rule-id>"` plus `homelab.ryanmcafee.com/policy-exempt-reason` on the object. |

Levels 1 and 2 (`task verify LEVEL=1|2`) are reserved for the Kind dry-run and Kind live
loops and currently exit with code 2 until Section B of #261 lands.

## Related commands

| Command | Purpose |
|---|---|
| `task test:snapshot` / `-- --update` | Diff or regenerate golden snapshots. |
| `task test:policy` | Rego unit tests plus every negative fixture in `tests/policy/negative/` must fail with its `# expect:` rule. |
| `task test:config` | Template ↔ schema ↔ `versions.yaml` contract tests (`internal/config/contract_test.go`). |
| `task test:cmp-parity` | Runs the pinned `ghcr.io/ryanmcafee/homelab-cmp:<tag>` image with Docker and diffs its `config export` against source. Fails when the image tag lags the Go source. |
| `task schemas:vendor` / `task schemas:check` | Regenerate or verify `tests/schemas/` from the chart versions in `configuration/versions.yaml`. |
| `task gpu:toggle-test` | GPU vendor toggle harness (`scripts/toggle-test.ts`); uses the same Kubernetes version and vendored schemas. |
| `task ci:test` | Everything above that needs no cluster; what CI runs. |

## Tooling

All tools are pinned in `mise.toml`: `helm`, `kubeconform`, `conftest`, `pluto`, `deno`, `go`.
Run `mise install` after pulling. Core Kubernetes schemas are cached under
`~/.cache/homelab-kubeconform` (first run downloads them; CI caches the directory).

## Adding a new chart or application

1. Add the chart under `charts/<name>` (and `charts/<name>-config` for its `OnePasswordItem`s).
2. Add the Application template to `charts/addons/templates/` or `charts/applications/templates/`
   with a finalizer, a `sync-wave`, `ServerSideApply=true`, automated `prune`+`selfHeal`.
3. If it installs CRDs, add its API group to `tests/gitops/crd-providers.yaml` and its name to
   `tests/gitops/huge-crd-charts.yaml`; add the CRD kinds you render to `tests/schemas/sources.yaml`
   and run `task schemas:vendor`.
4. Run `task verify:text`, fix findings, then `task test:snapshot -- --update`.
5. Commit; the pre-commit hook re-runs level 0 and CI (`verify.yml`) re-runs it on the PR.

## Renovate bumps

A chart bump changes rendered output. The `snapshot` job in `verify.yml` regenerates
snapshots on `renovate[bot]` PRs, pushes the update to the PR branch, and posts a sticky
comment with the manifest diff so the reviewer sees exactly what the bump changes. A bump
of an operator that ships CRDs must also re-vendor schemas (`task schemas:vendor`); the
`schemas` job fails until that commit is added.

## Reading failures from CI

The `level-0` job writes a summary table to the run's Job Summary and uploads
`verify-level0.json`. `jq '.checks[] | select(.status=="fail")' verify-level0.json` lists
every failing check with its findings.

## PII guard

`homelab config guard` runs in pre-commit (staged files under `configuration/`) and in CI
(`--ci`: every tracked YAML/JSON/Markdown file under `configuration/`, including
`environments/homelab.yaml.example`). Real values come from the gitignored
`environments/homelab.yaml` when present; without it the guard still applies shape rules
(routable IPs on `*_IP`/`*_VIP` keys, real-looking hostnames and mailboxes on domain keys).
Example/template files are held to a closed placeholder allowlist (`192.168.1.0/24`,
`your-*` labels, `example.com`, loopback, `.local`): any other value on a PII-shaped key
fails. A new placeholder convention must be added to the allowlist in
`internal/config/guard.go`. Widen the scope with `--paths` (issue #262 will add
`charts/**/values-homelab.yaml`).
