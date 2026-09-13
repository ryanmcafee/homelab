# Verification Overhaul — Section B: Kind + ArgoCD loop (Levels 1–2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents and humans a working Kind + ArgoCD loop: every localdev Application syncs from the working tree with `argocd app sync --local`, reaches Synced/Healthy behind localdev fakes, is covered by Chainsaw e2e tests, health Lua for custom CRs and PostSync smoke hooks, and is exercised by a required CI job (issue #261 items 9–15).

**Architecture:** Kind (Cilium CNI, registry pull-through caches) is bootstrapped by `scripts/localdev-kind.ts`; ArgoCD is installed by `scripts/localdev-argocd.ts` from the chart version in `configuration/versions.yaml` with the health Lua from `charts/bootstrap/files/health`; the root `gitops` Application points at GitHub `main` but every Application is synced from the working tree with `argocd app sync --local`, wave by wave, which requires **automated sync off in localdev** (a new `ARGOCD_AUTOMATED_SYNC` capability key). Platform differences stay capability keys in `configuration/schema/platform.schema.yaml` (ADR-011), never set-name branches. `homelab verify all --level 1|2` reads the cluster (server dry-run, Application state, chainsaw report) and emits the same JSON contract as level 0.

**Tech Stack:** Deno/TypeScript scripts, Go (cobra, `internal/verify.Runner`), Helm 4.2.0, kind v0.33.0 + `kindest/node:v1.36.1`, Cilium (chart pin in versions.yaml), ArgoCD CLI v3.5.2, Chainsaw v0.2.15, conftest, GitHub Actions.

**Spec:** https://github.com/ryanmcafee/homelab/issues/261 (Section B, items 9–15) + ADR-009/010/011 in `docs/project_notes/decisions.md`.

## Global Constraints

- TypeScript (Deno) for every script; no Bash/Python scripts (ADR-005). Shebang `#!/usr/bin/env -S deno run --allow-...` with exact permissions, `--help`, `--dry-run` where destructive, colour log helpers (cyan INFO, green OK, red ERROR, yellow WARN), exit 0/1. Pure logic in exported functions with `scripts/<name>_test.ts` (`deno test scripts/`, `deno fmt --check scripts/`, `deno check scripts/*.ts` run in CI).
- Never hand-edit `charts/{addons,applications}/values-localdev.yaml` (generated: `task config:export:localdev`) or `tests/snapshots/**` (`task test:snapshot -- --update`). **Subagents must NOT regenerate snapshots or the localdev values files** — the integrator does that once per wave. Judge your work with `task verify:text` ignoring `snapshot/*` and `render/localdev/_committed-values` failures caused by your own change.
- Every rendered Application needs finalizer, numeric sync-wave, `ServerSideApply=true`; every container needs resources; no `:latest`; no inline secrets; hostnames under the env domain (tests/policy).
- Single source of truth for versions: `configuration/versions.yaml` (`charts.*`, `images.curl`, `images.kind-node`, `tools.kind`, `tools.chainsaw`, `tools.argocd`, `tools.kubernetes`, `tools.helm`) — already pinned. `mise.toml` mirrors them (kind 0.33.0, argocd 3.5.2, `aqua:kyverno/chainsaw` 0.2.15, stern).
- Kind cluster name `homelab-localdev`, kube context `kind-homelab-localdev`, ArgoCD namespace `argocd`, localdev domain `homelab.local`, root Application name `gitops`.
- Agents may mutate only Kind (ADR-009). Nothing here touches production.
- Shared worktree: each work package owns the files listed under it and touches nothing else. `Taskfile.yml` tasks already exist (see "Task contract") — do not edit `Taskfile.yml`.

## Task contract (already in Taskfile.yml)

| Task | Command |
|---|---|
| `localdev:kind` | `deno run ... scripts/localdev-kind.ts up` |
| `localdev:fakes` | `scripts/localdev-kind.ts fakes` |
| `localdev:registry` | `scripts/localdev-kind.ts registry up|down|status` |
| `localdev:down` | `tilt down ...; scripts/localdev-kind.ts down` |
| `localdev:argocd` | `scripts/localdev-argocd.ts install` (install + root app) |
| `localdev:sync` | `scripts/localdev-argocd.ts sync [--warm]` |
| `localdev:wait` | `scripts/localdev-argocd.ts wait` |
| `localdev:diagnose` | `scripts/localdev-argocd.ts diagnose` |
| `localdev:warm` | kind + argocd + `sync --warm` |
| `localdev:up` | kind + argocd + sync |
| `localdev:ci` | kind + argocd + sync + wait + test:e2e |
| `localdev:tilt:argocd` | `tilt up -- --mode=argocd` |
| `test:e2e` | `chainsaw test --config tests/e2e/.chainsaw.yaml tests/e2e` |
| `test:health` | `scripts/health-test.ts` |
| `verify LEVEL=1|2` | `homelab verify all --level N --json` |

## Cross-package interfaces

