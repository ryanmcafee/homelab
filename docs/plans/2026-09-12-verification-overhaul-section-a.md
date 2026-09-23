# Verification Overhaul — Section A (Cluster-Free Static Verification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents and humans a `< 5 s`, cluster-free, PII-free, machine-readable verification of every chart in the repo (`task verify` → `{"level":0,"checks":[...],"pass":bool}`), covering items 1–8 of GitHub issue #261.

**Architecture:** A new Go package `internal/verify` renders every chart under `charts/` for two environments (`localdev` via plain Helm values; `homelab` via the two-stage config-export → helm path using the PII-free `homelab.yaml.example`), writes `<out>/<env>/<chart>.yaml`, and runs checks over the rendered objects: `helm lint`, `kubeconform` (no `-skip`, vendored CRD schemas, cluster version from `versions.yaml`), `pluto`, a GitOps graph linter, golden-snapshot diff, and `conftest` policies. Cobra subcommands `homelab verify render|gitops|snapshot|all` expose them; `task verify` wraps `verify all --level 0`. TypeScript scripts (Bun) vendor CRD schemas and run the CMP image parity test; Go tests enforce the config-template ↔ schema contract.

**Tech Stack:** Go 1.25 (cobra, yaml.v3, stdlib only), Helm 4, kubeconform 0.7, conftest (Rego), pluto, Bun (TypeScript, `js-yaml`), GitHub Actions, Taskfile, mise.

**Spec:** https://github.com/ryanmcafee/homelab/issues/261 — Section A, items 1–8, plus the Section-A slices of "Files to Create/Modify".

## Global Constraints

- Level 0 must run with **no cluster, no network beyond kubeconform's cached core schemas, no PII**: only `configuration/environments/{localdev.yaml,homelab.yaml.example}` are read. Never read `homelab.yaml`.
- Output contract: `{"level":0,"checks":[{"name","status":"pass|fail|skip","duration_ms","detail?","findings?"}],"pass":bool,"duration_ms"}`; exit 0 when `pass`, 1 otherwise, 2 on usage error.
- Check names are slash-scoped and stable: `render/<env>/<chart>`, `lint/<env>/<chart>`, `kubeconform/<env>`, `pluto/<env>`, `gitops/<env>/<rule>`, `snapshot/<env>/<chart>`, `policy/<env>`.
- Scripting is TypeScript on Bun with `--help`, and `--dry-run` where mutation happens. No Bash/Python scripts.
- Go: stdlib `testing`, table-driven, no testify. Tests must not need a cluster or the network. Shelling out to `helm`/`kubeconform`/`conftest`/`pluto` happens only in `internal/verify/tools.go` behind the `Runner` interface so tests can fake it.
- Kubernetes version for schema validation comes from `configuration/versions.yaml` `tools.kubernetes` (strip leading `v`). Never hard-code.
- No `-skip` lists anywhere (pre-commit, skill, scripts). Missing CRD schemas are failures; fix by vendoring the schema.
- Commit style: semantic (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), each task its own commit, pre-commit hooks must pass.

---

## File Structure

| Path | Responsibility |
|---|---|
| `internal/verify/types.go` (done) | `Check`, `Result`, `Env`, `Envs`, helpers |
| `internal/verify/manifest.go` (done) | `Doc`, `ParseMultiDoc`, `LoadRenderDir`, `RenderedFile` |
| `internal/verify/charts.go` (done) | `Chart`, `DiscoverCharts`, `ValuesFiles`, `FindRepoRoot` |
| `internal/verify/tools.go` | `Runner` interface (exec helm/kubeconform/pluto/conftest), `ExecRunner`, tool discovery, `KubernetesVersion(repoRoot)` |
| `internal/verify/render.go` | `Render(ctx, RenderOptions) (*RenderOutput, *Result)`: chart discovery, two-stage values, parallel `helm template`/`helm lint`, kubeconform, pluto, `_data.yaml` metadata |
| `internal/verify/gitops.go` | `LintGitOps(env, docs, GitOpsRegistry, repoRoot) []Check` — the eight graph rules |
| `internal/verify/gitops_registry.go` | Load `tests/gitops/{crd-providers,huge-crd-charts,known-secrets}.yaml` |
| `internal/verify/snapshot.go` | `Snapshot(out *RenderOutput, dir string, update bool) []Check` |
| `internal/verify/policy.go` | `Policy(ctx, runner, renderDir, policyDir, envs) []Check` (conftest wrapper) |
| `cmd/homelab/commands/verify_render.go` | `homelab verify render` |
| `cmd/homelab/commands/verify_gitops.go` | `homelab verify gitops` |
| `cmd/homelab/commands/verify_snapshot.go` | `homelab verify snapshot [--update]` |
| `cmd/homelab/commands/verify_all.go` | `homelab verify all --level 0` (render → gitops → snapshot → policy) |
| `tests/gitops/*.yaml` | Registries consumed by the GitOps linter |
| `tests/snapshots/<env>/<chart>.yaml` | Golden renders |
| `tests/policy/*.rego`, `tests/policy/*_test.rego`, `tests/policy/negative/*.yaml`, `tests/policy/positive/*.yaml` | conftest policies + fixtures |
| `tests/schemas/<group>/<kind>_<version>.json` + `tests/schemas/sources.yaml` | Vendored CRD JSON schemas |
| `scripts/crd-schemas-vendor.ts` | Generates `tests/schemas/` from pinned charts |
| `scripts/policy-test.ts` | Runs conftest on every negative fixture and asserts each fails with its expected rule |
| `scripts/cmp-parity-test.ts` | Docker-runs the pinned CMP image and diffs `config export` vs source |
| `internal/config/contract_test.go` | Template ↔ schema contract tests |
| `Taskfile.yml`, `.pre-commit-config.yaml`, `mise.toml`, `.github/workflows/verify.yml` | Wiring |
| `docs/runbooks/verification.md`, `docs/project_notes/*.md`, `.claude/skills/gitops-test/SKILL.md` (Tier 1 only) | Docs |

---

### Task 1: Tool runner and renderer (`homelab verify render`) — issue items 1, 7

**Files:**
- Create: `internal/verify/tools.go`, `internal/verify/render.go`, `internal/verify/render_test.go`, `internal/verify/tools_test.go`
- Replace stub: `cmd/homelab/commands/verify_render.go` (remove `newVerifyRenderCmd` from `verify_stubs.go`)

**Interfaces:**
- Consumes: `Chart`, `DiscoverCharts`, `ValuesFiles`, `Env`, `Envs`, `Check`, `Result`, `RenderedFile`, `config.LoadSchemaDir/LoadVersions/LoadEnvironment/Eval/Export` from `internal/config`.
- Produces:

```go
// tools.go
type Runner interface {
    Run(ctx context.Context, dir string, name string, args ...string) (stdout, stderr []byte, err error)
    LookPath(name string) (string, error)
}
type ExecRunner struct{}                       // real implementation via os/exec
func KubernetesVersion(repoRoot string) (string, error) // reads versions.yaml tools.kubernetes, strips "v"

// render.go
type RenderOptions struct {
    RepoRoot   string
    OutDir     string   // required; <OutDir>/<env>/<chart>.yaml + <OutDir>/<env>/_data.yaml
    Envs       []Env
    Charts     []string // optional name filter
    Parallel   int      // default runtime.NumCPU()
    SkipLint   bool
    SkipSchema bool     // skip kubeconform + pluto
    SchemaDir  string   // default <RepoRoot>/tests/schemas
    CacheDir   string   // kubeconform -cache; default $XDG_CACHE_HOME/homelab-kubeconform or <RepoRoot>/.cache/kubeconform
    Runner     Runner
}
type RenderOutput struct {
    Dir    string
    Envs   []Env
    Charts []Chart
    Files  map[string]map[string]string // env -> chart -> rendered file path
}
func Render(ctx context.Context, opts RenderOptions) (*RenderOutput, *Result)
```

- `_data.yaml` written per env: `env: <name>`, `domain: <DOMAIN from resolved config>`, `kubernetes_version: <x.y.z>` — consumed by conftest `--data`.

- [ ] **Step 1: Write failing tests** in `render_test.go` using a `fakeRunner` that records commands and returns canned YAML:
  - `TestRenderValuesArgsPerEnv`: for chart `addons` in env `homelab` the helm args contain `-f charts/addons/values.yaml -f <tmp>/homelab/_values/addons.yaml` (generated), and in env `localdev` contain `-f charts/addons/values.yaml -f charts/addons/values-localdev.yaml`; child chart `tailscale-config` in `homelab` gets `values.yaml` + `values-homelab.yaml`; in `localdev` only `values.yaml` (file absent) and the check detail mentions `values-localdev.yaml missing`.
  - `TestRenderWritesFilesAndData`: after `Render`, `RenderedFile(out, "homelab", "addons")` exists and `_data.yaml` contains `domain: your-domain.com`.
  - `TestRenderReportsHelmFailure`: fake runner returns error for one chart → that check is `fail` with stderr in findings, others pass, `Result.Pass == false`.
  - `TestKubeconformArgsUseVersionsYaml`: args include `-kubernetes-version 1.36.1`, `-strict`, `-schema-location default`, `-schema-location <schemaDir>/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json`, and NO `-skip`.
  - `TestMissingToolIsFailure`: `LookPath` error for `kubeconform` → check `kubeconform/<env>` status `fail` with detail naming the tool and `mise install`.