- **`ARGOCD_AUTOMATED_SYNC`** (platform key, `"true"`/`"false"`, default `"true"`, localdev `"false"`): every Application template wraps its `automated:` block in `{{- if .Values.global.automatedSync }}`; base `values.yaml` of gitops/addons/applications/bootstrap sets `global.automatedSync: true`; the generated localdev files set `false`. `render.go` writes `argocd_automated_sync: <true|false>` into `_data.yaml`; `tests/policy/application.rego` skips `app-automated` when `data.argocd_automated_sync == false`.
- **Root app** `localdev/argocd/gitops-app.yaml`: Application `gitops`/`argocd`, repoURL `https://github.com/ryanmcafee/homelab.git`, targetRevision `main`, path `charts/gitops`, `helm.valueFiles: [values.yaml, values-localdev.yaml]`, **no** `automated`, syncOptions `CreateNamespace=true, ServerSideApply=true`, finalizer, sync-wave `"0"`.
- **Sync orchestration** (`localdev-argocd.ts sync`): logs into ArgoCD at `localhost:8080` (Kind maps NodePort 30080 → host 8080; `localdev/values/argocd-values.yaml` sets `server.service.nodePortHttp: 30080`; Traefik NodePorts in `charts/addons/values-localdev.yaml` must not use 30080 — WP-A verifies). Tier = `(parentWave, ownWave)` where parent = Application named in label `app.kubernetes.io/instance` (root has none → parentWave -1000). Git-path apps sync with `argocd app sync <app> --local <repoRoot>/<spec.source.path> --local-repo-root <repoRoot> --prune --async`; chart apps with `argocd app sync <app> --prune --async`. A tier is complete when each app is `Healthy` with `operationState.phase == Succeeded` **or** its operation is `Running` and `status.resources[]` contains `kind: Application` (parent waiting on children). Failed/Error operations retry 3× with 15 s backoff, then fail with diagnostics.
- **Fakes** live in `localdev/fakes/*.yaml`, applied with `kubectl apply --server-side -f localdev/fakes/` (`localdev-kind.ts fakes`). Provisioner `rancher.io/local-path`.
- **Health Lua** lives in `charts/bootstrap/files/health/<group>_<kind>.lua`; `charts/bootstrap/templates/argocd.yaml` injects every file as `configs.cm."resource.customizations.health.<group>_<kind>"`; `localdev-argocd.ts install` passes the same files with `--set-file 'configs.cm.resource\.customizations\.health\.<group>_<kind>=<path>'`.
- **Cilium** in Kind is installed by `localdev-kind.ts` with the values extracted from `charts/addons/values-localdev.yaml` `cilium.values` (yq), chart version `charts.cilium` from versions.yaml, release `cilium`, namespace `kube-system`; the `cilium` Application then adopts it (values identical → no-op).
- **Smoke hooks**: `.Values.<app>.smoke: {enabled, url, expect: [codes]}`; Job `smoke-<app>` in the app namespace, `argocd.argoproj.io/hook: PostSync`, `hook-delete-policy: BeforeHookCreation,HookSucceeded`, same sync-wave as the app, image `curlimages/curl:{{ .Values.global.images.curl }}` (`global.images.curl` = `images.curl` from versions.yaml via the templates; base values placeholder `"8.22.0"`).
- **Chainsaw**: `tests/e2e/.chainsaw.yaml` + `tests/e2e/<app>/chainsaw-test.yaml`; Applications asserted in namespace `argocd`; curl Jobs go through Traefik internal `http://traefik-internal.traefik.svc.cluster.local:8000` with `Host: <app>.homelab.local` (WP-G confirms the service name/port from the rendered localdev snapshot).
- **Go level 1/2** (`internal/verify/cluster.go`): `DryRun` → checks `dryrun/localdev/<chart>`; `ArgoCDApps` → `argocd/<app>`; `Chainsaw` → `e2e/<test>`; `verify all --level 1|2 --kube-context kind-homelab-localdev`.

---

## WP-A: Capability keys, automated-sync switch, Kind-safe values (owner: config/templates)

**Files:**
- Modify: `configuration/schema/platform.schema.yaml` (add `ARGOCD_AUTOMATED_SYNC`, `MEDIA_PROVIDER` enum `nfs|ephemeral` default `nfs`, `CERT_ISSUER` enum `letsencrypt|selfsigned` default `letsencrypt`)
- Modify: `configuration/environments/localdev.yaml` (`CNI_PROVIDER: cilium`, `ARGOCD_AUTOMATED_SYNC: "false"`, `MEDIA_PROVIDER: ephemeral`, `CERT_ISSUER: selfsigned`)
- Modify: `configuration/templates/helm-addons.tmpl`, `configuration/templates/helm-apps.tmpl`
- Modify: `charts/addons/values.yaml`, `charts/applications/values.yaml`, `charts/gitops/values.yaml`, `charts/gitops/values-localdev.yaml`, `charts/bootstrap/values-localdev.yaml`
- Modify: every `charts/*/templates/*.yaml` that has an `automated:` block **except** `charts/bootstrap/templates/argocd.yaml` (WP-C owns it)
- Modify: `charts/addons/templates/cilium.yaml`, `charts/addons/templates/cert-manager.yaml`, `charts/cert-manager-cluster-issuer/{templates/cluster-issuer.yaml,values.yaml,values-localdev.yaml}`
- Modify: `internal/verify/render.go` (`_data.yaml` gets `argocd_automated_sync`), `internal/verify/render_test.go`
- Modify: `tests/policy/application.rego`, `tests/policy/application_test.rego`, `tests/policy/lib.rego`
- Modify: `internal/config/contract_test.go` only if a new key must be listed as consumed outside templates.

**Produces:** `global.automatedSync`, `global.images.curl` (in base values + templates: `images: {curl: "{{ .Versions.Images.curl }}"}` under `global`), `cilium.values` map, `cert-manager.selfSigned` bool → child `selfSigned.enabled`.

- [ ] **A1 Schema + env.** Add the three keys with descriptions in the style of the existing ones. `homelab config validate --set localdev` and `--set homelab` pass. `go test ./internal/config/...` passes (the contract test requires every key be referenced by a template — do the template work before running it).
- [ ] **A2 Automated-sync switch.** In `helm-addons.tmpl` / `helm-apps.tmpl` add `{{- $automated := eq .Values.ARGOCD_AUTOMATED_SYNC.Value "true" -}}` and emit `global.automatedSync: {{ $automated }}` plus `global.images.curl: "{{ .Versions.Images.curl }}"`. Base `values.yaml` for gitops/addons/applications/bootstrap: `global.automatedSync: true`, `global.images.curl: "8.22.0"`. Wrap every hard-coded `automated:` block in the 43 templates:
  ```yaml
  syncPolicy:
    {{- if .Values.global.automatedSync }}
    automated:
      prune: true
      selfHeal: true
    {{- end }}
    syncOptions:
  ```
  (Keep the cilium `prune: false` as is inside the wrapper.) In `charts/gitops/values-localdev.yaml` delete the three `syncPolicy.automated` blocks and set `global.targetRevision: main` (fixes the HEAD/main skew). `charts/bootstrap/values-localdev.yaml`: `global.automatedSync: false`, `sops-secrets.enabled: false`, `onepassword-operator.enabled: false`, `homelab-environment-config.enabled: false` (check exact key names in `charts/bootstrap/values.yaml`), and rewrite the header comment to describe the Section B state (fakes in `localdev/fakes`, no 1Password in Kind).
- [ ] **A3 Policy + `_data.yaml`.** `render.go` `prepareEnv`: read `rc.Values["ARGOCD_AUTOMATED_SYNC"]` (default `"true"`) and write `argocd_automated_sync: true|false`. `lib.rego`: `automated_sync_required if { object.get(data, "argocd_automated_sync", true) != false }`. `application.rego` `app-automated` (both prune and selfHeal rules): add `lib.automated_sync_required`. Unit test in `application_test.rego` with `with data.argocd_automated_sync as false`. Go test: `_data.yaml` contains the line for localdev=false / homelab=true (fake runner).
- [ ] **A4 Cilium values-driven.** Move the inline `helm.values` of `charts/addons/templates/cilium.yaml` to `{{- toYaml .Values.cilium.values | nindent 8 }}`; put the current homelab values (verbatim) under `cilium.values` in `charts/addons/values.yaml` and in `helm-addons.tmpl` with a `{{- if $localdev }}` branch producing Kind values:
  ```yaml
  ipam: {mode: kubernetes}
  kubeProxyReplacement: false
  operator: {replicas: 1, resources: {requests: {cpu: 50m, memory: 128Mi}, limits: {cpu: 500m, memory: 512Mi}}}
  resources: {requests: {cpu: 100m, memory: 256Mi}, limits: {cpu: 1000m, memory: 1Gi}}
  hubble: {enabled: false}
  image: {pullPolicy: IfNotPresent}
  ```
  Homelab render must stay semantically identical (the homelab snapshot may only change by key ordering). Update the cilium.yaml header comment: in homelab Talos installs Cilium, in Kind `scripts/localdev-kind.ts` installs it from these same values, the Application adopts either.