- [ ] **Step 2: Run** `go test ./internal/verify -run 'TestRender|TestKubeconform|TestMissingTool' -v` → FAIL (undefined).
- [ ] **Step 3: Implement** `tools.go` and `render.go`:
  - Discover charts; filter by `opts.Charts`.
  - For each env: load resolved config once (`config.LoadSchemaDir`, `LoadVersions`, `LoadEnvironment(defaults)`, `LoadEnvironment(env.EnvFile)`, `config.Eval(schema, versions, env.ConfigSet, defaults, envVals)`); write `_data.yaml`. For two-stage envs, `config.Export(rc, templates/<fmt>.tmpl)` for `helm-addons`/`helm-apps` to `<out>/<env>/_values/<chart>.yaml`.
  - Worker pool (`opts.Parallel`) runs per (env, chart): `helm template <chart> <path> --include-crds -f ...` → write file → check `render/<env>/<chart>`; then `helm lint <path> -f ...` → `lint/<env>/<chart>` (lint WARNING lines are not failures; `[ERROR]` is).
  - After all renders in an env: `kubeconform -strict -summary -output json -kubernetes-version <v> -cache <dir> -schema-location default -schema-location <schemaDir>/... <files...>` → parse JSON, `fail` with one finding per `statusError`/`statusInvalid` resource (`<file>: <kind>/<name>: <msg>`).
  - `pluto detect-files -d <out>/<env> --target-versions k8s=v<version> -o json` → fail with one finding per deprecated/removed item.
  - Timing per check; `Result.Finalize`.
- [ ] **Step 4: Run tests** → PASS. `go vet ./...`.
- [ ] **Step 5: Wire command** `verify_render.go`: flags `--env` (default `all`), `--chart` (repeatable), `--out-dir` (default: temp dir, deleted unless `--keep`), `--json`, `--skip-lint`, `--skip-schema`, `--parallel`. On `--json` print `Result.JSON()`; else `WriteText`. Exit code via returned error `errVerificationFailed` (main already exits 1). Run against the real repo: `go run ./cmd/homelab verify render --json | jq .pass` → expect `false` until Task 5 vendors schemas; `--skip-schema` → `true` and total `duration_ms < 5000`.
- [ ] **Step 6: Commit** `feat(verify): add homelab verify render (level 0 two-stage render, lint, kubeconform, pluto)`.

### Task 2: GitOps graph linter (`homelab verify gitops`) — issue item 2

**Files:**
- Create: `internal/verify/gitops.go`, `internal/verify/gitops_registry.go`, `internal/verify/gitops_test.go`, `internal/verify/testdata/gitops/*.yaml` (small hand-written rendered sets), `tests/gitops/crd-providers.yaml`, `tests/gitops/huge-crd-charts.yaml`, `tests/gitops/known-secrets.yaml`
- Replace stub: `cmd/homelab/commands/verify_gitops.go`

**Interfaces:**
- Consumes: `Doc` helpers, `LoadRenderDir`, `Check`, `Chart`, `DiscoverCharts`.
- Produces:

```go
type GitOpsRegistry struct {
    CRDProviders map[string]string   // apiGroup -> providing Application name (e.g. "cert-manager.io": "cert-manager")
    HugeCRDCharts []string            // Application names that must set ServerSideApply=true
    KnownSecrets  []KnownSecret       // {Name, Namespace ("*" ok), Reason} produced outside rendered charts
    SystemNamespaces []string         // argocd, kube-system, default, ...
}
func LoadGitOpsRegistry(repoRoot string) (*GitOpsRegistry, error)
func LintGitOps(env string, rendered map[string][]Doc /*chart->docs*/, reg *GitOpsRegistry, repoRoot string) []Check
```

Rules (one `Check` each, name `gitops/<env>/<rule>`, all findings listed):
1. `paths`: every `Application.spec.source.path` exists under repoRoot and every `spec.source.helm.valueFiles` entry exists in it, unless `spec.source.helm.ignoreMissingValueFiles: true`.
2. `waves`: for each Application `X` with siblings `X-dependencies` / `X-config` in the same rendered chart: `wave(X-dependencies) < wave(X)`; `wave(X-config) != wave(X)`. Missing sync-wave annotation → finding.
3. `crd-order`: each rendered non-Application object whose API group is in `CRDProviders` must be ordered after the provider Application. Ordering key = `(parentWave, wave)`: for objects inside a parent chart (addons/applications/bootstrap) `parentWave` = that parent's wave in the rendered `gitops` chart for this env and `wave` = the object's own sync-wave; for objects rendered from a child chart, `wave` = the wave of the Application (in the parent) whose `path` is that chart. Provider key = `(parentWave, providerAppWave)`. Compare lexicographically; equal or lower → finding. Providers in `bootstrap` (argocd, 1password) always precede addons/applications by parent wave.
4. `repo-secrets`: every Application with `spec.source.chart` whose `repoURL` has no `http://`/`https://` scheme (OCI) must have a rendered `Secret` with label `argocd.argoproj.io/secret-type: repository` and `stringData.url`/`data.url` equal to the repoURL and `enableOCI: "true"`.
5. `secret-refs`: every consumer reference (`secretKeyRef.name`, `secretRef.name`, `existingSecret`, `existingSecretName`, `envFrom[].secretRef.name`, `volumes[].secret.secretName`, and the same keys found by walking parsed `spec.source.helm.values` strings and `spec.source.helm.valuesObject`) must be produced in the same namespace by a rendered `Secret`, `OnePasswordItem`, `Certificate.spec.secretName`, or a `KnownSecrets` entry. Consumer namespace = object namespace, or the Application's `spec.destination.namespace` for helm-values references. Ingress `tls[].secretName` is excluded (cert-manager creates it).
6. `namespaces`: every `Application.spec.destination.namespace` must be a rendered `Namespace`, or the Application has `CreateNamespace=true` in `syncOptions`, or the namespace is in `SystemNamespaces`.
7. `ssa`: every Application whose name (or `spec.source.chart`) is in `HugeCRDCharts` has `ServerSideApply=true` in `syncOptions`.
8. `unique-names`: no two rendered Applications share `namespace/name`.

- [ ] **Step 1: Write failing tests** with in-memory docs built via `ParseMultiDoc` for each rule (one positive, one negative case per rule; table-driven `TestLintGitOpsRules`). Include a case for rule 3 using a `gitops` chart doc set with `addons` wave 1 and `bootstrap` wave 0.
- [ ] **Step 2: Run** `go test ./internal/verify -run TestLintGitOps -v` → FAIL.
- [ ] **Step 3: Implement** `gitops_registry.go` (yaml.v3 into the struct; defaults when a file is absent: `SystemNamespaces = [argocd, kube-system, kube-public, default]`) and `gitops.go`.
- [ ] **Step 4: Seed registries** from the real repo:
  - `crd-providers.yaml`: `cert-manager.io: cert-manager`, `traefik.io: traefik-external`, `onepassword.com: 1password-operator`, `tailscale.com: tailscale-operator`, `cilium.io: cilium`, `postgresql.cnpg.io: cloudnative-pg`, `monitoring.coreos.com: kube-prometheus-stack`, `externaldns.k8s.io: external-dns-cloudflare-crd`, `argoproj.io: argocd` (Applications themselves are excluded from rule 3), `deviceplugin.intel.com: intel-device-plugins-operator`, `nvidia.com: nvidia-gpu-operator`, `snapshot.storage.k8s.io: democratic-csi`.
  - `huge-crd-charts.yaml`: `kube-prometheus-stack, cilium, cert-manager, cloudnative-pg, tailscale-operator, nvidia-gpu-operator, intel-device-plugins-operator, argo-workflows, traefik-external, traefik-internal, democratic-csi, democratic-csi-ssd, democratic-csi-iscsi, democratic-csi-iscsi-hdd, external-dns-cloudflare-crd, argocd`.
  - `known-secrets.yaml`: secrets created by upstream Helm charts or operators (e.g. `argocd-initial-admin-secret`, `sops-age-key` (kustomize/ksops), `onepassword-connect-token`, `op-credentials`). Every entry needs a `reason`.