- [ ] **A5 Self-signed issuer.** `helm-addons.tmpl` cert-manager block: `selfSigned: {{ eq .Values.CERT_ISSUER.Value "selfsigned" }}`; base `charts/addons/values.yaml` `cert-manager.selfSigned: false`; `charts/addons/templates/cert-manager.yaml` valuesObject adds `selfSigned: {enabled: <bool>}`; `charts/cert-manager-cluster-issuer/values.yaml` adds `selfSigned: {enabled: false}`; `templates/cluster-issuer.yaml`: when `selfSigned.enabled`, render `ClusterIssuer/letsencrypt` with `spec: {selfSigned: {}}` (same name, so every `cluster-issuer: letsencrypt` reference keeps working) instead of the ACME spec. Update `values-localdev.yaml` comments (drop the `.test` mention; domain is `homelab.local`).
- [ ] **A6 Kind-safe storage/media.** `helm-apps.tmpl`: `{{- $csi := eq .Values.STORAGE_PROVIDER.Value "democratic-csi" -}}`, `{{- $nfsMedia := eq .Values.MEDIA_PROVIDER.Value "nfs" -}}`. Plex: when not `$csi` omit `configExistingClaim` and set `storageClassName: {{ .Values.STORAGE_CLASS_ISCSI.Value }}`; when not `$nfsMedia` render `extraVolumes` entries as `emptyDir: {}` instead of `nfs:`. TrueCharts apps (sonarr, radarr, prowlarr, nzbget, tautulli, lazylibrarian, flaresolverr, mosquitto, homeassistant): when not `$csi` replace `existingClaim` with `storageClass: {{ .Values.STORAGE_CLASS_ISCSI.Value }}` + `size: 1Gi`; when not `$nfsMedia` render media/download mounts as `type: emptyDir` (keep `mountPath`). Remove the dead `argocd:` block near the end of `helm-apps.tmpl` (no template consumes it).
- [ ] **A7 CNPG in Kind.** `cloudnative-pg.enabled: true` for localdev with Kind sizing (`resources` small, `replicaCount: 1` if the chart supports it) — update the comment: Kind runs the operator so CNPG e2e (`tests/e2e/cloudnative-pg`) and future consumers (#260) work on local-path.
- [ ] **A8 Verify.** `go test ./internal/... ./cmd/...`, `conftest verify -p tests/policy`, `task test:policy`, `task verify:text` (only snapshot/committed-values failures allowed). Check Traefik NodePorts in the *regenerated preview* (`go run ./cmd/homelab config export --set localdev --format helm-addons --stdout | rg nodePort`) do not use 30080; if they do, move Traefik to 30081/30444 in the template and note it for WP-B (kind-config maps 30080→8080 for ArgoCD, 80/443 → 9080/9443 for Traefik hostPorts). Report the list of files touched.

## WP-B: Kind bootstrap script, fakes, registry cache (owner: `scripts/localdev-kind.ts`)

**Files:**
- Create: `scripts/localdev-kind.ts`, `scripts/localdev-kind_test.ts`
- Create: `localdev/fakes/README.md`, `localdev/fakes/storageclasses.yaml`, `localdev/fakes/secrets.yaml`, `localdev/fakes/onepassworditem-crd.yaml`
- Modify: `localdev/kind-config.yaml`
- Read-only: `configuration/versions.yaml`, `charts/addons/values-localdev.yaml` (`cilium.values` — WP-A adds it; until then fall back to an inline default in the script and log a warning).

**Produces:** subcommands `up`, `down [--purge-cache]`, `fakes`, `registry up|down|status`, `cilium`; flags `--help`, `--dry-run`, `--cluster homelab-localdev`, `--context kind-homelab-localdev`, `--no-registry`.

- [ ] **B1 kind-config.** `networking.disableDefaultCNI: true` (comment: Cilium, installed by scripts/localdev-kind.ts), keep `podSubnet`/`serviceSubnet`, keep 1 CP + 2 workers and the port mappings (80→9080, 443→9443, 30080→8080 for ArgoCD). Replace the `containerdConfigPatches` mirror block with `[plugins."io.containerd.grpc.v1.cri".registry]\n  config_path = "/etc/containerd/certs.d"`. Node image is passed by the script (`--image kindest/node:<images.kind-node>`), not in the file.
- [ ] **B2 Script `up`.** Read `images.kind-node`, `charts.cilium` from versions.yaml (tiny YAML reader: `yq -o json` via `Deno.Command`, or a minimal parser for the two keys — prefer `yq`, it is in mise). Steps: create cluster if missing (`kind create cluster --name homelab-localdev --config localdev/kind-config.yaml --image kindest/node:<v> --wait 0s`), `registry up` unless `--no-registry`, write hosts.toml into every node, install Cilium (`helm upgrade --install cilium cilium --repo https://helm.cilium.io/ --version <v> -n kube-system --values <tmp values from charts/addons/values-localdev.yaml .cilium.values> --wait --timeout 10m`), `kubectl wait --for=condition=Ready nodes --all --timeout=5m`, then `fakes`. Idempotent; prints a summary (context, ArgoCD URL, registry cache dir).
- [ ] **B3 Registry cache.** Upstreams: `docker.io → https://registry-1.docker.io`, `ghcr.io`, `quay.io`, `registry.k8s.io`, `lscr.io`. For each: container `kind-registry-<name>` (`registry:2`, network `kind`, `-e REGISTRY_PROXY_REMOTEURL=<url>`, `-v <cacheDir>/<name>:/var/lib/registry`, restart unless-stopped); `cacheDir` = `$HOMELAB_KIND_CACHE_DIR` or `$XDG_CACHE_HOME|~/.cache` + `/homelab-kind-registry`. hosts.toml per upstream written to `/etc/containerd/certs.d/<host>/hosts.toml` in every node via `docker exec` (`server = "https://<host>"`, `[host."http://kind-registry-<name>:5000"] capabilities = ["pull","resolve"]`) — containerd falls back to the upstream when the proxy is down. Export `renderHostsToml(host, proxy)` and `registryUpstreams` and unit-test them.
- [ ] **B4 Fakes.** `storageclasses.yaml`: `democratic-csi-nfs`, `democratic-csi-ssd`, `democratic-csi-iscsi`, `democratic-csi-iscsi-hdd` → `provisioner: rancher.io/local-path`, `volumeBindingMode: WaitForFirstConsumer`, `reclaimPolicy: Delete`. `secrets.yaml`: Namespace `media` (labels `pod-security.kubernetes.io/enforce: privileged`, mirror `charts/applications/templates/namespaces.yaml`) + Secret `plex` (`stringData: {plex-claim-token: "claim-localdev"}`) + any other Secret a localdev-enabled app references by name (grep the localdev snapshots for `secretName`/`existingSecret`/`claimSecret`; cert-manager TLS secrets are NOT seeded — the self-signed issuer creates them). `onepassworditem-crd.yaml`: the `onepassworditems.onepassword.com` CRD extracted from `helm template connect --repo https://1password.github.io/connect-helm-charts --version <charts.onepassword-connect>` (comment the source + version at the top). README explains item 10 and that the seeded list is the chosen shim (SECRETS_PROVIDER=none renders no OnePasswordItem in localdev; the CRD keeps any that appear applicable).
- [ ] **B5 `down`.** `kind delete cluster --name ...`; with `--purge-cache` also `registry down` and remove the cache dir (ask nothing; print what it deletes; honour `--dry-run`).
- [ ] **B6 Tests + lint.** `deno test scripts/localdev-kind_test.ts` (hosts.toml rendering, upstream table, version parsing from a YAML string, kind image tag derivation); `deno fmt scripts/localdev-kind.ts`; `deno check scripts/localdev-kind.ts`. Do NOT create a Kind cluster from the subagent; the integrator runs the real loop.

## WP-C: ArgoCD health Lua + fixtures (owner: bootstrap chart + `scripts/health-test.ts`)

**Files:**
- Create: `charts/bootstrap/files/health/argoproj.io_Application.lua`, `networking.k8s.io_Ingress.lua`, `onepassword.com_OnePasswordItem.lua`, `tailscale.com_Connector.lua`, `externaldns.k8s.io_DNSEndpoint.lua`, `paperclip.inc_Instance.lua`
- Create: `tests/health/README.md`, `tests/health/<group>_<kind>/{healthy,progressing,degraded}.yaml` (each first line `# expect: Healthy|Progressing|Degraded|Suspended`, optional second line `# message: <substring>`)
- Create: `scripts/health-test.ts`, `scripts/health-test_test.ts`
- Modify: `charts/bootstrap/templates/argocd.yaml` (inject files; also wrap its `automated:` block in `{{- if .Values.global.automatedSync }}` — WP-A adds `global.automatedSync: true` to `charts/bootstrap/values.yaml`; add it yourself if absent, same value), `charts/bootstrap/values.yaml` (remove inline Application Lua from `configs.cm`), `charts/bootstrap/values-homelab.yaml` (remove inline Ingress Lua)

- [ ] **C1 Lua.** Move the two existing scripts verbatim into files. New ones: OnePasswordItem — Healthy when `status.conditions[type=Ready].status == "True"`, Degraded when Ready is `"False"` (message from condition), else Progressing. Connector — Healthy when `status.conditions[type=ConnectorReady].status == "True"`, Degraded on `"False"`, else Progressing. DNSEndpoint — Healthy when `status.observedGeneration >= metadata.generation` (or no generation info), else Progressing. Instance (`paperclip.inc`) — Healthy when `status.phase == "Running"`, Degraded when `Failed`/`Error`, else Progressing. Every script sets `hs.message`.
- [ ] **C2 Template injection.** In `templates/argocd.yaml` build `$values := deepCopy .Values.argocd.values`, `$cm := merge (dict) (dig "configs" "cm" (dict) $values)`, `range $path, $_ := .Files.Glob "files/health/*.lua"` → `set $cm (printf "resource.customizations.health.%s" (trimSuffix ".lua" (base $path))) ($.Files.Get $path)`, then set `$values.configs.cm = $cm` and `toYaml $values | nindent 8`. `helm template charts/bootstrap -f values.yaml -f values-homelab.yaml --show-only templates/argocd.yaml` must contain all six keys; `kustomize.buildOptions` and `server.insecure` must survive.
- [ ] **C3 Fixture runner.** `health-test.ts`: for each fixture, write a temp `argocd-cm.yaml` ConfigMap (`metadata.name: argocd-cm`, `data` = the Lua files keyed as above), run `argocd admin settings resource-overrides health <fixture> --argocd-cm-path <cm>`, parse `STATUS:`/`MESSAGE:` lines (verify the exact output format with `argocd` v3.5.2 from mise), compare with `# expect:`. Flags `--health-dir`, `--fixtures-dir`, `--argocd`, `--only <group_kind>`. Export `parseExpectation(text)` and `parseHealthOutput(text)`; unit-test both. Every fixture must have a stripped-down but realistic object (apiVersion/kind/metadata/status). `task test:health` passes locally.
- [ ] **C4 Verify.** `task verify:text -- --chart bootstrap` (snapshot failure for bootstrap expected — do not update), `conftest`/policy unaffected, `deno fmt/check/test` on the new script.

## WP-E: ArgoCD install + sync orchestrator + Tilt (owner: `scripts/localdev-argocd.ts`)

**Files:**
- Create: `scripts/localdev-argocd.ts`, `scripts/localdev-argocd_test.ts`, `localdev/argocd/gitops-app.yaml`
- Modify: `localdev/values/argocd-values.yaml` (rewrite), delete `localdev/values/argocd-values-ci.yaml`, `localdev/Tiltfile`, `Tiltfile` (root; only the `plan.md` line)
- Read-only: `configuration/versions.yaml`, `charts/bootstrap/files/health/*.lua` (WP-C creates them; glob at runtime, tolerate an empty dir with a warning)

- [ ] **E1 Values overlay.** `argocd-values.yaml`: `global.storageClass: local-path`, `configs.params.server.insecure: true`, `server.service.type: NodePort` + `nodePortHttp: 30080`, small resources for server/controller/repoServer/redis/applicationSet, `dex.enabled: false`, `notifications.enabled: false`, `redis-ha.enabled: false`, `configs.cm.timeout.reconciliation: 30s`, `configs.cm.kustomize.buildOptions: "--enable-alpha-plugins --enable-exec"`, `configs.rbac.policy.default: role:admin`. Remove `file://`, hostPath volumes, `automountServiceAccountToken`.
- [ ] **E2 `install`.** `helm upgrade --install argocd argo-cd --repo https://argoproj.github.io/argo-helm --version <charts.argocd> -n argocd --create-namespace -f localdev/values/argocd-values.yaml <one --set-file per Lua file> --wait --timeout 10m`, then `kubectl apply --server-side -f localdev/argocd/gitops-app.yaml`, then login: read `argocd-initial-admin-secret`, `argocd login localhost:8080 --plaintext --insecure --username admin --password <pw> --grpc-web` (retry for up to 2 min while the NodePort comes up). Idempotent.
- [ ] **E3 `sync`.** Implement the tier algorithm from "Cross-package interfaces" with `--timeout` (default 40m), `--warm` (stop after every app whose parent is `gitops`/`bootstrap`/`addons` is done; never sync `applications`), `--only <app,...>`, `--dry-run` (print the commands). Export and unit-test `tierKey(app, parentWaves)`, `nextTier(apps, done)`, `isTierComplete(apps)`, `syncArgs(app, repoRoot)` (pure functions over the Application JSON shape). Print a table per tier (app, kind: local/chart, result, duration).
- [ ] **E4 `wait` / `diagnose`.** `wait`: poll every 10 s until all Applications are `Healthy` + `Succeeded` (`--require-synced` also demands `status.sync.status == Synced`; default off because `--local` syncs are OutOfSync vs GitHub by design), `--timeout` default 20m; on failure run `diagnose` and exit 1. `diagnose`: per non-healthy app print conditions, `status.operationState.message`, resources with health ≠ Healthy; per namespace of those resources `kubectl get events --sort-by=.lastTimestamp | tail -30`; pods not Running/Succeeded → `kubectl describe` tail + `logs --tail=50 --all-containers`.
- [ ] **E5 Tilt.** `localdev/Tiltfile`: `config.define_string("mode")`, `cfg = config.parse()`, `mode = cfg.get("mode", os.getenv("TILT_MODE", "direct"))`. ArgoCD mode = `local_resource("argocd-install", "task localdev:argocd", resource_deps=[...])`, `local_resource("argocd-sync", "task localdev:sync", resource_deps=["argocd-install"], deps=["../charts", "../configuration"], trigger_mode=TRIGGER_MODE_AUTO)`, `local_resource("argocd-wait", "task localdev:wait", auto_init=False, trigger_mode=TRIGGER_MODE_MANUAL)`; remove the heredoc root app, the `file://` references, the `is_ci` skip and the argocd-values-ci selection. Direct mode unchanged except the local-path-provisioner install stays direct-mode-only (ArgoCD mode gets it from the addon). Root `Tiltfile`: replace the `plan.md` line with `docs/local-development.md`.
- [ ] **E6 Tests + lint.** `deno test scripts/localdev-argocd_test.ts`, `deno fmt`, `deno check`. `tilt alpha tiltfile-result` is not required; `tilt ci --help` unaffected. Do NOT run against a cluster from the subagent.

## WP-F: `homelab verify all --level 1|2` (owner: Go)

**Files:**
- Create: `internal/verify/cluster.go`, `internal/verify/cluster_test.go`
- Modify: `cmd/homelab/commands/verify_all.go`, `cmd/homelab/commands/verify_exit_test.go`, `internal/verify/types.go` only if a helper is needed (e.g. `Result.Level`).

- [ ] **F1 DryRun.** `type ClusterOptions struct { Runner Runner; RepoRoot, RenderDir, KubeContext, E2EDir string }`. `DryRun(ctx, opts) []Check`: for every `<RenderDir>/localdev/<chart>.yaml` with at least one document, run `kubectl --context <ctx> apply --server-side --dry-run=server --force-conflicts --field-manager homelab-verify -f <file>`; pass → `dryrun/localdev/<chart>`; failure → findings = stderr lines. Missing kubectl → `SkipCheck` with `ToolMissingDetail`. Unreachable cluster → one fail check `dryrun/cluster` with the stderr.
- [ ] **F2 ArgoCDApps.** `kubectl --context <ctx> get applications.argoproj.io -n argocd -o json` → per app `argocd/<name>`: pass iff `status.health.status == Healthy && status.operationState.phase == Succeeded`; detail `sync=<status> health=<status> op=<phase>`; findings = conditions messages + resources with health ≠ Healthy (`kind/ns/name: status message`). No apps → fail `argocd/apps` "no Applications in namespace argocd (run task localdev:up)".
- [ ] **F3 Chainsaw.** `chainsaw test --config <E2EDir>/.chainsaw.yaml <E2EDir> --report-format JSON --report-path <tmp> --report-name report --no-color` (confirm flag names with `chainsaw test --help`, v0.2.15), parse `report.json` → `e2e/<test name>` pass/fail with failed step names as findings; chainsaw missing → skip check `e2e/chainsaw`; non-zero exit without a report → fail `e2e/chainsaw` with stderr tail.
- [ ] **F4 Wire levels.** `verify all`: `--level 1` = level 0 + `DryRun` (localdev only; `--env` must include localdev, else usage error); `--level 2` = level 1 + `ArgoCDApps` + `Chainsaw`. New flags `--kube-context` (default `kind-homelab-localdev`), `--e2e-dir` (default `tests/e2e`). `Result.Level` = requested level. Update the command Long text and the `--level` flag help. Remove the "not available yet" usage error.
- [ ] **F5 Tests.** Fake-runner tests for each function (pass, fail, tool missing, cluster unreachable, empty render skipped, chainsaw report parsing with a fixture JSON string), cobra exit-code tests for `--level 3` (usage 2) and `--level 1 --env homelab` (usage 2). `go vet ./... && go test ./...` green.

## WP-G: Chainsaw e2e tests (owner: `tests/e2e`)

**Files:**
- Create: `tests/e2e/.chainsaw.yaml`, `tests/e2e/README.md`, `tests/e2e/<name>/chainsaw-test.yaml` for: `argocd-apps` (every Application Healthy+Succeeded via a script step using kubectl), `cert-manager` (Certificate `traefik-dashboard-tls` in `traefik` Ready), `traefik` (both dashboards via IngressRoute → curl through the service), `grafana` (`/api/health` through Traefik internal with Host `grafana.homelab.local`), `plex` (`/identity`, Host `plex.homelab.local`, via Traefik **external** service), `sonarr`, `radarr`, `prowlarr`, `nzbget` (401 accepted), `tautulli`, `lazylibrarian`, `flaresolverr`, `mosquitto` (TCP connect to `mosquitto.home-automation.svc:1883` using `nc` in the busybox image), `cloudnative-pg` (create a 1-instance `Cluster` with `storage.storageClass: local-path`, 1Gi, in the test namespace; assert `status.phase: Cluster in healthy state`; cleanup), `cilium-netpol` (Namespace with a nginx Pod + default-deny NetworkPolicy; a curl Job must fail; then allow policy; a curl Job must succeed).
- Read-only: `tests/snapshots/localdev/addons.yaml`, `applications.yaml` (service names/ports/namespaces/hostnames), `configuration/versions.yaml` (`images.curl`).

- [ ] **G1 Config.** `.chainsaw.yaml` (`apiVersion: chainsaw.kyverno.io/v1alpha2`, `kind: Configuration`): timeouts `apply 2m, assert 10m, cleanup 2m, delete 2m, error 2m, exec 5m`, `execution.failFast: false`, `execution.parallel: 4`, `cleanup.skipDelete: false`, `report` left to CLI flags.
- [ ] **G2 Pattern.** Each test: step 1 `assert` the Application(s) (`apiVersion: argoproj.io/v1alpha1`, `kind: Application`, `metadata: {name, namespace: argocd}`, `status: {health: {status: Healthy}, operationState: {phase: Succeeded}}`); step 2 `apply` a Job `curl-<app>` in the chainsaw namespace with image `curlimages/curl:8.22.0`, resources set, command `sh -c 'code=$(curl -s -o /dev/null -w "%{http_code}" --retry 20 --retry-delay 6 --retry-all-errors -H "Host: <host>" http://<svc>:<port><path>); echo "HTTP $code"; case "$code" in <allowed>) exit 0;; *) exit 1;; esac'`, then `assert` `status.succeeded: 1`; `catch:` `events: {}`, `podLogs: {selector: job-name=curl-<app>}`, `describe` the Application. Use the exact Traefik internal/external Service names and ports from the localdev snapshots (`charts/addons/values-localdev.yaml` `traefikInternal.service`).
- [ ] **G3 Validate.** `chainsaw lint test tests/e2e/**/chainsaw-test.yaml` (or `chainsaw test --dry-run`-equivalent if lint is unavailable: `chainsaw create test`?) — at minimum every file parses with `yq`; `yamllint tests/e2e` passes. README documents `task test:e2e`, `-- --test-dir tests/e2e/<name>`, and how to add a test for a new app.

## WP-D (wave 2, after WP-A): PostSync smoke hooks

**Files:** `charts/applications/templates/_smoke.tpl`, `charts/addons/templates/_smoke.tpl` (identical helper), includes at the end of every enabled app template (plex, sonarr, radarr, prowlarr, nzbget, tautulli, lazylibrarian, flaresolverr, homeassistant, renovate? no; addons: kube-prometheus-stack (grafana `/api/health` + prometheus `/-/ready`), traefik-internal/external dashboards `/ping`? only if `ping` is enabled — otherwise skip), `smoke:` blocks in `charts/{addons,applications}/values.yaml` and in `helm-addons.tmpl`/`helm-apps.tmpl` (same URLs; localdev and homelab share service names).

- [ ] **D1 Helper.** `{{- define "homelab.smokeJob" -}}` taking `(dict "name" <app> "namespace" <ns> "smoke" .Values.<app>.smoke "wave" "<n>" "image" .Values.global.images.curl)`: Job `smoke-<app>`, annotations `argocd.argoproj.io/hook: PostSync`, `argocd.argoproj.io/hook-delete-policy: BeforeHookCreation,HookSucceeded`, `argocd.argoproj.io/sync-wave: "<wave>"`; `backoffLimit: 2`, `activeDeadlineSeconds: 600`, `restartPolicy: Never`, container `curl` image `curlimages/curl:<image>`, resources `10m/32Mi → 100m/64Mi`, `securityContext` non-root, command as in G2 with `--retry 30 --retry-delay 10`.
- [ ] **D2 Values.** `smoke: {enabled: true, url: "http://<svc>.<ns>.svc.cluster.local:<port><path>", expect: ["200"]}` per app (nzbget `["200","401"]`, homeassistant `["200","401"]`); mosquitto `enabled: false` (no HTTP).
- [ ] **D3 Verify.** `helm template` each parent for both envs shows the Jobs; `task verify:text` passes except snapshots; policy `container-resources`/`image-latest` pass; kubeconform accepts `batch/v1 Job`.

## WP-H (wave 2): CI + docs + notes + agent contract

**Files:** `.github/workflows/tilt-ci.yml` (rewrite), `docs/runbooks/verification.md`, `docs/local-development.md`, `docs/architecture.md`, `docs/project_notes/{decisions.md (ADR-012), bugs.md, key_facts.md, issues.md}`, `CLAUDE.md` (Taskfile quick reference + ArgoCD section), `AGENTS.md` (Validation Flow: level 1/2), `.claude/skills/gitops-test/SKILL.md` (Tier 2 → `task verify LEVEL=1|2` on Kind), `readme.md` (commands), `.pre-commit-config.yaml` (`verify-level-0` files pattern adds `tests/health/|tests/e2e/|localdev/`), `.yamllint` if needed, Serena memory `.serena/memories/localdev_argocd_loop.md`.

- [ ] **H1 Workflow.** Jobs: `kind-direct` (Tilt direct mode; uses `task localdev:kind` so Cilium is present; `tilt ci --timeout 15m`; asserts as before) and `kind-argocd` (**required, no continue-on-error**, `timeout-minutes: 45`): checkout, setup-go, install pinned tools from versions.yaml-mirrored `env:` with renovate markers (kind, kubectl, helm, argocd, chainsaw, deno, task, tilt), `actions/cache` on `~/.cache/homelab-kind-registry` keyed `kind-registry-${{ hashFiles('configuration/versions.yaml', 'charts/addons/values-localdev.yaml', 'charts/applications/values-localdev.yaml') }}` with `restore-keys: kind-registry-`, `task localdev:ci`, then `task verify LEVEL=2 | tee verify-level2.json` + step summary, `if: always()` → `task localdev:diagnose` and upload `verify-level2.json`. Triggers add `scripts/**`, `configuration/**`, `tests/e2e/**`, `tests/health/**`, `Taskfile.yml`, `cmd/**`, `internal/**`, `mise.toml`. `yaml-lint` job: drop `|| true`. `verify.yml`: add `task test:health` to the `policy` job (needs the argocd CLI pinned from `tools.argocd`).
- [ ] **H2 Docs.** verification.md: levels 1/2 sections (what each check name means, prerequisites `task localdev:up`, JSON unchanged), local-development.md: ArgoCD mode rewritten around the tasks, fakes, registry cache, e2e; architecture.md env table (3 nodes, Cilium); key_facts (localdev domain, ports 8080/9080/9443, cache dir, cluster/context names); ADR-012 "Kind + ArgoCD loop: local sync with automation off, fakes as capability keys, Cilium in Kind"; bugs.md entries for the pre-existing defects fixed (TILT_MODE flag, `file://` root app, hostPath `/charts`, NodePort collision, plex `configExistingClaim`/`existingClaim` in Kind, dead argocd block, `plan.md` reference); issues.md entry for this PR.

## Integration (owner: integrator, after each wave)

1. `task config:export:localdev`, `task test:snapshot -- --update`, `task verify:text`, `go test ./...`, `task test:policy`, `task test:health`, `deno fmt --check scripts/ && deno check scripts/*.ts && deno test scripts/`.
2. Real loop on the workstation: `task localdev:down; task localdev:ci` (Docker Desktop is running). Fix what fails; repeat until `task verify LEVEL=2` passes.
3. `pre-commit run --all-files`, commit (semantic, `feat(localdev): ...`), push, `gh pr create`, watch checks, fix until green. Close bd task `homelab-lpw.2`.