- [ ] **Step 5: Wire** `verify_gitops.go`: flags `--env`, `--render-dir` (if absent, call `Render` with `SkipLint`+`SkipSchema` into a temp dir), `--json`. Run on real repo: `go run ./cmd/homelab verify gitops --json`. Fix real findings by editing charts (e.g. add `ServerSideApply=true`, add missing repo Secret) or by registering a justified exception. Do not silence rules.
- [ ] **Step 6: Run** `go test ./internal/verify` → PASS. Commit `feat(verify): add homelab verify gitops graph linter`.

### Task 3: Golden snapshots (`homelab verify snapshot`) — issue item 3

**Files:**
- Create: `internal/verify/snapshot.go`, `internal/verify/snapshot_test.go`, `tests/snapshots/README.md`, `tests/snapshots/<env>/<chart>.yaml` (generated)
- Replace stub: `cmd/homelab/commands/verify_snapshot.go`
- Modify: `tests/fixtures/toggle-baseline/README.md` (point to snapshots as the general mechanism; the GPU baseline remains vendor-specific)

**Interfaces:**
- Consumes: `RenderOutput.Files`, `Check`.
- Produces: `func Snapshot(out *RenderOutput, snapshotDir string, update bool) ([]Check, error)`; `func UnifiedDiff(name string, want, got []byte) string` (pure-Go line diff, max 200 lines then `... truncated`).

- [ ] **Step 1: Failing tests**: `TestSnapshotDetectsDrift` (temp snapshot dir with a differing file → `fail` with a diff in findings), `TestSnapshotUpdateWrites`, `TestSnapshotMissingIsFailureWithHint` (detail says `run: task test:snapshot -- --update`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Snapshots are the exact rendered bytes (no normalisation). **Step 4:** tests PASS.
- [ ] **Step 5: Wire** `verify_snapshot.go` (`--update`, `--env`, `--chart`, `--json`, `--snapshot-dir` default `tests/snapshots`). Generate real snapshots: `go run ./cmd/homelab verify snapshot --update` then `git diff --stat`.
- [ ] **Step 6: Commit** `feat(verify): golden snapshots for every chart and env`.

### Task 4: Policy-as-code with conftest — issue item 4

**Files:**
- Create: `tests/policy/application.rego`, `tests/policy/workload.rego`, `tests/policy/secret.rego`, `tests/policy/hostname.rego`, `tests/policy/lib.rego`, `tests/policy/*_test.rego`, `tests/policy/negative/<rule>.yaml` (one file per rule, header `# expect: <rule-id>`), `tests/policy/positive/*.yaml`, `tests/policy/README.md`, `scripts/policy-test.ts`, `internal/verify/policy.go`, `internal/verify/policy_test.go`
- Modify: `mise.toml` (add `conftest`, `pluto`), `charts/addons/templates/cilium.yaml` (exemption annotation, see below), `charts/gitops/values-localdev.yaml` (enable `automated.prune/selfHeal` so parents comply and Section B's `localdev:wait` can work)

**Rules** (package `homelab.<area>`, deny messages formatted `[<rule-id>] <kind>/<ns>/<name>: <why>`):
- `app-finalizer`: Applications have `resources-finalizer.argocd.argoproj.io`.
- `app-sync-wave`: Applications carry a numeric `argocd.argoproj.io/sync-wave`.
- `app-ssa`: Applications include `ServerSideApply=true`.
- `app-automated`: `syncPolicy.automated.prune == true` and `selfHeal == true`.
- `image-latest`: no container image ending in `:latest` or without a tag, in rendered workloads and in parsed `helm.values` `image.tag`.
- `container-resources`: every container in Deployment/StatefulSet/DaemonSet/Job/CronJob/Pod sets `resources.requests` and `resources.limits` (cpu+memory).
- `inline-secret`: `Secret` objects may only carry keys `name,url,type,enableOCI,project,insecure` (repository secrets) — anything else is an inline secret.
- `hostname-domain`: every Ingress host, IngressRoute `Host(...)` match, Certificate `dnsNames[]`, and DNSEndpoint `dnsName` ends with `.` + `data.domain` (from `_data.yaml`).
- Exemptions: annotation `homelab.<DOMAIN>/policy-exempt: "<rule-id>[,<rule-id>]"` with a sibling `homelab.<DOMAIN>/policy-exempt-reason`. Cilium's visibility-only Application is exempt from `app-automated`.

- [ ] **Step 1:** Write `*_test.rego` unit tests and the negative fixtures first; `conftest verify -p tests/policy` → FAIL (rules undefined).
- [ ] **Step 2:** Implement rules; `conftest verify -p tests/policy` → PASS.
- [ ] **Step 3:** `scripts/policy-test.ts` (`--help`, `--policy-dir`, `--fixtures-dir`): for each `negative/*.yaml` run `conftest test -p tests/policy --data tests/policy/negative/_data.yaml -o json <file>` and assert the output contains a failure whose msg starts with `[<expect>]`; for `positive/*.yaml` assert zero failures. Exit 1 on any mismatch, print a table.
- [ ] **Step 4:** `internal/verify/policy.go`: `func Policy(ctx, r Runner, renderDir, policyDir string, envs []Env) []Check` → runs `conftest test -p <policyDir> --data <renderDir>/<env>/_data.yaml -o json <renderDir>/<env>/*.yaml` per env, parses JSON, one finding per failure. Test with fake runner.
- [ ] **Step 5:** Run against real renders; fix charts or add justified exemptions until `policy/homelab` and `policy/localdev` pass.
- [ ] **Step 6:** Commit `feat(verify): conftest policies with negative fixtures`.

### Task 5: Vendored CRD JSON schemas — issue item 8

**Files:**
- Create: `scripts/crd-schemas-vendor.ts`, `tests/schemas/sources.yaml`, `tests/schemas/README.md`, generated `tests/schemas/<group>/<kind>_<version>.json`
- Modify: `Taskfile.yml` (`schemas:vendor`), `renovate.json` (postUpgrade note in README only; Renovate cannot run tasks on hosted, so `verify.yml` re-vendors and fails with a diff instruction)

`sources.yaml` (chart version keys refer to `configuration/versions.yaml` `charts.<key>`):
```yaml
sources:
  - name: argo-cd
    versionKey: argocd
    chart: {repo: https://argoproj.github.io/argo-helm, name: argo-cd}
    kinds: [Application, AppProject, ApplicationSet]
  - name: argo-workflows
    versionKey: argo-workflows
    chart: {repo: https://argoproj.github.io/argo-helm, name: argo-workflows}
    kinds: [CronWorkflow, Workflow, WorkflowTemplate]
  - name: cert-manager
    versionKey: cert-manager
    chart: {repo: https://charts.jetstack.io, name: cert-manager}
    helmArgs: ["--set", "crds.enabled=true"]
    kinds: [Certificate, ClusterIssuer, Issuer]
  - name: traefik
    versionKey: traefik
    chart: {repo: https://traefik.github.io/charts, name: traefik}
    kinds: [IngressRoute, Middleware, IngressRouteTCP, TLSOption, ServersTransport]
  - name: onepassword-connect
    versionKey: onepassword-connect
    chart: {repo: https://1password.github.io/connect-helm-charts, name: connect}
    kinds: [OnePasswordItem]
  - name: external-dns
    versionKey: external-dns
    chart: {repo: https://kubernetes-sigs.github.io/external-dns/, name: external-dns}
    helmArgs: ["--set", "crd.create=true"]
    kinds: [DNSEndpoint]
  - name: cilium
    versionKey: cilium
    github: {repo: cilium/cilium, path: pkg/k8s/apis/cilium.io/client/crds/v2alpha1, tagPrefix: v}   # plus v2 dir
    kinds: [CiliumLoadBalancerIPPool, CiliumL2AnnouncementPolicy, CiliumBGPClusterConfig, CiliumBGPPeerConfig, CiliumBGPAdvertisement]
  - name: tailscale-operator
    versionKey: tailscale-operator
    chart: {repo: https://pkgs.tailscale.com/helmcharts, name: tailscale-operator}
    kinds: [Connector, ProxyClass]
  - name: cloudnative-pg
    versionKey: cloudnative-pg
    chart: {repo: https://cloudnative-pg.github.io/charts, name: cloudnative-pg}
    kinds: [Cluster, Pooler, ScheduledBackup, Backup]
  - name: kube-prometheus-stack
    versionKey: kube-prometheus-stack
    chart: {repo: https://prometheus-community.github.io/helm-charts, name: kube-prometheus-stack}
    kinds: [ServiceMonitor, PodMonitor, PrometheusRule]
```
(Fix repo URLs/kinds to what the pinned charts actually ship; verify with `helm show crds`.)

- [ ] **Step 1:** Script (`--help`, `--dry-run`, `--only <name>`, `--check` = fail if regenerating would change files): for each source, `helm pull <repo>/<name> --version <v> --untar -d <tmp>` then `helm show crds <dir>` (falls back to `helm template --include-crds <helmArgs>`), or fetch GitHub raw files for `github` sources; split CRDs; for each requested kind and each `spec.versions[]` write `tests/schemas/<group>/<lowercase kind>_<version>.json` = `openAPIV3Schema` with `$schema: http://json-schema.org/draft-07/schema#`, `x-kubernetes-*` keys stripped, `additionalProperties` left as-is (kubeconform `-strict` semantics), and a top-level `properties.apiVersion/kind/metadata` ensured. Deterministic key ordering (sorted JSON) so diffs are stable. Missing kind in a chart → error listing available kinds.
- [ ] **Step 2:** Generate, then `go run ./cmd/homelab verify render --json | jq .pass` → must be `true`. Add any kind kubeconform still reports.
- [ ] **Step 3:** Task `schemas:vendor` and `schemas:check` in Taskfile. Commit `feat(verify): vendor CRD JSON schemas for offline kubeconform`.

### Task 6: Config-system contract tests — issue item 5

**Files:**
- Create: `internal/config/contract_test.go`
- Modify: `internal/config/parity_test.go` only if helpers need exporting.

- [ ] **Step 1:** Tests (use `findProjectRootForTest` + real `configuration/`):
  - `TestTemplatesReferenceOnlyDeclaredKeys`: regex `\.Values\.([A-Z0-9_]+)\.Value` over every `templates/*.tmpl` → each key in `schema.Keys`.
  - `TestDeclaredKeysAreReferenced`: every schema key appears in some template, or in the explicit `consumedOutsideTemplates` map (key → where, e.g. `CP2_IP: terragrunt via tfvars? no — talos config`). Test also fails if an allowlisted key becomes referenced (keeps the list honest).
  - `TestExampleRendersEveryTemplate`: `Eval` with `homelab.yaml.example` and with `localdev.yaml` then `Export` for every template → no error, non-empty output, no `<no value>` string.
  - `TestVersionsReferencedExist`: every `.Versions.Charts.<x>` / `index .Versions.Charts "<x>"` / `.Versions.Tools.<x>` / `.Versions.Images "<x>"` in templates exists in `versions.yaml`.
- [ ] **Step 2:** Run → observe failures; fix real problems in schema/templates (unreferenced keys either get used, removed, or allowlisted with a reason).
- [ ] **Step 3:** Commit `test(config): template/schema contract tests`.

### Task 7: CMP image parity + toggle-test version fix — issue items 6, 7

**Files:**
- Create: `scripts/cmp-parity-test.ts`
- Modify: `scripts/toggle-test.ts` (read `tools.kubernetes` from `configuration/versions.yaml` via `@std/yaml`; keep the `-strict` flags; also use `-schema-location tests/schemas/...` and remove `-ignore-missing-schemas`), `Taskfile.yml` (`test:cmp-parity`)

- [ ] **Step 1:** `cmp-parity-test.ts` (`--help`, `--dry-run`, `--tag <override>`): read tag from `charts/bootstrap/values.yaml` (`argocd.values.repoServer.extraContainers[0].image`) and assert it equals `configuration/versions.yaml` `images.homelab-cmp`; for each format `helm-addons`,`helm-apps`: `docker run --rm --entrypoint homelab -v <repo>:/repo:ro -w /repo/charts/<x> ghcr.io/ryanmcafee/homelab-cmp:<tag> config export --set homelab --format <fmt> --env-file /repo/configuration/environments/homelab.yaml.example --config-root /repo/configuration --stdout` vs `go run ./cmd/homelab config export ...`; diff; also compare `homelab --version` strings when available. Exit 1 with unified diff and the message "CMP image <tag> lags source: run `task cmp:bump` and merge the image build".
- [ ] **Step 2:** Run it locally (requires Docker + ghcr pull). Record the result in the PR body.
- [ ] **Step 3:** Commit `test: CMP image parity test and versions.yaml-driven kubeconform version`.

### Task 8: Wiring — Taskfile, pre-commit, mise, CI workflow, `verify all`

**Files:**
- Create: `cmd/homelab/commands/verify_all.go`, `.github/workflows/verify.yml`
- Modify: `Taskfile.yml`, `.pre-commit-config.yaml`, `mise.toml`, `.gitignore` (`.cache/`), delete `verify_stubs.go`

- [ ] `verify_all.go`: `homelab verify all --level 0 [--json] [--env] [--keep-render-dir]` = Render (temp dir) → LintGitOps → Snapshot (compare) → Policy; merged `Result` with `level` set; `--level 1|2` return `exit 2` with "implemented in Section B/D (#261)".
- [ ] Taskfile:
  - `verify`: `go run ./cmd/homelab verify all --level {{.LEVEL | default "0"}} --json {{.CLI_ARGS}}` (doc: `task verify` or `task verify LEVEL=0`).
  - `verify:text`: same without `--json`.
  - `test:snapshot`: `go run ./cmd/homelab verify snapshot {{.CLI_ARGS}}` (`task test:snapshot -- --update`).
  - `test:policy`: `conftest verify -p tests/policy && bun scripts/policy-test.ts`.
  - `test:cmp-parity`, `test:config` (`go test ./internal/config/...`), `test:go` (`go test ./...`), `schemas:vendor`, `schemas:check`.
  - `ci:test`: `ci:lint` → `tf:validate` → `test:go` → `verify` → `test:policy` (no `localdev:up`). Section B adds `localdev:ci`.
- [ ] `.pre-commit-config.yaml`: replace `helm-template-*` and `kubeconform-*` hooks with one `verify-level-0` hook (`task verify`, `pass_filenames: false`, `files: ^(charts/|configuration/|tests/(schemas|policy|gitops|snapshots)/)`). Keep `helm-lint`? No — lint is inside `verify`; remove to avoid double work.
- [ ] `mise.toml`: `conftest = "latest"`, `pluto = "latest"`.
- [ ] `verify.yml`: triggers on PR/push for `charts/**`, `configuration/**`, `tests/**`, `cmd/**`, `internal/**`, `scripts/**`, `Taskfile.yml`. Jobs: `level-0` (setup go 1.25, helm, kubeconform, conftest, pluto — all SHA/version-pinned; cache `~/.cache/homelab-kubeconform`; `task verify` → upload `verify-level0.json` artifact and write a summary table to `$GITHUB_STEP_SUMMARY`), `policy` (`task test:policy`), `schemas` (`task schemas:check`), `snapshot` (`task test:snapshot`; on `renovate[bot]` PRs run `--update`, commit `chore(snapshots): regenerate for dependency bump` back to the PR branch and post the diff stat as a sticky comment via `marocchino/sticky-pull-request-comment`), `cmp-parity` (`task test:cmp-parity`, needs Docker — ubuntu has it). Remove the `helm-lint` job from `tilt-ci.yml` (superseded).
- [ ] Verify end-to-end locally: `task verify` (< 5 s on this machine, record `duration_ms`), `task test:snapshot`, `task test:policy`, `pre-commit run --all-files`, `go test ./...`.
- [ ] Commit `feat(verify): task verify, pre-commit and CI wiring for level 0`.

### Task 9: Docs and memory

**Files:**
- Create: `docs/runbooks/verification.md`
- Modify: `docs/local-development.md` (Testing Strategies section → link runbook), `docs/project_notes/decisions.md` (ADR-009: "Level 0 static verification is the agent gate; no `-skip` schema validation"), `docs/project_notes/key_facts.md` (verification commands), `docs/project_notes/issues.md` (PR entry), `.claude/skills/gitops-test/SKILL.md` Tier 1 → `task verify` (Tiers 2–5 rewritten in Section D), `CLAUDE.md` Taskfile Quick Reference (+ `task docs:embedme`), `AGENTS.md` validation flow (Tier 1 = `task verify`).

- [ ] Write runbook: what level 0 checks, JSON contract, how to read failures per check family, how to update snapshots/schemas/registries/policies, exemption annotations, adding a new chart checklist.
- [ ] Commit `docs: verification runbook, ADR-009, skill/agent updates for level 0`.

---

## Self-Review Notes

- Spec coverage: item 1 → Task 1+8; 2 → Task 2; 3 → Task 3; 4 → Task 4; 5 → Task 6; 6 → Task 7; 7 → Task 1 (`KubernetesVersion`) + Task 7 (toggle-test); 8 → Task 5. Files-to-create for Section A: `verify_render.go`, `verify_gitops.go`, `tests/snapshots`, `tests/schemas`, `tests/policy`, `verify.yml`, `docs/runbooks/verification.md` — all covered. Files-to-modify for A: `scripts/toggle-test.ts`, `Taskfile.yml`, `.pre-commit-config.yaml` — covered.
- Deviation from spec: rule 2 uses `dependencies < main` and `config != main` instead of `dependencies < main < config`, because the repo's `*-config` charts that only provision `OnePasswordItem`s deliberately run *before* their main chart (tailscale-config 1 < tailscale-operator 2). Ordering of CR-producing config charts is enforced by rule 3 instead.
