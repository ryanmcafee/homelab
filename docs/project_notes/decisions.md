# Architectural Decision Records (ADRs)

Document significant technical decisions made during the homelab project. This helps maintain consistency and provides context for future changes.

## Format

Each decision should include:
- Date and ADR number
- Context (why the decision was needed)
- Decision (what was chosen)
- Alternatives considered
- Consequences (trade-offs, implications)

## Entries

### ADR-001: GitOps with ArgoCD App-of-Apps Pattern (Established)

**Context:**
- Need a declarative approach to manage Kubernetes resources
- Want to track all infrastructure changes in Git
- Multiple applications with complex dependencies

**Decision:**
- Use ArgoCD with App-of-Apps pattern
- Three-tier structure: gitops -> addons -> applications
- Sync waves for dependency ordering

**Alternatives Considered:**
- FluxCD -> Less mature UI, different sync model
- Direct kubectl/Helm -> No GitOps benefits, harder to audit

**Consequences:**
- Full audit trail of all changes
- Self-healing infrastructure
- Requires understanding of sync waves and health checks
- More complex initial setup

### ADR-002: Talos Linux for Kubernetes Nodes (Established)

**Context:**
- Need immutable, secure Kubernetes nodes
- Want minimal attack surface
- Running on Proxmox VE virtualization

**Decision:**
- Use Talos Linux as the node OS
- API-driven configuration (no SSH)
- Custom images with NVIDIA drivers for GPU support

**Alternatives Considered:**
- Ubuntu + kubeadm -> More maintenance, larger attack surface
- k3s on Debian -> Simpler but less security hardening
- RKE2 -> More traditional but not immutable

**Consequences:**
- Highly secure, immutable nodes
- No SSH access (API-only management)
- Custom image builds required for GPU support
- Steeper learning curve for troubleshooting

### ADR-003: 1Password + SOPS for Secrets Management (Established)

**Context:**
- Need to manage secrets for Kubernetes applications
- Want secrets encrypted in Git
- Already using 1Password for personal credential management

**Decision:**
- Use 1Password Connect for runtime secret injection
- Use SOPS with Age encryption for secrets in Git
- 1Password Operator creates Kubernetes secrets from 1Password items

**Alternatives Considered:**
- Sealed Secrets -> Requires cluster-side key management
- HashiCorp Vault -> Overkill for homelab, more infrastructure
- External Secrets Operator alone -> Still need secret storage backend

**Consequences:**
- Secrets encrypted at rest in Git
- Single source of truth in 1Password
- Requires 1Password Connect server running
- Bootstrap complexity (chicken-and-egg with initial secrets)

### ADR-004: Democratic-CSI for NFS Storage (Established)

**Context:**
- Need persistent storage for stateful applications
- Have TrueNAS server with large storage pool
- Want dynamic provisioning in Kubernetes

**Decision:**
- Use Democratic-CSI with NFS backend
- Connect to TrueNAS via API for dynamic provisioning
- Use allowInsecure for self-signed TrueNAS certificate

**Alternatives Considered:**
- NFS-subdir-external-provisioner -> Less features, no snapshot support
- Longhorn -> Requires local node storage, not NAS-backed
- Rook-Ceph -> Much more complex, overkill for homelab

**Consequences:**
- Dynamic NFS provisioning works well
- Snapshot support available
- Dependent on TrueNAS API availability
- Self-signed cert requires allowInsecure

### ADR-005: TypeScript for All Scripting (Established)

**Context:**
- Need automation scripts for infrastructure tasks
- Want type safety and modern tooling
- Avoid shell script complexity

**Decision:**
- Use TypeScript with the Bun runtime for all scripts
- No Bash or Python scripts
- Dependencies pinned in `package.json` and `bun.lock`; Biome formats and lints, tsc type-checks, `bun test` runs the unit tests

**Alternatives Considered:**
- Bash -> Traditional but error-prone, hard to maintain
- Python -> Good but less type safety
- Go -> Overkill for scripts, slower iteration

**Consequences:**
- Type-safe automation
- Modern async/await patterns
- Requires Bun (pinned in `mise.toml`)
- Some learning curve for shell-to-TS conversion

### ADR-006: Unified NFS Permission Model — apps:users (568:100) (2026-02-09)

**Context:**
- Containers run as UID 568 (apps) with GID 100 (users) per TrueCharts convention
- Democratic-CSI provisions NFS shares with mapall for k8s PVC datasets
- Media datasets (movies, tv, downloads, etc.) use direct NFS mounts, not CSI
- Initial setup used `<NFS_MAPALL_USER>:users` for media shares and `apps:users` for k8s — causing permission mismatches when containers accessed media NFS mounts

**Decision:**
- ALL NFS shares use `mapall_user: apps, mapall_group: users` (568:100)
- ALL datasets owned by `apps:users` (568:100) with mode 770
- Single permission model for both CSI-provisioned and direct NFS mounts
- SMB access still works via group `users` (GID 100) shared between `<NFS_MAPALL_USER>` and `apps`

**Alternatives Considered:**
- Keep `<NFS_MAPALL_USER>:users` for media, `apps:users` for k8s → Split model, confusing, permission bugs
- Use `maproot` instead of `mapall` → Only maps UID 0, non-root containers get denied

**Consequences:**
- All media apps (NZBGet, Sonarr, Radarr, etc.) can access NFS mounts consistently
- SMB clients (desktop) still have access via group membership
- Dataset ownership is `apps` not `<NFS_MAPALL_USER>` — SMB writes will appear as `apps` user
- Script `truenas-nfs-mapall.ts --all --fix-permissions` applies the full fix

### ADR-007: Split NFS Permission Model — apps:users for K8s, <NFS_MAPALL_USER>:users for Media (2026-02-09)

**Context:**
- ADR-006 unified all datasets to apps:users (568:100)
- Personal datasets (media, backups, documents) are better owned by <NFS_MAPALL_USER> for SMB access
- K8s workloads only need k8s datasets as apps:users

**Decision:**
- K8s datasets: apps:users (568:100) ownership + NFS mapall
- Media/personal datasets: <NFS_MAPALL_USER>:users ownership + NFS mapall
- Mode 770 on all datasets (group users gets rwx)
- truenas-nfs-mapall.ts updated with split k8s/media behavior

**Alternatives Considered:**
- Keep unified apps:users (ADR-006) -> SMB files appear as apps, not personal user
- Use <NFS_MAPALL_USER> for everything -> K8s pods would need reconfiguration

**Consequences:**
- SMB access shows files as <NFS_MAPALL_USER> (natural for desktop browsing)
- K8s pods still access media via group users (GID 100) with mode 770
- NFS-created files from K8s pods will be owned by <NFS_MAPALL_USER> (via mapall)
- Two permission models to maintain (documented in script flags)

### ADR-008: iSCSI Block Storage for SQLite Workloads (2026-02-09)

**Context:**
- Plex stores SQLite databases on NFS-backed PVC via democratic-csi
- SQLite relies on POSIX file locking (`fcntl()`) which is unreliable over NFS
- This caused `Sqlite3: Sleeping for 200ms to retry busy DB` errors and restart loops
- Need block-level storage with proper file locking while keeping data on TrueNAS

**Decision:**
- Add iSCSI block storage driver via democratic-csi (`freenas-api-iscsi`)
- Create `democratic-csi-iscsi` storage class backed by TrueNAS SSD pool
- Use `siderolabs/iscsi-tools` Talos system extension (musl libc, no nvidia-container-toolkit conflict)
- Migrate Plex config to iSCSI PVC; keep NFS for media library mounts

**Alternatives Considered:**
- local-path-provisioner -> Data lost on node failure, no TrueNAS backup
- hostPath with local SSD -> Same node-binding issue, no HA
- Fix NFS locking (NFSv4 + file delegation) -> Unreliable, SQLite officially unsupported on NFS

**Consequences:**
- Proper POSIX file locking for SQLite (no more busy DB errors)
- Data survives node failure (stored on TrueNAS iSCSI zvol)
- Requires `iscsi-tools` extension in Talos images and `iscsi_tcp` kernel module
- iSCSI PVCs are ReadWriteOnce only (single-node mount)
- TrueNAS iSCSI service must be enabled with portal + initiator groups

### ADR-009: Level-0 static verification is the agent gate; no schema skip lists (2026-09-12)

**Context:**
- The only end-to-end verification ran against production (gitops-test Tiers 3–4 applied manifests to, or repointed, live ArgoCD Applications)
- Pre-commit kubeconform hid eight CRD kinds behind `-skip`, so custom resources were never schema-checked
- Autonomous agents (local and remote) need a trustworthy, fast, machine-readable check they can run on every edit
- Issue #261 (Section A)

**Decision:**
- `homelab verify all --level 0` (`task verify`) is the mandatory gate: two-stage render of every chart for `localdev` and for `homelab.yaml.example`, `helm lint`, `kubeconform` with vendored CRD schemas and the cluster version from `versions.yaml`, `pluto`, a GitOps graph linter, golden snapshots and conftest policies; JSON summary, exit 0/1, target under 5 s
- Level 0 never reads `configuration/environments/homelab.yaml`; the PII-free example file is the homelab input
- CRD schemas are vendored under `tests/schemas/` from the pinned chart versions; `-skip` lists are forbidden
- Conventions previously documented only in prose (sync-wave ordering, secret wiring, repository Secrets, ServerSideApply, finalizers, automated sync, no `:latest`, resources, hostnames) are executable checks; exceptions require an annotation with a reason
- Agents may mutate only Kind clusters; production is verified via merge → ArgoCD → CI/notifications (the Kind loop is Section B of #261; the prod-repointing tiers are retired in Section D)

**Alternatives Considered:**
- Keep datree CRD catalog + `-skip` -> catalog lags pinned versions and hides exactly the resources most likely to break
- Kyverno CLI for policy -> conftest is simpler to unit-test offline and to ship negative fixtures for
- Snapshot only the parent charts -> child `*-config`/`*-dependencies` charts are where secret wiring breaks

**Consequences:**
- Every chart change needs `task test:snapshot -- --update` when the render legitimately changes; snapshot drift fails CI for every author (Renovate included), which uploads the regenerated snapshots as an artifact and comments the diff rather than committing anything
- Operator bumps require `task schemas:vendor` (CI `schemas` job enforces it)
- New charts must register CRD providers, huge-CRD status and known secrets in `tests/gitops/`
- Level 0 cannot see inside upstream charts referenced by `spec.source.chart` + inline `helm.values`; those are covered by the Kind loop

### ADR-010: Child charts receive derived values through parent Application valuesObject (2026-09-12)

**Context:**
- Only the parent charts (`addons`, `applications`) render through the CMP in homelab; child `*-config`/`*-dependencies` Applications point at their chart with plain `helm.valueFiles`, so `configuration/` never reached them
- Roughly 20 committed `charts/*/values-homelab.yaml` therefore carried the production domain, hostnames, TrueNAS iSCSI portal IP, Traefik static IP, ACME e-mail and DuckDNS subdomain, contradicting the "no PII in git" goal of the 2026-02-11 CMP decision
- The PII guard scanned only `configuration/`, so nothing caught it; level 0 needed 9 `hostname-domain` policy exemptions to pass
- Issue #262

**Decision:**
- Each parent Application that points at a child chart passes the derived values via `spec.source.helm.valuesObject`, built from the parent's own `.Values` (from `configuration/templates/helm-*.tmpl` in homelab, from `values-localdev.yaml` in localdev); ArgoCD precedence `valueFiles < valuesObject` means the child's committed `values-homelab.yaml` keeps only non-derived, non-PII settings (enabled flags, volume lists, namespaces, 1Password item paths)
- `bootstrap` installs the CMP and cannot use it, so its ArgoCD hostname is derived in the `gitops` chart from `global.domain`, which the Terraform root Application injects as a Helm parameter
- Level 0 mirrors the runtime: parents render first, each child receives the `valuesObject` extracted from the rendered parent Application as an extra values file (`_inherited/<chart>.yaml`), and `gitops` in the two-stage env gets `--set global.domain=<DOMAIN>`; two parents handing one chart different values is a failure
- `homelab config guard` scans `configuration/**` and `charts/**/values-homelab.yaml` by default and understands Helm-style keys (`host`, `portal`, `staticIP`, `email`, list items under `dnsZones`/`allowedDomains`/`hosts`)
- The 9 `hostname-domain` exemptions tied to #262 are removed

**Alternatives Considered:**
- Per-child CMP export formats (one `configuration/templates/helm-<child>.tmpl` per chart, children rendered through the plugin) -> a CMP image change plus ~20 templates to maintain, and the CMP still cannot serve `bootstrap`
- Move ArgoCD self-management out of `bootstrap` into a CMP-rendered chart -> breaks the chicken-and-egg ordering the 2026-02-11 decision established (the CMP sidecar is part of the ArgoCD install)
- Keep the PII in child values and widen the guard allowlist -> leaves the production domain and IPs in git, which was the problem

**Consequences:**
- A derived value a child needs is added in three places: the parent's export template (or `values-localdev.yaml`), the parent template's `valuesObject`, and the child's `values.yaml` placeholder; the child's `values-homelab.yaml` must never carry it
- Snapshots and the render directory contain only example-file placeholders; `_inherited/` shows exactly what each child received
- The guard now fails a commit that puts a real hostname, routable IP or mailbox in any `values-homelab.yaml`; placeholders must come from the closed allowlist
- Terraform (`gitops-bootstrap` module) owns the domain the `gitops` chart sees; changing the domain is a Terraform apply, not a chart edit

### ADR-011: Localdev parent values are generated from the config system (2026-09-12)

**Context:**
- In localdev, `charts/addons` and `charts/applications` rendered with plain Helm from a hand-written `values-localdev.yaml`, so Ingress/IngressRoute hostnames stayed at the `example.com` placeholders, chart versions lagged `configuration/versions.yaml`, and the file carried stale blocks (qbittorrent, jellyfin, 1password-operator) and keys the templates never read (`prometheusSpec`, `nodePort`, `selfSigned`, ...)
- It also said `global.domain: homelab.test` while `configuration/environments/localdev.yaml` and `charts/gitops/values-localdev.yaml` said `homelab.local`
- Ten Applications carried a localdev-only `hostname-domain` policy exemption as a workaround
- Issue #263

**Decision:**
- `charts/addons/values-localdev.yaml` and `charts/applications/values-localdev.yaml` are generated by `homelab config export --set localdev --format helm-addons|helm-apps` (`task config:export:localdev`) from `configuration/templates/helm-{addons,apps}.tmpl` and committed (localdev has no PII); they remain ordinary Helm values files, so ArgoCD plain-Helm mode, Tilt and `argocd app sync --local` are unchanged
- Export output paths are set-aware: `--set homelab` still writes the gitignored `charts/*/values-homelab.generated.yaml` (PII; rendered by the CMP at sync time); any other set writes the committed `charts/*/values-<set>.yaml`
- Environment differences are capability keys in `configuration/schema/platform.schema.yaml` (defaults = homelab, overridden in `localdev.yaml`): `CNI_PROVIDER` (cilium + cilium-lb-ipam), `LOAD_BALANCER_ENABLED` (Service type LoadBalancer vs NodePort for Traefik/Plex/Mosquitto, LB-IPAM and port-forwarding annotations, unifi-port-forward), `EXTERNAL_DNS_ENABLED` (external-dns, external-dns-unifi, duckdns), `STORAGE_PROVIDER` (democratic-csi Applications vs local-path-provisioner, plus `STORAGE_CLASS_*`), `SECRETS_PROVIDER` (1password-operator, tailscale-operator, renovate, Traefik OIDC middleware/secret volumes, fixed Grafana dev password when `none`)
- Kind sizing (single replica, no autoscaling, small resources, 1d Prometheus retention, alertmanager/node-exporter off, cloudnative-pg and argo-workflows off — cloudnative-pg was later turned on in Kind by ADR-012, and its Barman Cloud Plugin joined it in ADR-014) is keyed on `{{ if eq .Set "localdev" }}` inside the templates, because it describes the Kind host rather than a platform capability
- Level 0 adds `render/localdev/_committed-values`, which re-exports both templates for localdev and fails with a unified diff when the committed files differ; the pre-commit `config-export` hook regenerates them whenever `configuration/**` changes
- The 10 localdev-only `hostname-domain` exemptions are removed

**Alternatives Considered:**
- Make localdev two-stage via the CMP too -> the CMP sidecar is homelab-only and hardwires `--env-file /config/homelab.yaml`; localdev ArgoCD runs plain Helm and Tilt needs a file on disk
- Keep the hand-written file and only fix hostnames/versions -> it drifts again, and most of its keys were dead
- Conditionals keyed only on `.Set` for everything -> capability keys let a future set flip one capability at a time; `.Set` remains only for Kind sizing

**Consequences:**
- `values-localdev.yaml` is never hand-edited; edit `configuration/environments/localdev.yaml` or the templates and run `task config:export:localdev`
- New platform-dependent behaviour goes in the template behind a capability key, never in the generated file
- Localdev enables exactly the component set it did before (cert-manager, kube-prometheus-stack, traefik external/internal, kubelet-csr-approver, node-feature-discovery, spegel, local-path-provisioner; media apps + mosquitto + flaresolverr) but with config-derived hostnames and current chart versions
- Snapshots under `tests/snapshots/localdev` regenerate

### ADR-012: Kind + ArgoCD loop: local sync with automation off, fakes as capability keys, Cilium in Kind (2026-09-13)

**Context:**
- Agents may mutate only Kind (ADR-009), but nothing proved that the localdev render ever reached Synced/Healthy: the ArgoCD mode of the Tiltfile pointed the root Application at `file://../charts`, a URL ArgoCD cannot fetch, and relied on a repo-server hostPath `/charts` that no Kind node mounted; the CI job was `continue-on-error`, and `tilt up -- --mode=argocd` was silently ignored (only `TILT_MODE` was read). The "ArgoCD mode" had never worked
- Kind has no 1Password, no TrueNAS, no BGP, no external DNS and no public domain, so the rendered Applications referenced PVCs, NFS servers and Secrets that nothing creates there
- Custom-resource health (Ingress, OnePasswordItem, Connector, DNSEndpoint, Instance) was inline Lua in two values files with no tests, and no Application proved its endpoint answered
- Issue #261 Section B, items 9-15

**Decision:**
- The root `gitops` Application (`localdev/argocd/gitops-app.yaml`) points at GitHub `main` (superseded by the 2026-09-14 amendment below: it now tracks the PR head), but every Application is synced from the working tree with `argocd app sync --local`, tier by tier (parent wave, then own wave) by `scripts/localdev-argocd.ts sync`; `wait` and `verify --level 2` judge `health` + `operationState.phase`, never `sync.status`
- Automated sync is a capability key, `ARGOCD_AUTOMATED_SYNC` (default `"true"`, localdev `"false"`): every Application template wraps `automated:` in `{{ if .Values.global.automatedSync }}`, the generated localdev values set it false, `_data.yaml` carries it and the `app-automated` policy is skipped when it is false. Without this `--local` is refused and self-heal would revert the tree to Git
- Kind's other gaps are capability keys too (`MEDIA_PROVIDER` nfs|ephemeral, `CERT_ISSUER` letsencrypt|selfsigned, alongside `STORAGE_PROVIDER`, `SECRETS_PROVIDER`, `LOAD_BALANCER_ENABLED`, `EXTERNAL_DNS_ENABLED`), never environment-name branches; what a key cannot express is a cluster-side fake in `localdev/fakes/` (StorageClass aliases on local-path, seeded Secrets by name, the OnePasswordItem CRD)
- Cilium is the CNI in Kind: `scripts/localdev-kind.ts` installs it from the `cilium.values` block of the generated localdev values at `charts.cilium`, and the `cilium` Application adopts the release as a no-op
- ArgoCD health Lua has one source, `charts/bootstrap/files/health/<group>_<kind>.lua`, injected by the bootstrap chart in homelab and by `--set-file` in localdev, and exercised by `task test:health` against `tests/health/` fixtures with the pinned `argocd` CLI
- Every enabled app renders a PostSync smoke Job (`homelab.smokeJob`: curl `<app>.smoke.url` until a code in `expect`), so an operation only succeeds when the endpoint answers; `tests/e2e/` holds chainsaw tests per feature
- `homelab verify all --level 1` adds a server-side dry run of every localdev chart, `--level 2` adds Application state and the chainsaw report, with the level-0 JSON contract; CI job `kind-argocd` (`tilt-ci.yml`) runs `task localdev:ci` + `task verify LEVEL=2` and is required, 45-minute budget, registry pull-through caches restored with `actions/cache`

**Alternatives Considered:**
- In-cluster git server (gitea, `git daemon`) that the tree is pushed to -> another moving part, a commit per iteration, and the push is exactly what `--local` replaces
- CMP in localdev -> the CMP is homelab-only and hardwires the homelab env-file (ADR-011); Tilt and `--local` need files on disk
- Keep automation on and patch `automated: null` before each local sync -> races self-heal, drifts the live spec from the render, and `--local` refuses automated Applications anyway
- Fake 1Password Connect/operator in Kind -> more to maintain than a reviewable list of seeded Secrets
- kindnet -> the `cilium` Application and every Cilium object (NetworkPolicy enforcement, future LB IPAM) would be untestable in Kind

**Consequences:**
- After a local sync every Application is `OutOfSync` against `main` by design; tooling and docs must never treat that as a failure (amended 2026-09-14: the Applications track the PR head, so `Synced` is the normal state and `OutOfSync` means unpushed local changes; sync status still never decides a check)
- Localdev never exercises automated sync (prune/selfHeal); the homelab snapshots and the `app-automated` policy still cover it
- A new app needs a `smoke:` block, a seeded Secret if 1Password provides one, a chainsaw test, and health Lua + fixtures for any new CR kind; `localdev/fakes/README.md` and `tests/e2e/README.md` hold the recipes
- CI takes up to 45 minutes and the cache is best-effort (several GB, evicted at the repository budget); `hosts.toml` falls back to the upstream
- Kind host port mappings (30080→8080, 80→9080, 443→9443) work on Linux only: Docker Desktop on macOS forwards packets with bad TCP checksums that Cilium's BPF delivery lets the pod validate and drop. The ArgoCD script therefore uses its own `kubectl port-forward` (default `127.0.0.1:18080`), `task localdev:ui` / `task localdev:traefik` expose the UI (8080) and Traefik (9080/9443) from macOS, and every check that matters (smoke hooks, e2e) runs in-cluster (see bugs.md, 2026-09-13)
- `tools.kind`, `tools.argocd`, `tools.chainsaw`, `images.kind-node`, `images.curl` join `versions.yaml` and are mirrored in `mise.toml` and `tilt-ci.yml`

**Amendment (2026-09-14): the Kind loop tracks the PR head, not `main`**
- Problem: with every Application declaring `targetRevision: main`, ArgoCD compared the Kind deploy against a revision that did not contain the PR (new charts needed the `new-empty` / `ComparisonError` special case), and the `kind-preview` report on PR #280 listed all 44 Applications, `paperclip` included, as "same as main" because it ran before ArgoCD re-compared against Git (bugs.md 2026-09-14)
- `task localdev:argocd -- --revision <ref>` (env `LOCALDEV_REVISION`) rewrites the placeholder `main` in the root Application's `spec.source.targetRevision` and `spec.source.helm.valuesObject.global.targetRevision`; the default is the upstream branch of HEAD, and `main` with a warning when HEAD has no upstream. The `gitops` chart hands `global.targetRevision` to `addons` and `applications` through `helm.valuesObject` (helm sources only, so homelab's CMP path is unchanged; ADR-010), and their templates already give every git-path child `global.targetRevision`, so all three tiers track the head
- Applications are still synced from the working tree with `--local` and automated sync stays off: `Synced` now means the tree equals the pushed head, `OutOfSync` means unpushed local changes (or the `main` fallback). Health + last operation remain the contract; the `new-empty` case and `isNewChartApp` remain for the fallback only
- `task localdev:report -- --base <ref>` (default `main`; CI passes the PR base branch) runs `argocd app diff <app> --revision <base>` for every git-path Application (chart-sourced ones are compared on their parent), so the `kind-preview` comment keeps its diffs (`-` base, `+` PR) and its table gains a Sync column
- `tilt-ci.yml` (`kind-argocd`) checks out the PR head SHA for same-repo PRs, the commit ArgoCD is told to track (the merge ref is not fetchable by ArgoCD), and sets `LOCALDEV_REVISION` to it (`github.sha` on push to `main`); fork PRs keep the default checkout and fall back to `main`
- Alternative rejected: keep `main` and filter the report — the Applications would still declare a revision that does not contain the PR, and every new chart would keep needing the ComparisonError exception

### ADR-013: Real-hardware feedback without mutating production: label-gated previews, read-only agent access, deploy notifications (2026-09-13)

**Context:**
- After Sections A and B an agent could prove a change statically (level 0) and in Kind (levels 1–2), but Kind cannot show a change on the real cluster (TrueNAS storage, Traefik with real certificates, the production CMP render), and the only way to look at production was a human kubeconfig
- ADR-009 forbids agents from mutating production; the retired gitops-test Tiers 3–4 (apply to prod, repoint live Applications at a branch) were the old answer
- Nobody learned from GitHub whether a merged change actually deployed
- Issue #261 Section C, items 16–18

**Decision:**
- **Previews (item 16):** an ApplicationSet `previews` (charts/gitops, homelab only) with the GitHub pull-request generator deploys every PR labelled `preview` (a maintainer-only action) as Application `preview-pr<N>`: `charts/applications` rendered at the PR head SHA by the same CMP, with plugin env `PREVIEW_PR`/`PREVIEW_APPS` (labels `preview:<app>`) becoming `global.preview.*`. Preview mode renders only the selected TrueCharts apps, named `<app>-pr<N>`, as Applications in namespace `preview-<N>` (ArgoCD apps-in-any-namespace, `application.namespaces: preview-*`), in AppProject `previews` (destinations `preview-*` only, the only cluster-scoped kind is Namespace, no `onepassword.com`), with hostnames `<app>-pr<N>.<domain>`, ephemeral (`emptyDir`) config and media volumes instead of the production claims — the democratic-csi classes are `Retain`, so fresh PVCs would leave a Released PV and a TrueNAS dataset behind every closed preview — PodSecurity `baseline` (flaresolverr needs capabilities `restricted` forbids), a ResourceQuota that admits zero PVCs and zero storage (so "a preview claims no volume" is enforced at admission) and a LimitRange. Closing or unlabelling the PR deletes the Application and, through finalizers, everything it created. Level 0 renders the mode as env `homelab-preview`
- **Kind report (item 17):** the required `kind-argocd` job posts a sticky PR comment with every Application's health and last operation, the failing level-2 checks, and `argocd app diff` of each Application against `main` (the root Application targets `main` while the tree is synced with `--local`, so live vs target is exactly PR head vs `main`)
- **Read-only access (item 18):** chart `agent-readonly` (ServiceAccount + token, the built-in `view` role plus get/list/watch on cluster-scoped objects and this repo's CR groups, never Secrets, never a write verb) is deployed in both environments so Kind proves the RBAC; the Tailscale operator's API server proxy runs in `noauth` mode (the kube-apiserver authorises the caller's own ServiceAccount token); ArgoCD gains a local `agent` account bound to `role:readonly`; `homelab verify prod` reads Application state through the `homelab-readonly` context and refuses Kind contexts; `scripts/prod-readonly.ts` writes the kubeconfig from 1Password and runs read-only `status`/`diff`
- **Deploy notifications (item 18):** ArgoCD notifications post a commit status and a PR comment through a GitHub App when `bootstrap`, `addons` or `applications` deploy, fail to sync or degrade — gated off until the App and its 1Password item exist

**Alternatives Considered:**
- vcluster per PR for operator/CRD changes -> needs ArgoCD cluster-registration glue and cannot be exercised without the homelab cluster; namespaces first (issue open question 3), vcluster left for when a PR needs it
- Repoint the live `gitops`/`addons`/`applications` Applications at the branch -> retired by ADR-009; leaves production on an unmerged branch
- GitHub webhooks for the PR generator -> the ArgoCD ingress is internal-only; polling every 5 minutes is enough
- Tailscale impersonation mode (`apiServerProxyConfig.mode: "true"`) -> needs ACL grants in the SOPS-encrypted policy for every agent identity; `noauth` + a revocable ServiceAccount token is simpler, and the Group binding `homelab:agent-readonly` is already in place for a later switch
- Cluster-admin kubeconfig over Tailscale for agents -> violates ADR-009

**Consequences:**
- A preview runs the PR's templates in the homelab cluster with the production configuration; the maintainer-applied label is the trust boundary (fork PRs included), and the AppProject bounds what a preview can create
- Only apps without 1Password secrets or static volumes are previewable; operator and CRD changes cannot be previewed yet
- The CMP image changes (`cmp/plugin.yaml` forwards the preview parameters), so the pinned tag is bumped with it
- Human steps before the features are live: label a PR, grant the agent device access to `tag:k8s-operator:443` in the tailnet ACL, store the ServiceAccount token and an `argocd account generate-token --account agent` token in 1Password, create the GitHub App for notifications and flip its two flags (`docs/runbooks/readonly-access.md`, `docs/runbooks/previews.md`)

### ADR-014: Upgrades, recovery and the agent contract are executable: upgrade gate, restore drill, scaffolder, verification hook (2026-09-13)

**Context:**
- A Renovate chart bump changed one line of `versions.yaml`, but level 0 only sees the Application (`targetRevision`), not what the upstream chart renders; bumps sat red because snapshots, CRD schemas and the committed localdev values had to be regenerated by hand, and the patch automerge rule set `platformAutomerge: true` while the `main` ruleset requires no checks
- `docs/disaster-recovery.md` described backups (Velero, B2, an etcd CronJob, a `pg_dump` CronJob) that do not exist, and nothing restored anything
- Adding an app touched ~15 files by convention; agents reproduced the pattern from memory
- Level 0 ran only when an agent remembered to run it, and the JSON summary in a PR body was never checked
- Issue #261 Section D, items 19–22

**Decision:**
- **Upgrade verification (item 19):** `homelab verify upgrade --base <ref>` renders the base ref in a temporary worktree and the working tree, and for every Application whose Helm chart source changed runs `helm template` of the upstream chart at both versions with the Application's values and diffs the normalised manifests. `upgrade.yml` posts the diff (`upgrade-diff` comment), re-extracts CRD schemas and revalidates every custom resource against them, and on Renovate branches sets the `upgrade/automerge-gate` status: success only when no rendered manifest changed. Renovate automerges non-major chart and image bumps itself (`platformAutomerge: false` everywhere) only when every check, including the Kind loop and the gate, is green. An optional regeneration bot (GitHub App token, so its push triggers workflows; listed in Renovate `gitIgnoredAuthors`, so Renovate keeps managing the branch) commits the regenerated snapshots, schemas and localdev values — the one exception to ADR-009's "nothing is committed on Renovate branches". A new level-0 check `versions/<env>` fails when a rendered chart version is not the one `versions.yaml` pins, unless the drift is registered with a reason in `tests/gitops/version-drift.yaml` (the plain-Helm `charts/bootstrap` pins for ArgoCD and 1Password Connect are registered pending the owner's upgrade decision)
- **Restore drill (item 20):** the CloudNativePG Barman Cloud Plugin (`cnpg-barman-cloud` addon, both environments) is the backup path; a weekly workflow builds the Kind loop and runs `tests/drills/cnpg-restore`: an S3 fake (versitygw), a Cluster archiving to it, a marker row, a plugin Backup, a new Cluster recovered from it, the marker read back. A failure opens an issue labelled `restore-drill`. `docs/disaster-recovery.md` starts with a table of which claims are verified, implemented, or not implemented
- **Scaffolder (item 21):** `homelab scaffold app <name> --pattern operator|helm|deps-main-config` writes the templates, values and export-template blocks, schema keys, `versions.yaml` entry, child charts, CRD registries, health Lua + fixtures, Chainsaw test and doc stub from `embed.FS` templates of the three existing patterns, regenerates the localdev values and snapshots, and `--dry-run` prints the diff; `task test:scaffold` proves every pattern passes level 0 in a copy of the repo
- **Agent contract (item 22):** a committed Claude Code PostToolUse hook runs level 0 after every edit under `charts/` or `configuration/` and feeds failures back to the agent; `task verify:claim` produces the PR-body block, and `pr-contract.yml` re-runs level 0 and fails when the claim disagrees; the gitops-test skill no longer contains any command that applies to or repoints production

**Alternatives Considered:**
- Renovate `postUpgradeTasks` in the in-cluster Renovate -> needs Go, Helm and Bun in the Renovate image plus an `allowedCommands` admin change; the CI bot keeps the toolchain in one place
- Keep "never commit on Renovate branches" -> every chart bump stays red and needs a human, so the automerge half of item 19 could never happen
- Native `barmanObjectStore` -> deprecated in CloudNativePG 1.26, removed in 1.31; MinIO as the S3 fake -> no longer publishes community images
- Velero for the drill -> not deployed anywhere; the drill tests the path production will use for databases
- A PreToolUse hook that blocks edits -> level 0 takes seconds; blocking every edit is noise, feedback after the edit is enough

**Consequences:**
- Renovate PRs that change rendered manifests still need a human; the gate says so in its status description
- The regeneration bot, the automerge path and the drill's issue reporting need GitHub-side setup (App + secrets; repository labels are created on first use)
- Production still has no object store, so production databases are not backed up until one exists; the drill proves the mechanism, not a production backup
- Every agent edit under `charts/` or `configuration/` costs one level-0 run (`HOMELAB_VERIFY_HOOK=off` disables it); PR bodies must carry a current claim

### ADR-015: Paperclip runs on a CloudNativePG external database, not the operator-managed Postgres (2026-09-13)

**Context:**
- Issue #260 deploys Paperclip (AI agent orchestration) through the official `paperclip-operator`; its `Instance` CRD offers three database modes (`managed`, `external`, `embedded`) and upstream recommends `external` for production
- The `cloudnative-pg` addon (with the Barman Cloud Plugin, drilled weekly in Kind since ADR-014) has been deployed in both environments since ADR-012, but no `postgresql.cnpg.io/Cluster` existed in the repository yet
- The app needs `BETTER_AUTH_SECRET`, an admin password and provider API keys that must never land in git, and a `DATABASE_URL` with credentials
- The `Instance` CRD exceeds the client-side-apply limit, and the operator's chart is OCI-only

**Decision:**
- Four ArgoCD Applications in `charts/applications` (`paperclip.yaml`, gated on `paperclip.enabled`, never previewable): Namespaces (wave 10), `paperclip-operator` OCI chart with `ServerSideApply` and kept CRDs (11), `paperclip-dependencies` `OnePasswordItem`s (12), `paperclip-database` CloudNativePG `Cluster` `paperclip-db` (13), `paperclip` `Instance` in `external` mode plus a PostSync smoke Job (14)
- The `Instance` reads `DATABASE_URL` from the CNPG-generated Secret `paperclip-postgres-app` (`externalURLSecretRef {paperclip-postgres-app, uri}`), so no database credential touches git or 1Password; the Postgres image is pinned in `versions.yaml` (`images.cloudnative-pg-postgresql`) rather than following the operator default
- Auth and API keys come from two 1Password items whose field names equal the Secret keys the operator expects; the admin is bootstrapped once from `PAPERCLIP_ADMIN_EMAIL` (required config key) and sign-up is disabled
- The whole stack runs in the Kind loop (level 2): CloudNativePG is on in localdev and `localdev/fakes/secrets.yaml` seeds the two Secrets

**Alternatives Considered:**
- Operator `managed` database mode -> a single `postgres:17-alpine` StatefulSet the upstream docs call "suitable for development", with no backup or HA path; CNPG gives both once an object store exists
- `embedded` PGlite -> in-process database with no operational story at all
- Addons tier instead of applications tier -> rejected: Paperclip is a user workload, and the CNPG addon (parent wave 1/2) already precedes the applications parent (wave 10/3), so ordering needs no tier change

**Consequences:**
- First `postgresql.cnpg.io/Cluster` in the repository; `paperclip-postgres-app` (the Cluster was renamed from `paperclip-db` on 2026-09-15 after its first bootstrap failed on NFS storage, see bugs.md) is registered in `tests/gitops/known-secrets.yaml` as produced by the operator at runtime, and `paperclip.inc` joins `crd-providers.yaml` / `huge-crd-charts.yaml` with a vendored `Instance` schema
- The stack runs in Kind on every PR: the app image is about 1.5 GB compressed; the registry pull-through cache absorbs repeat runs, the first CI run pays the pull once
- No production database backup until an S3-compatible object store exists (follow-up: `ScheduledBackup` + `ObjectStore`); Paperclip's PVC-backed app-native backups are the interim safety net
- `PAPERCLIP_ADMIN_EMAIL` must exist in the gitignored `homelab.yaml` and in the `homelab-environment-config` 1Password document before the CMP can render; Instance metrics stay off until an OTEL collector exists

- **2026-02-11: ArgoCD CMP for PII removal** — Moved config generation from commit-time to ArgoCD render-time using a Config Management Plugin sidecar. Bootstrap chart breaks chicken-and-egg with 1Password operator. All committed values files sanitized to safe defaults. The design doc (`docs/plans/2026-02-11-argocd-cmp-pii-removal-design.md`) was removed in c4daa10 once implemented; the mechanism is documented in `Claude.md` "CMP Architecture" and extended to child charts by ADR-010.

- **2026-02-13: Dual Traefik Ingress Controllers** — Split single Traefik into external (`external` IngressClass, static IP <TRAEFIK_STATIC_IP>, OIDC, port forwarding) and internal (`internal` IngressClass, dynamic IP, no OIDC). Plex uses external; all other apps use internal. OIDC middleware annotations removed from internal apps. Superseded by ADR-040 (Envoy Gateway); the design doc was removed with it.

### ADR-016: etcd gets its own disk; the control planes leave the shared VM pool (2026-09-15)

**Context:**
- The Kubernetes API at the Talos layer-2 VIP dropped out sporadically for months. On 2026-09-15 it returned 1283 5xx in an hour, three controllers lost their leader leases, and the VIP itself was dropped and re-elected twice (11 s and 36 s unreachable). `docs/project_notes/bugs.md` has the full evidence
- Root cause: the three control-plane VM system disks shared the ZFS mirror `vm-storage` (2x Crucial CT1000P310SSD8, QLC) with every worker system disk. etcd's write-ahead log lives on the Talos EPHEMERAL partition of that disk. Unpacking one 1.6 GB container image on a worker wrote ~6.5 GB and pushed etcd `fdatasync` from ~1 ms to 48 s on all three members at once
- Even at rest the control-plane VMs were I/O-stalled 25-30 % of the time (`io.pressure full avg300`) and etcd logged `leader failed to send out heartbeat on time` a few times an hour
- etcd was not scraped by Prometheus at all (`up{job=~".*etcd.*"}` empty) and the repository contained no custom alert rule, so none of this was visible
- The Proxmox host has an unused Samsung 990 PRO 1 TB NVMe (no partitions, no LVM PV, no ZFS label)

**Decision:**
- Control-plane system disks move to a new **single-device** ZFS pool `cp-storage` on that NVMe (`terragrunt/environments/homelab/proxmox-zfs-pool-cp`, a second instance of the `proxmox-zfs-pool` module with `create_resource_pool = false`). The `talos-cluster` module gains `control_plane_datastore_id`; the control-plane `disk` block uses `coalesce(var.control_plane_datastore_id, var.datastore_id)`, so workers and any other environment are unaffected
- etcd is tuned for a virtualised disk: `cluster.etcd.extraArgs` `heartbeat-interval=250`, `election-timeout=2500` (upstream requires election >= 10x heartbeat; defaults 100/1000 assume bare metal), and `listen-metrics-urls=http://0.0.0.0:2381`
- kube-prometheus-stack scrapes `kubeEtcd` on the three control-plane IPs in homelab (off in Kind, which has no such endpoint), which also activates the chart's built-in etcd rules (`etcdHighFsyncDurations`, `etcdHighNumberOfLeaderChanges`). Three homelab rules are added: `KubeAPIServerErrorsHigh`, `NodeDiskWriteLatencyHigh` and `EtcdMetricsAbsent` (the last guards against the scrape silently disappearing again)
- `scripts/apiserver-stress.ts` (`task apiserver:probe`, `task apiserver:stress`) probes the VIP and each control plane side by side with read-only GETs, so a VIP failover is distinguishable from an API outage. It can never mutate the cluster: a single request function asserts the method is GET
- Migration, gates and rollback: `docs/runbooks/control-plane-storage.md`. One control plane at a time, because a datastore change stops the VM

**Alternatives Considered:**
- **Add the NVMe as a SLOG to `vm-storage`** -> keeps mirror redundancy for the control planes and fixes sync-write latency, but leaves them sharing queue and bandwidth with worker I/O; the measured problem was 25-30 % I/O stall, not only fsync. Documented in the runbook as the fallback if the single device is unacceptable
- **Mirror two NVMe devices for `cp-storage`** -> the right end state, but only one NVMe is free today. etcd is already replicated across three nodes, so a device loss costs one member, not the cluster; adding a second device later is a `zpool attach`
- **Raise only the etcd timeouts** -> masks the symptom. A 48 s fsync defeats any timeout worth setting, and higher timeouts slow real failure detection
- **Throttle worker I/O** (Proxmox per-disk `mbps` limits) -> penalises legitimate work and needs re-tuning per workload; isolation is the property actually wanted
- **Move etcd to a separate Talos disk** (`machine.disks` + an etcd mount) -> also correct, but changes Talos partitioning on a live cluster, which is riskier than moving the VM disk the cluster already has

**Consequences:**
- The control planes run on a single physical device with no redundancy. Accepted because etcd is replicated x3 and the failure mode (one member down) is one the cluster already tolerates; an etcd snapshot before the migration and a second NVMe afterwards are the mitigations. The runbook makes the snapshot a gate
- `zpool create -f` wipes the target device, so the runbook opens with a check that it is unused. A wrong device here destroys data
- `proxmox-zfs-pool` now has a `count`-gated resource pool and a `moved` block; the existing homelab state migrates to `[0]` without recreating the pool
- The migration is not zero-downtime: each control plane stops while its disk moves. Done one at a time with etcd verified between nodes, the API stays up through the VIP
- etcd metrics exist from now on, which is how the next occurrence gets diagnosed in minutes rather than months. `EtcdMetricsAbsent` fires if that regresses
- Unrelated findings recorded in the runbook rather than fixed here: the Proxmox root filesystem is 100 % full from an unmanaged failing `vzdump` job, and the unused Cilium LB pool `control-plane-vip` would let a labelled Service announce the API VIP from a worker

### ADR-017: Alert notifications are routed by severity to Pushover from one 1Password item (2026-09-19)

**Context:**
- Issue #42: kube-prometheus-stack ran Alertmanager with the chart's default config, so every alert (including the built-in rules ADR-016 activated) went to the `null` receiver; nothing ever reached a person
- Receiver credentials (a Pushover token and user key) are secrets and cannot sit in `charts/addons/values-homelab.yaml` or in an Application spec; ADR-010 already routes every secret through an OnePasswordItem in a `*-config` child chart
- Alertmanager is off in Kind (`SECRETS_PROVIDER=none`, no routes worth testing), so the design must render nothing secret-dependent there while staying one template

**Decision:**
- Routing and receivers are `alertmanager.config` inside the kube-prometheus-stack Application (`charts/addons/templates/kube-prometheus-stack.yaml`): `critical` -> `pushover-critical` (Pushover priority 1, high), `warning` -> `pushover-warning` (priority -1, silent), `info`/`Watchdog`/`InfoInhibitor` -> `null`; a critical alert inhibits the same-name warning in the same namespace
- The credentials are one 1Password item (`ALERTMANAGER_1P_PATH`, fields `pushover_token`, `pushover_user_key`). `charts/prometheus-config` renders the OnePasswordItem -> Secret `alertmanager-notifications` (wave 8), the Application mounts it through `alertmanagerSpec.secrets` and every receiver reads a `*_file`, so the Application spec carries paths, never values
- `SECRETS_PROVIDER` drives `alertmanager.notifications.enabled` in the CMP template: without a secret store the Secret is not mounted and every route ends in `null`; in Kind Alertmanager stays disabled as before
- Four homelab rules join the control-plane group of ADR-016 under `additionalPrometheusRulesMap`: `HomelabNodeNotReady`, `HomelabNodeUnderPressure`, `HomelabEtcdQuorumAtRisk`, `HomelabPostgresClusterDown`; the chart's `defaultRules` stay on and are routed by their own severities
- `docs/runbooks/alerting.md` holds the routing table, the item fields, the delivery test (`amtool alert add` from inside the pod) and the local `amtool check-config` step

**Alternatives Considered:**
- **An `AlertmanagerConfig` CR (monitoring.coreos.com) in prometheus-config** -> keeps routing next to the Secret, but the operator namespaces every matcher (`namespace=monitoring`) unless the global route is configured to accept it, its CRD schema is not vendored for kubeconform, and the routing would live away from the rules it serves
- **Pushbullet, as the issue title says** -> Alertmanager has no Pushbullet receiver; the issue's own YAML used `pushover_configs`, which is native and supports `token_file`/`user_key_file`. A Pushbullet bridge would be a webhook receiver plus a service to run; not worth it while Pushover does the job
- **A Slack receiver next to Pushover** (the issue's original ask, and the first revision of this change) -> a second channel to keep credentials for and to watch; the owner wants one channel, and Pushover carries the severity split as priority (high pages, low is silent)
- **Secrets by `$(ENV)` expansion or `existingSecret` values** -> the chart does not template `alertmanager.config` from env; `*_file` fields plus `alertmanagerSpec.secrets` is the supported path and keeps the config readable in the snapshot

**Consequences:**
- Alertmanager will not start until the 1Password item exists (its Secret volume is missing); the OnePasswordItem health script shows Degraded until then, which is the intended signal. Creating the item needs no sync
- Every default rule with `severity: critical` now pages through Pushover. If a chart default proves noisy, the fix is a matcher route to `pushover-warning` or `null` for that alertname, recorded in the runbook, not a lower severity on the rule
- ArgoCD and cert-manager metrics were not scraped when this was written (their ServiceMonitor CRD arrived at wave 9, after they install); ADR-018 moves the CRDs to the bootstrap chart and turns those monitors on

### ADR-018: The Prometheus operator CRDs are installed by the bootstrap chart, before ArgoCD (2026-09-19)

**Context:**
- kube-prometheus-stack installs the monitoring CRDs (ServiceMonitor, PodMonitor, PrometheusRule, ...) at addons wave 9. ArgoCD (bootstrap wave 1), cert-manager (wave 4) and every other early addon therefore could not render a ServiceMonitor: the sync would fail on an unknown kind, so their metrics were never scraped and ADR-017's alerting had no view of Application health or certificate expiry
- The `gitops/<env>/crd-order` level-0 rule (tests/gitops/crd-providers.yaml) enforces exactly this ordering, so the fix has to move the provider, not bypass the rule

**Decision:**
- The CRD-only companion chart `prometheus-operator-crds` is a bootstrap Application at wave -1 (`charts/bootstrap/templates/prometheus-operator-crds.yaml`, ServerSideApply because the Prometheus CRD is several hundred KiB), pinned in `charts/bootstrap/values.yaml` and `configuration/versions.yaml` (`charts.prometheus-operator-crds`), with a `versions/pins` entry so the two cannot drift
- kube-prometheus-stack runs with `crds.enabled: false`; `tests/gitops/crd-providers.yaml` names `prometheus-operator-crds` as the provider of `monitoring.coreos.com`
- The CRD chart version tracks the operator version the kube-prometheus-stack chart bundles (87.1.0 bundles v0.92.0, matched by prometheus-operator-crds 30.0.0). Renovate groups both into the `Monitoring stack` PR (`.github/renovate.json5`) so they move together; the rule is to merge that PR as a pair and never let the CRDs lag the operator
- ArgoCD (every component) and cert-manager now render ServiceMonitors; two rules join `homelab-infrastructure`: `HomelabArgoCDApplicationDegraded` and `HomelabCertificateExpiringSoon`

**Alternatives Considered:**
- **Move kube-prometheus-stack itself to an early wave** -> it needs storage (democratic-csi, wave 3) and the ingress stack for Grafana; the CRDs are the only part anything earlier depends on
- **Vendor the CRDs into the repository** (a kustomize directory) -> the same ordering fix but with a copy to keep in sync by hand; the companion chart is maintained upstream and versioned against the operator
- **Skip CRDs in the charts that render monitors** (`skipCrds`, `serviceMonitor.enabled: false` until wave 9) -> leaves the metrics unscraped, which is the problem

**Consequences:**
- A fresh bootstrap installs the CRDs before anything can reference them; on the running cluster the first sync hands CRD ownership from the kube-prometheus-stack release to the new Application (server-side apply, same objects), which ArgoCD reports as SharedResourceWarning until kube-prometheus-stack re-syncs with `crds.enabled: false`
- The chart pair must be upgraded together; Renovate's `Monitoring stack` group carries both in one PR, and a hand-made bump of only kube-prometheus-stack to an operator newer than the CRDs is the failure mode to watch for. `docs/runbooks/alerting.md` has the lookup
- Kind never creates the bootstrap Application (`charts/gitops/values-localdev.yaml`), so `scripts/localdev-argocd.ts install` installs the same CRD chart with Helm before ArgoCD; without that, cert-manager's ServiceMonitor failed to apply in the Kind loop the first time this shipped, and kube-prometheus-stack's own monitors would have too. The addons' ServiceMonitors therefore apply in Kind even though Alertmanager stays off

### ADR-019: Cluster logs go through OpenTelemetry collectors into ClickHouse run by the Altinity operator (2026-09-23)

**Context:**
- The Paperclip API is intermittently unresponsive, and the cluster could not show why: Traefik wrote no access logs and was not scraped, and nothing kept container logs beyond the kubelet's rotation
- The store must keep 90 days of every container log and Kubernetes event on the homelab's own hardware, be queryable from the existing Grafana, and follow the repository's patterns (versions in `versions.yaml`, secrets from 1Password, block storage for databases, level 0 + Kind level 2)

**Decision:**
- Collection: two releases of the upstream `opentelemetry-collector` chart with the contrib image. `otel-collector-agent` is a DaemonSet with the chart's `logsCollection` (filelog on `/var/log/pods`, CRI parser, checkpoints in `/var/lib/otelcol`) and `kubernetesAttributes` presets; `otel-collector-cluster` is one replica with the `kubernetesEvents` preset. Both export with the `clickhouse` exporter straight to ClickHouse, no gateway tier
- Store: the Altinity `clickhouse-operator` chart (`charts.altinity-clickhouse-operator`, CRDs from its `crds/`, its `bitnami/kubectl:latest` CRD hook disabled) and one single-node `ClickHouseInstallation` `logs` (`charts/clickhouse`) on `STORAGE_CLASS_ISCSI_SSD` (100Gi, ADR-021), image pinned in `images.clickhouse-server` (26.8 LTS)
- Retention: the exporter's `ttl: 2160h` becomes the `otel_logs` table TTL when `create_schema` creates it (90 days); `docs/logging.md` documents the `ALTER TABLE ... MODIFY TTL` needed to change it later, and the `logging` e2e test asserts the TTL exists
- Users: `otel` (ALL on `otel.*`) and `grafana` (SELECT on `otel.*`), passwords from two 1Password items through `charts/clickhouse-dependencies` (wave 8, before Grafana at 9); ClickHouse reads them as environment variables (`valueFrom.secretKeyRef`), never from a ConfigMap
- Grafana installs `grafana-clickhouse-datasource` (pinned in `images.grafana-clickhouse-datasource`) and provisions datasource `clickhouse-logs` with the OpenTelemetry logs settings; the password is expanded from the environment at provisioning time
- Traefik (both releases) writes JSON access logs to stdout and gets a metrics Service + ServiceMonitor on its `metrics` entrypoint
- Alerts in `homelab-logging` and `homelab-ingress` (warning), adapted from the collector chart's and Altinity's upstream rules; the chart's own default collector rules stay off because every one is `critical`

**Alternatives Considered:**
- **Loki** -> the common Grafana choice, but the requirement was a SQL-queryable store; ClickHouse also answers the access-log questions (p95 per host, 5xx by path) with plain SQL over the JSON body
- **Official ClickHouse Kubernetes operator** -> younger, with fewer users and no chart-shipped monitoring; Altinity's operator has run ClickHouse on Kubernetes for years, ships a metrics exporter, a ServiceMonitor and Grafana dashboards, and its CRDs are vendorable for kubeconform
- **Plain StatefulSet** -> no upgrade, user or config management; the operator's `ClickHouseInstallation` keeps users and storage declarative
- **opentelemetry-operator** -> one more controller and CRD set for two static collectors; the chart's presets already encode the Kubernetes log pipeline
- **A gateway collector tier** -> useful for fan-out or tail sampling; with one sink and five nodes, each agent's exporter queue and retry are enough
- **NFS storage** -> ClickHouse renames and fsyncs parts constantly; block storage as for PostgreSQL (ADR-008, ADR-015)

**Consequences:**
- New namespace `observability` at PodSecurity `privileged` (hostPath mounts, root agent)
- Grafana does not start until Secret `monitoring/clickhouse-grafana` exists: the 1Password items `clickhouse-otel` and `clickhouse-grafana` (field `password`) must be created before the first sync
- The single ClickHouse node is not replicated; losing its volume loses the log history, not the pipeline. Logs are diagnostic data, so no backup is set up
- The operator's own ClickHouse user `clickhouse_operator` keeps the chart's default password (Secret rendered by the chart); moving it to a 1Password item is a follow-up
- Kind runs the whole pipeline at small sizes, and the `logging` e2e test proves rows arrive with the TTL set

### ADR-020: Istio ambient mesh on Cilium, opt-in per namespace, with Kiali (2026-09-23)

**Context:**
- Diagnosing intermittent failures between services needs L4 (and optionally L7) telemetry and a traffic graph; the cluster had neither
- Cilium is the CNI with kube-proxy replacement and BGP (ADR-012 keeps it in Kind too); a mesh must not disturb it or any workload that has not asked to join

**Decision:**
- Istio in ambient mode from the four official charts (`base`, `istiod` and `cni` with `profile: ambient`, `ztunnel`), one version key `charts.istio` so they cannot drift, waves 2-4, namespace `istio-system` at PodSecurity `privileged`; enabled wherever `CNI_PROVIDER=cilium`. Version 1.31.1 from `blob.istio.io` (the GCS repository ends at 1.30.5): 1.31 supports Kubernetes 1.32-1.36, covering production (v1.32.0) and Kind (v1.36.1); `tools.kubernetes` v1.37.0 needs a later Istio before the cluster moves past 1.36
- Cilium gets Istio's documented prerequisites: `cni.exclusive=false` and `socketLB.hostNamespaceOnly=true`, in the CMP template (Kind and the adopting Application) and in `task cilium:render` (Talos inline manifest). The homelab change needs `task render && task render:push && task tf:apply` and an agent restart by a human
- Enrollment is per namespace through `SERVICE_MESH_AMBIENT_NAMESPACES` and `SERVICE_MESH_WAYPOINT_NAMESPACES` (comma-separated, both default `paperclip`, amended by ADR-021): only paperclip is in the mesh, with a waypoint that ingress traffic also uses; its CNPG database opts out
- Monitoring: the upstream Prometheus operator monitors (`charts/istio-config`), the grafana.com Istio dashboards, and `homelab-service-mesh` alerts on istiod, the node agents and xDS rejects
- Kiali (`kiali-server` chart) on the internal ingress at `SERVICEMESH_HOSTNAME` (`servicemesh.<DOMAIN>`), token login, reading the kube-prometheus-stack Prometheus and Grafana; its Ingress is rendered by `charts/istio-config` because the chart's capability-dependent one stayed OutOfSync

**Alternatives Considered:**
- **Sidecar mode** -> every enrolled pod gets an Envoy with its own resources and restart ordering; ambient adds nothing to a pod and can be enabled per namespace without restarts of the mesh itself
- **Cilium service mesh** -> already present, but its mTLS and L7 story needs Envoy per node and gives no Kiali-style graph; Istio ambient is the requested stack and coexists with Cilium when the two prerequisites are set
- **Kiali operator** -> a CRD and a controller for one instance; the server chart is enough
- **Anonymous Kiali behind the internal ingress** -> the LAN and tailnet would see the full mesh configuration without login; token login costs one `kubectl create token`

**Consequences:**
- Until the human applies the Cilium change in homelab, a Cilium agent restart can remove istio-cni's chained config; harmless while nothing is enrolled
- Enrolled namespaces with a default-deny policy must allow kubelet probes from `169.254.7.127`
- Kiali's Grafana links need Grafana credentials it does not have; the graph and metrics work, dashboard links may not
- Every node runs two more DaemonSets (istio-cni-node, ztunnel), also in Kind and every PR's level-2 run
- Istio ambient on Talos has no upstream test record (siderolabs/talos#7380 closed as stale); the Kind loop proves the charts and the Cilium settings, the first production sync proves Talos

### ADR-021: One correlated paperclip request path: traces in ClickHouse, a gateway collector for OTLP and UniFi, probes, paperclip in the mesh (2026-09-23)

**Context:**
- The paperclip API "occasionally fails to respond", yet Traefik showed no 5xx, no restarts, only 499 client aborts and a few 429s, so the failure may be before Traefik. Logs alone (ADR-019) cannot say which hop of client -> UniFi -> LB address -> Traefik -> app -> database failed
- The UniFi gateway can export syslog (CEF over UDP, Settings -> Control Plane -> Integrations and CyberSecure -> Traffic Logging, "SIEM Server") and IPFIX flow records (CyberSecure -> Traffic Logging -> NetFlow (IPFIX), collector IP + port, default 2055); both take an IP address and have no authentication
- Production runs Kubernetes v1.32.0 while `tools.kubernetes` targets v1.37.0

**Decision:**
- Traces go to ClickHouse too (`otel.otel_traces`, exporter `traces_table_name`, the same 2160h TTL as logs so a log line and its trace expire together), through a third collector release `otel-collector-gateway` (Deployment, OTLP gRPC/HTTP). Traefik starts/continues W3C `traceparent` (10 % in homelab) and logs `TraceId`/`SpanId`, `User-Agent` and every timing/status field; waypoints send spans via istiod's `opentelemetry` extension provider and a mesh-wide Telemetry (10 %). Grafana's ClickHouse datasource gets the traces settings and the plugin's Logs/Traces Explorer dashboards
- The gateway collector also receives UniFi syslog (UDP/TCP 514 -> 5514, CEF header parsed) and NetFlow v5/v9/IPFIX (UDP 2055) and writes them to `otel_logs`. It is exposed as a Cilium LB IPAM LoadBalancer at a fixed `OTEL_LB_IP` published as `otel.<DOMAIN>`, restricted to the LAN with `loadBalancerSourceRanges`; OTLP/HTTP with TLS is additionally at `otlp.<DOMAIN>` through the internal ingress
- Cilium's Hubble flow log (ADR-022) and the Traefik access log join in ClickHouse on client IP, 5-tuple and time; the access log joins traces on TraceId
- Paperclip is enrolled in the ambient mesh with a waypoint in every environment (`SERVICE_MESH_AMBIENT_NAMESPACES`/`SERVICE_MESH_WAYPOINT_NAMESPACES` default `paperclip`), with `istio.io/ingress-use-waypoint` so Traefik's requests get L7 metrics and spans; an extra NetworkPolicy opens HBONE 15008 next to the operator's; the CNPG database opts out of mesh and waypoint
- blackbox-exporter probes paperclip every 15 s through its public name (DNS + traefik-internal) and directly at the Service, so a failure names the hop; `homelab-probes` alerts. One Grafana dashboard, "Paperclip request path", links probe, Traefik, access log, trace, mesh, Hubble, UniFi, pod and database panels through `trace_id` and `client_ip` variables; `docs/runbooks/paperclip-request-path.md` says which panel answers which hop
- Istio 1.31.1 (supports Kubernetes 1.32-1.36): the running v1.32.0 and Kind's v1.36.1

**Alternatives Considered:**
- **Tempo/Jaeger for traces** -> another store to run and size; the ClickHouse plugin already has trace views and the correlation queries are SQL joins on one database
- **Traefik UDP/TCP entryPoints for syslog/NetFlow** (IngressRouteUDP) -> no extra IP, but Traefik proxies UDP (new source address, no per-packet path) and the hostname would share Traefik's address, which the OTLP ingress also needs; a dedicated LoadBalancer keeps the raw protocols out of the ingress controller
- **`externalTrafficPolicy: Local`** (keep client source IPs at Traefik and the collector) -> Cilium's L2 lease holder or BGP speaker (control planes) would have to run a backend pod or traffic is dropped; not taken, documented as the trade-off. UniFi flow records and Hubble carry the real 5-tuple instead
- **Keep paperclip-postgres in the mesh** -> mTLS for a same-namespace database adds a ztunnel restart as a new way to cut its connections, for no isolation gain

**Consequences:**
- ClickHouse grows to 100Gi (estimate in docs/logging.md) and the gateway collector is one more Deployment; Kind runs all of it (level 2 proves an OTLP span reaches `otel_traces` and paperclip works through its waypoint)
- The in-cluster ingress probe does not cross the L2/BGP hop (Cilium short-circuits LB addresses in the cluster); hops 1-2 are judged from UniFi flow records
- UniFi must be pointed at `OTEL_LB_IP` by hand after merge; `HomelabUniFiTelemetrySilent` fires until it is
- Kind's ClickHouse passwords are no longer in git: `scripts/localdev-kind.ts fakes` fills annotated Secret stubs with random values once

### ADR-022: Hubble flow metrics, UI and a filtered flow log, with GitOps-side monitors (2026-09-23)

**Context:**
- Hubble relay and UI were already on in the Talos Cilium values but unexposed and unscraped; Cilium itself was not scraped at all
- Talos installs Cilium from inline manifests before any CRD exists, so ServiceMonitors in the Cilium chart would break the bootstrap apply; `task cilium:render` duplicated the values as `--set` flags and could drift from the adopting Application

**Decision:**
- Cilium values (homelab): `hubble.metrics` (dns, drop and flow with namespace/workload context, tcp, port-distribution, icmp), `prometheus.metricsService`, `operator.prometheus.metricsService`, and `hubble.export.static` writing `/var/run/cilium/hubble/events.log` with every paperclip/traefik flow and every DROPPED/ERROR verdict; the OpenTelemetry agents tail it into ClickHouse
- The upstream Cilium/Hubble dashboards come from grafana.com (16611-16613, 19424, 19425) rather than the chart's ConfigMaps, which would add ~0.5 MB to the Talos inline manifest
- `charts/cilium-config` (wave 8) holds the ServiceMonitors and the Hubble UI Ingress at `HUBBLE_HOSTNAME` (`hubble.<DOMAIN>`); `homelab-network` alerts
- `task cilium:render` renders from `cilium.values` of the CMP template via `homelab config export`, the same map the Application uses
- Kind keeps Hubble off

**Alternatives Considered:**
- **`hubble.export.dynamic`** -> reconfigurable without agent restarts, but one static filter is all this needs
- **Hubble exporter to OTLP directly** -> not in Cilium 1.19; the file plus the existing agent reuses the log pipeline
- **httpV2 Hubble metrics** -> need Cilium L7 visibility, which must not be combined with Istio L7 on enrolled pods; waypoint metrics cover L7

**Consequences:**
- Needs `task render && task render:push && task tf:apply` and a Cilium agent/operator restart by a human
- Hubble UI has no login; it is reachable only through the internal ingress
- For ambient-enrolled pods Hubble sees HBONE (TCP 15008) between nodes, not the app port

### ADR-023: BGP only between the workers and the UniFi gateway, with ECMP (2026-09-23)

**Context:**
- `CiliumBGPClusterConfig homelab-bgp` selected the control planes, while the gateway FRR config listed all six nodes; the three worker sessions could never establish
- The three control-plane sessions were up but advertised nothing (bug log, 2026-09-23), so LoadBalancer reachability relied entirely on the worker L2 announcements
- Control planes run etcd, whose fsync stalls already cost API availability (control-plane-storage runbook); ingress traffic on them competes for the same CPU and network

**Decision:**
- BGP speakers are the workers only: `nodeSelector` control-plane `DoesNotExist`, the same selector as `CiliumL2AnnouncementPolicy default`
- `CiliumBGPPeerConfig unifi-gateway-peer` negotiates `ipv4/unicast` and selects advertisements labelled `advertise: loadbalancer-ips`
- The `unifi-gateway` unit peers with `worker_nodes` only; the FRR template sets `maximum-paths` (default: number of neighbors) so the gateway spreads each `externalTrafficPolicy: Cluster` /32 across every worker
- L2 announcements on the workers stay as the fallback when BGP is down

**Alternatives Considered:**
- **Control planes only (fix just the advertisement selector)** -> every LoadBalancer flow would enter through an etcd node
- **All six nodes** -> same etcd concern, and ECMP across the control planes adds no capacity the workers lack
- **Drop BGP, L2 only** -> one lease holder per Service IP takes all ingress traffic; no ECMP and a failover waits for the lease to expire

**Consequences:**
- `externalTrafficPolicy: Local` Services (Plex) are advertised only from workers with a local endpoint, which is intended
- A worker recreate or IP change needs `task tf:apply:component COMPONENT=unifi-gateway`
- Rolling out needs the addons sync (Cilium CRs) and that apply; order does not matter because the L2 fallback covers the gap

### ADR-024: UniFi syslog and NetFlow exports from the unifi-gateway unit, NetFlow through the controller API (2026-09-24)

**Context:**
- `HomelabUniFiTelemetrySilent` fired because the gateway exports (ADR-021) were a manual UI step nobody had done
- `ubiquiti-community/unifi` models remote syslog (`unifi_setting.syslog`, the `rsyslogd` key, since 0.53) but no NetFlow setting; neither do the other UniFi providers
- The controller accepts `PUT /proxy/network/api/s/<site>/set/setting/netflow` after a cookie + CSRF login, which `restapi`-style providers cannot perform

**Decision:**
- The `unifi-gateway` unit manages both exports when `LOGGING_ENABLED` is true, targeting `OTEL_LB_IP` from `configuration/resolved.json` (exported by every `tf:*` task)
- Syslog uses `unifi_setting.syslog`; the provider is pinned to `~> 0.56.0` for this unit only (`versions_override.tf`), because 0.56 turns `unifi_dns_record.ttl` into a string for the other units
- NetFlow uses `terraform_data` + `local-exec` running `scripts/unifi-setting.ts`, which merges the desired fields into the current setting and reads it back

**Alternatives Considered:**
- **Ansible `uri`** -> same raw API, but outside the Terraform plan and a second tool for one gateway
- **`restapi` provider with a UniFi API key** -> needs a new API key credential, and its create/destroy model does not fit a singleton setting that always exists
- **Bump the provider everywhere** -> forces the `unifi_dns_record` ttl migration on three unrelated units

**Consequences:**
- NetFlow drift made in the UI is not detected; the script reruns only when the desired values change
- Disabling the flag stops managing the settings without reverting them
- The first apply needs `task tf:init:component COMPONENT=unifi-gateway TF_ARGS=-upgrade` to move the lock file to 0.56

### ADR-025: Every stateful platform capability is a Kubernetes operator reconciling a CRD (2026-09-25)

**Context:**
- Homelab and the commercial PaaS must share one architecture; the first place two codebases appear is a capability built as a bespoke service on one surface and as an operator on the other
- The platform is event-driven over NATS, and every event path it can offer is at-least-once (ADR-026) — a design that carries state in events would be wrong on delivery semantics from day one
- This repository is already declarative end to end: Talos (ADR-002), ArgoCD (ADR-001), GitOps everywhere. A control plane that is imperative in the middle would be the odd layer out

**Decision:**
- Every stateful platform capability is delivered by a Kubernetes operator reconciling a CRD, on both surfaces, from one operator image
- One controller owns one resource's `status` and nothing else's; where an upstream operator already owns a resource (ArgoCD's `Application`), the platform observes it into its own CRD rather than co-owning it
- Reconcile is a pure function of observed state: server-side apply with a stable field manager, `status.observedGeneration` mandatory, external side effects keyed on `(uid, generation)`, deletion through a finalizer with a documented manual escape
- Reconciling twice with no intervening change produces zero writes, and that is a required test
- Events are a hint, never the carrier of state. A periodic resync is the floor; losing every event costs latency, never correctness
- Observability is part of the interface, not an add-on: reconcile metrics with a `ServiceMonitor`, a span per reconcile linked by `correlationid`, conditions for anything a human waits on, and an SLO with a named owner
- Normative detail: `docs/contracts/operator-model.md`

**Alternatives Considered:**
- **Temporal workflows as the primary control loop** -> excellent for a bounded multi-step process with compensation, but a workflow's completion is not the same thing as convergence; it does not self-heal drift. Temporal stays for orchestration above the operators, not underneath them
- **A bespoke control-plane service holding state in Postgres** -> faster to write, and it makes the cluster's real state a cache the service can disagree with. Two sources of truth is the failure we are trying to avoid
- **Event-sourced state on JetStream** -> makes correctness depend on never losing an event on an at-least-once bus, and makes recovery a replay problem

**Consequences:**
- Convergence is slower than an imperative call: a change takes effect on the next reconcile, not immediately
- CRD schema evolution becomes a first-class obligation (conversion webhooks, storage versions) rather than something deferred
- Operators are cheap to run and awkward to debug; the observability requirements above are the price of that trade and are not optional
- An operator being down freezes change but does not break running workloads — an operator that can break serving traffic when it fails needs an explicitly argued exception

### ADR-026: A seven-token NATS subject taxonomy and a narrowed CloudEvents envelope, with no exactly-once path (2026-09-25)

**Context:**
- The platform is event-driven via CloudEvents over NATS; #50 deploys JetStream and #51 wires Argo Events onto it, so the first streams are about to be named and the naming is hard to walk back
- CloudEvents 1.0 is permissive: optional `dataschema`, free-form `type`, several content modes. Adopting it unmodified means every producer picks its own conventions
- NATS JetStream is widely described as "exactly-once" on the strength of its publish de-duplication window, which de-duplicates publishes, not deliveries
- Subject taxonomies with variable depth make every `*` wildcard a latent bug, because a subject added later can change what an existing subscription matches

**Decision:**
- Every subject is exactly seven tokens: `pf.<tenant>.<domain>.<entity>.<action>.<major>.<suffix>`, with `suffix` one of `ev` (pub/sub), `wq` (durable work queue), `rq`/`rs` (synchronous request/reply)
- The suffix carries the delivery guarantee, so a reader knows it from the subject without opening the registry
- Events are CloudEvents 1.0 structured JSON, narrowed: `datacontenttype` fixed, `dataschema` required, the major version inside `type`, and `tenant` plus `sequence` as required extensions
- **No path is exactly-once end to end and no document may imply one.** Pub/sub and durable requests are at-least-once, ordered per subject (pub/sub) or unordered (work queue); synchronous request/reply is at-most-once. Consumers are idempotent on `(source, id)`
- `tenant` is a trust boundary enforced by NATS account and subject permissions, not by consumer-side filtering; homelab runs the same enforcement with the single reserved tenant `local`
- Three streams: `PF_EVENTS` (7d), `PF_AUDIT` (365d, `discard: new`), `PF_WORK` (work queue). A subject no stream covers is an error, not a warning. *(Revised by ADR-038: `PF_AUDIT` sources from `PF_EVENTS` rather than overlapping it, `PF_DLQ` is a fourth stream, and `PF_WORK` retains for 24h.)*
- The contract is machine-checked: `contracts/events/` plus `task contracts:check`
- Normative detail: `docs/contracts/event-contract.md`

**Alternatives Considered:**
- **Raw JSON messages with a convention** -> no envelope means no tracing, no tenancy attribute, no versioning, and a per-team convention within a quarter
- **CloudEvents binary mode over NATS headers** -> better throughput, and it splits the contract across headers and body and makes every debugging session harder. Revisit if throughput ever justifies it
- **Variable-depth subjects (`pf.tenant.domain.…`)** -> more expressive, and it makes wildcard subscriptions unstable as the taxonomy grows
- **Claiming exactly-once on the strength of JetStream's `duplicate_window`** -> true of publishes, false of deliveries; a consumer can still crash between handling and acking. Stating it would have every consumer author skip idempotency
- **A schema registry service** -> a new runtime dependency and a new outage mode for something a versioned file in Git and a CI check already solve

**Consequences:**
- Renaming a domain or moving a subject is breaking and needs a new major published alongside the old one; the gate enforces this rather than trusting review
- Every consumer must be idempotent, which is real work — it is the same property ADR-025 already demands of operators, so the cost is shared rather than doubled
- Seven fixed tokens force some awkward `<entity>` choices for events that are not about a resource; that is the price of stable wildcards
- Anything that must outlive stream retention (7d / 365d) lives in Postgres or a CRD `status`, never only in a stream
- ~~`PF_AUDIT` deliberately duplicates identity and control events already on `PF_EVENTS`; consumers see each twice, which is safe only because of the idempotency rule~~ **Withdrawn by ADR-038.** This consequence described a stream that could not be created: NATS refuses two streams with overlapping subject filters in one account (`10065`). `PF_AUDIT` now sources from `PF_EVENTS`, a consumer binds one stream, and nobody sees anything twice

### ADR-027: One SDK and one API contract for both surfaces, contract before implementation (2026-09-25)

**Context:**
- Homelab is the adoption funnel for the commercial platform, so the two must stay one product; divergence never arrives as a decision, it arrives as a small convenience taken twice
- Enterprise-only concerns (billing, entitlement, support tooling) genuinely exist and will be pushed into shared code unless there is a stated rule about where they may live
- "The code is the contract" means every consumer reads the implementation and every refactor is a breaking change for someone

**Decision:**
- One SDK package and one OpenAPI 3.1 document, consumed identically by a homelab script and an enterprise service. Enterprise-only concerns layer *above* the SDK; they never branch inside it
- API-first is an ordering rule enforced at review: the contract lands first, the contract tests land with it and fail, then the implementation turns them green. A PR adding an endpoint or event type with no published contract is rejected
- Types are generated from OpenAPI and the event schemas; a hand-written duplicate of a generated type is treated as a fork
- The SDK surface is four seams — `events`, `resources`, `config`, `identity` — and no general-purpose `utils` module
- The SDK cannot break compatibility on its own: a major bump is permitted only when the underlying contract has already published a new major
- Normative detail: `docs/contracts/sdk-boundary.md`

**Alternatives Considered:**
- **Separate homelab and enterprise SDKs with a shared core** -> the "core" boundary is exactly where the divergence hides, and both sides get to decide what belongs in it
- **Implementation-first with generated OpenAPI** -> the document then describes whatever was built, including the accidents, and there is no moment where compatibility could have been argued
- **gRPC/protobuf instead of OpenAPI + JSON Schema** -> stronger compatibility tooling, at the cost of browser ergonomics for the React surface and a second serialization to reason about next to CloudEvents JSON

**Consequences:**
- Every cross-boundary feature is slower to start, because the contract and its failing tests come first
- The SDK is the highest-fan-out artifact in the platform: a breaking change there reaches further than a broken operator, which is why its gates are the strictest
- Enterprise features that genuinely need a hook must get a seam designed for them rather than a conditional, which occasionally means saying no to the fastest path

### ADR-028: Bring-your-own cloud, key, identity centre and agent identity are pluggable seams designed before the first customer (2026-09-25)

**Context:**
- Every serious adopter brings their own cloud, encryption key, identity centre, and increasingly the identities their AI agents act under
- The standard failure is well understood and always looks reasonable at the time: a customer needs a different provider, a branch is cut, and eighteen months later there are several branches and no product
- Retrofitting a seam is far more expensive than designing one, because by then callers have taken direct dependencies on the single implementation
- AI agent identity is the newest trust boundary and has the least industry convention, so its rules have to be written down rather than assumed

**Decision:**
- Four seams, defined in the SDK in the platform's own vocabulary (`getSigningKey()`, never `getKmsKeyArn()`): BYO cloud, BYO encryption key, BYO identity centre, BYO AI agent identity
- Provider selection is configuration resolved once at startup, in one factory per seam. No provider conditional in business logic, anywhere
- A seam is not considered designed until two implementations exist — the homelab default and one alternative — and both pass a shared conformance suite that belongs to the seam, not to an implementation
- Capability is explicit: a provider declares what it cannot do and the platform fails loudly rather than silently degrading
- BYO key is envelope encryption only; the platform never holds the root key, and "the customer can revoke and we lose access" is a conformance test, not a promise
- BYO identity is plain OIDC, and authorization is always against platform roles — never against raw external group names in application code
- Agent identity is short-lived credentials only (the interface has no method returning a long-lived token), every action attributable to an `AgentIdentity` in the CloudEvents `source`, revocation immediate and tested, and an agent's roles a subset of its creator's, checked at admission
- Normative detail: `docs/contracts/byo-extension-points.md`

**Alternatives Considered:**
- **Wait for the first customer to ask** -> the cheapest path today and the one that produces the customer-specific branch; the cost lands on whoever is here in two years
- **A plugin runtime (WASM, out-of-process providers)** -> maximum flexibility, a large new failure surface, and nothing today needs third-party providers to be loadable at runtime
- **Adopt one provider's abstraction (e.g. a cloud SDK's credential chain) as the interface** -> free to build, and it embeds that provider's model into every caller, which is the leak we are preventing

**Consequences:**
- Every seam carries the cost of a second implementation and a conformance suite before it is considered done
- Some provider-specific capability is unavailable through the interface; the escape hatch is a named, documented, explicitly non-portable extension, not a quiet special case
- Homelab is not a toy version of the enterprise path — it is a peer implementation, which is what keeps the seam honest and is why homelab exercises the multi-tenant wiring with a single tenant
- BYO key has the widest blast radius on the platform: losing key access makes data unreadable, and recovery is the customer's key custody, not ours

### ADR-029: Fork-ability is an enforceable rule in the static gate with a named owner (2026-09-25)

**Context:**
- Homelab is the adoption funnel; a fork that does not come up is a lost ambassador and an early warning that the same hard-coding has reached the commercial product
- The repository already has the mechanism — a ConfigSet with a gitignored per-environment file, `<KEY>` placeholders, and `homelab.yaml.example` with `REPLACEME-` values — but it was a convention, enforced by whoever noticed
- Three open issues (#40, #41, #51) specify ingress hostnames with a concrete personal domain in the issue body, which is what a convention with no check produces
- ADR-009 already established the principle for this repository: the static gate is the gate, with no skip lists

**Decision:**
- The rule is stated as a merge condition: no feature ships unless a stranger can fork the repository and run it with their own domain, cloud, secrets and identity provider. A feature that only works on the maintainer's cluster is unfinished, not done-with-a-follow-up
- Three checks, in increasing cost: (1) render every chart against a synthetic ConfigSet and grep the output for real-environment values; (2) assert `homelab.yaml.example` covers every key the render requires; (3) run the documented fork path on a clean machine with none of the maintainer's credentials
- Checks 1 and 2 are static and belong in level 0, so a violation fails a PR. Check 3 is a per-release run with a written result, because its point is the absence of local state and it cannot be faked in CI
- A required new key gets **no** default in `defaults.yaml` — failing at render beats coming up wrong, which is why `DOMAIN` is deliberately absent today
- Owners are named: SRE & Observability Engineer for checks 1–2, DX & Docs Advocate for check 3 and the docs it validates, Principal Platform Architect for the rule and any claimed exception
- Normative detail: `docs/contracts/fork-ability.md`

**Alternatives Considered:**
- **Keep it as a convention in `AGENTS.md`** -> it already is, and #40/#41/#51 show what that produces
- **A secret-scanner-style regex for the maintainer's domain** -> catches one operator's strings and nothing about a fork's actual experience; it would pass a repository that is unforkable for a dozen other reasons
- **Only the periodic fork run (check 3)** -> honest but slow: a violation is found weeks after it merged, by which time other work is built on it

**Consequences:**
- Some PRs get slower, in exactly the places (hostnames, secrets, bootstrap, identity) where being slower is correct
- Check 1 needs a synthetic ConfigSet kept current, which is a small ongoing maintenance cost and an easy thing to let rot — it is a level-0 check so that rot fails visibly
- A required new configuration key becomes a slightly heavier change: example file, docs, no default
- Check 3 needs a genuinely clean machine and cannot be delegated to CI, so it is a scheduled human-run activity with an owner rather than an ambient expectation

### ADR-030: Boundary contracts are gated by a frozen baseline and a named rule set, not by review attention (2026-09-25)

**Context:**
- ADR-026 and ADR-027 are only worth having if a breaking change actually fails; otherwise they are documentation that the next deadline overrides
- Backward compatibility must assume a consumer that cannot be seen and cannot be redeployed — a stranger's fork on the homelab surface, a customer's integration on the enterprise one
- Reviewers reliably miss compatibility breaks, because the diff that removes a field looks exactly like the diff that adds one
- A compatibility checker with no tests of its own quietly stops working, and nobody finds out until it has already passed a break

**Decision:**
- Every boundary carries a contract test that lives with the contract, built on the same four parts: a frozen baseline in the repository, a diff against it, a named rule set that says which differences are breaking, and tests for the checker itself including a baseline-in-sync test
- The event gate is the reference implementation: `contracts/events/registry.v1.baseline.json`, `scripts/contract-check.ts`, `scripts/contract-check_test.ts`, `task contracts:check`. OpenAPI and CRD gates follow the same shape
- One compatibility rule set across events, HTTP and CRDs, so nobody has to remember three
- Gates slot into the existing ladder: level 0 static (contract diffs, fork-ability), level 1 Kind (operator idempotency, conversion webhooks both directions, upgrade diff), level 2 live (consumer contract tests, rollback and restore drills)
- Every cross-boundary change states its rollback in one sentence in the PR. A one-way CRD conversion is not a rollback path; a database migration that cannot be rolled back is escalated before it is written
- A cross-boundary design review states approve / approve-with-conditions / reject against a written checklist. "Looks good" is not a review. The author does not approve their own cross-boundary design
- Normative detail: `docs/contracts/quality-gates.md`

**Alternatives Considered:**
- **Rely on review and a documented policy** -> this is the status quo everywhere it fails; the removing diff and the adding diff look the same
- **A hosted schema-registry service with compatibility modes** -> mature tooling, and a new runtime dependency, a new outage mode, and an authority that lives outside Git for something a file and a CI check already solve
- **Semver on the SDK as the compatibility story** -> a version number is a claim, not a check, and it is set by the person least likely to notice they broke something

**Consequences:**
- A deliberate breaking change costs real work: a new major published alongside the old, and the old kept until its consumers are measured gone rather than assumed gone
- Baselines must be refreshed on additive changes (`task contracts:baseline`); the sync test makes forgetting fail immediately instead of silently widening what the gate permits
- The meaning-change break — same field name, new semantics — passes every mechanical check and is caught only at review, which is why the review checklist exists alongside the gate
- Level 1 and 2 gates cost CI minutes; they are the cheapest place to find an upgrade that only works in one direction

### ADR-031: Go for the distributable `homelab` CLI, TypeScript/Bun for repository scripting (2026-09-25); refines ADR-005

**Context:**
- ADR-005 says "TypeScript for all scripting", and it is right about scripting: `scripts/` is TypeScript run by Bun with Biome and `bun test`
- The repository has since grown a Go binary, `cmd/homelab`, which is what `task verify` actually runs, with `internal/` packages for config, verification, prereq and scaffolding. The two coexist today without a written rule for which is which
- Open issue #52 specifies the single bootstrap command in Go (`cmd/homelab/bootstrap.go`) while the company stack is TypeScript/Bun, and the Platform PM flagged the contradiction as needing a decision before implementation
- The two artifacts have genuinely different distribution problems: repository scripts run inside a checkout that has already installed its toolchain, while the bootstrap CLI is the first thing a forker runs — often before any toolchain exists

**Decision:**
- The distributable `homelab` CLI stays Go: a single static binary, no runtime to install first, cross-compiled and released. Bootstrap (#52), verification and scaffolding belong to it
- Repository scripting stays TypeScript on Bun: anything run from a checkout by a developer or by CI, which is what ADR-005 covers and what `scripts/` already is
- The boundary rule is distribution, not preference: **if a stranger must run it before they have a toolchain, it is Go; otherwise it is TypeScript.** Business logic goes in `internal/`, so the CLI stays a thin command layer
- Shared platform logic is not duplicated across the two: it lives behind the contracts in `contracts/`, which both consume as data rather than as ported code
- This refines ADR-005 rather than replacing it; ADR-005 remains the rule for `scripts/`

**Alternatives Considered:**
- **Port the CLI to TypeScript/Bun for one language** -> honest about the stack, and it makes the first command a forker runs depend on installing Bun first, which is exactly the fork-ability friction ADR-029 is trying to remove. It would also discard working, tested Go in `internal/verify` and `internal/scaffold`
- **Move everything to Go** -> contradicts ADR-005 for no gain; `scripts/` runs in an environment that already has Bun, and Biome plus `bun test` are working well
- **Bun's single-file executable compilation** -> genuinely closes some of the distribution gap and is worth revisiting, but it is a newer path with a larger binary and less cross-compilation history than Go's. A reversible decision to leave for later

**Consequences:**
- Two languages, permanently, with a rule for which is which — the cost is contributor context-switching and two toolchains in `mise.toml`, both of which already exist today
- A forker downloads one binary and runs it; no runtime prerequisite before the bootstrap can even report what is missing
- Logic needed by both sides risks being written twice; the mitigation is that anything shared must be expressed as a contract under `contracts/` and consumed as data, and a second implementation of the same logic is a review failure
- #52 proceeds as specified in Go with no sequencing change

### ADR-032: No level-0 claim in PR descriptions; CI runs level 0 on the head (2026-09-24); supersedes the PR-body claim of ADR-014 item 22

**Context:**
- ADR-014 item 22 made every pull request carry a `<!-- verify-level0 -->` JSON block from `task verify:claim`, and `pr-contract.yml` failed when it disagreed with level 0 on the head
- The block runs to roughly 270 lines, one per check, and sits in every PR description: it buries the summary and has to be refreshed after every push that changes the result
- The workflow already re-ran level 0 on the head to compare against the claim, so the pasted block added no verification CI did not do itself

**Decision:**
- PR descriptions carry no verification block; `task verify:claim` and `scripts/verify-claim.ts` are removed
- `pr-contract.yml` job `claim` keeps its name, because "Verification claim matches level 0" is the required check on `main`, and now passes exactly when `task verify` passes on the PR head, with the failing checks in the job summary
- The PostToolUse hook and the rest of ADR-014 item 22 are unchanged

**Alternatives Considered:**
- Delete the workflow and require `verify.yml`'s level-0 job instead -> a branch-protection change, and `verify.yml` has a paths filter, so PRs outside it would never report the required check
- Keep the claim but collapse it into a `<details>` block -> still noise to write and refresh, and still verifies nothing CI does not
- Run the job on Renovate branches too -> makes level 0 a merge gate for bot bumps, a policy change outside this decision; `upgrade.yml` keeps gating them

**Consequences:**
- Shorter PR descriptions and one fewer step for agents and `ci-autofix.yml`
- The required check no longer records what the author saw, only what CI saw on the head; that was the part that mattered
- The check name now describes the old behaviour; renaming it needs a coordinated branch-protection update

### ADR-033: Fork-ability check 3 splits into an automated cold path (3a) and a never-executed hardware path (3b), triggered by cadence rather than a release anchor (2026-09-25); refines ADR-029

**Context:**
- ADR-029 named check 3 as a single check — "a clean clone, a filled-in ConfigSet, the documented bootstrap, on a machine with none of the maintainer's credentials" — with one owner and one trigger, "per release, and for any change to bootstrap, secrets or identity"
- "The documented bootstrap" has two readings in this repository, and they differ by a hardware budget: `task localdev:up` (Kind, Docker only) and `task setup -- --environment homelab` (a Proxmox VE host, a 1Password account with a `homelab` vault, a BGP-capable UniFi gateway). One check name covering both means neither half has a determinate pass state
- The DX & Docs Advocate attempted the check and reported it unrunnable as one unit. Measured on the hardware reading: `task validate -- --environment homelab` reaches 10 of 16 prerequisites with no hardware present and stops at the `proxmox` row
- "Per release" cannot be looked up: the repository has zero git tags and no release workflow, so the trigger has nothing to hang on and is honoured by nobody
- A named check that has never been executed is worse than an unnamed one, because the table's format invites a reader to assume a listed check has passed

**Decision:**
- Check 3 becomes two checks with separate owners, triggers and pass criteria:
  - **3a — the cold documented Kind path.** `task localdev:up` → `localdev:wait` → `localdev:report` → `localdev:down` on an ephemeral runner with no cache restored and none saved. Automated in `.github/workflows/fork-path-cold.yml`. An ephemeral runner is an honest proxy for 3a specifically, because the property under test is the absence of local state, not the presence of hardware
  - **3b — the production bootstrap on foreign hardware.** `task setup -- --environment homelab` with a filled-in ConfigSet, on a machine holding none of the maintainer's credentials. Not automatable, because its prerequisites are physical
- **3b is recorded as never executed, now, and independently of whether hardware is ever funded.** The candour is not contingent on the budget answer: "never executed" is a true statement today and costs nothing to write, whereas leaving the row implicitly green is a false statement that the table's own format manufactures. The hardware question is escalated separately, on its own merits
- The check table carries a **Status** column. A check may be listed as specified-and-not-implemented; it may not be listed with no status at all. This applies to checks 1 and 2 as much as to 3b
- **The release anchor is replaced by a cadence**, because a trigger a reader cannot look up is a trigger that gets missed: 3a runs weekly by cron and on demand; 3b runs before a declared platform milestone, and its written result is dated in `docs/contracts/fork-ability.md`
- **"For any change to bootstrap, secrets or identity" is enforced by a `paths:` trigger, not by a CODEOWNERS rule.** `.github/CODEOWNERS` assigns `*` to the single repository owner and gives every listed path that same single owner, so a CODEOWNERS entry cannot carry this obligation in this repository — it would be prose wearing a machine-readable costume. `fork-path-cold.yml`'s current `paths:` filter covers only the workflow file itself, so this part of check 3a is specified and not yet enforced
- Checks 1 and 2 remain unchanged in intent and unimplemented in fact. ADR-029's "belong in the existing level-0 gate" is a specification, not a description of `main`: `internal/verify/` has no fork-ability module, and there is no synthetic ConfigSet to render against
- Normative detail and per-check status: `docs/contracts/fork-ability.md`

**Alternatives Considered:**
- **Keep check 3 as one check, scoped to the Kind path only** -> makes the table green by quietly narrowing the claim; the fork path that actually loses ambassadors is the hardware one, so this hides the gap instead of naming it
- **Keep check 3 as one check and wait for hardware** -> leaves the automatable half unautomated for a budget reason that does not apply to it, and 3a is the half that catches documentation drift every week
- **Record 3b's status only after the founder answers the hardware question** -> makes an honest status report conditional on a spend decision. If the answer is "not now", the reader keeps the false table for longer, which is the opposite of what the delay was for
- **Delete 3b from the contract** -> the contract's entire subject is the stranger's machine; removing the only check that involves one guts it
- **Enforce the bootstrap/secrets/identity trigger through CODEOWNERS** -> unavailable here: one owner on every path, so the rule cannot discriminate

**Consequences:**
- The fork-ability table stops being a list of checks and becomes a list of checks with states. It is less flattering and more useful, and it will read as partly red for a while
- 3a's published number is a cold wall clock and will be substantially worse than `tilt-ci.yml`'s cached figure. That is the point — the cached figure was never the newcomer's experience — and the fork path must not be quoted from tilt-ci
- 3b stays unexecuted until hardware exists. The gap now lives in the repository rather than in one agent's head, and it is escalated as a budget question in its own right
- A weekly cron on a cold, uncached Kind loop is a standing CI cost. It is kept off the pull-request critical path deliberately
- Two checks means two owners and one more row in the owner table. Two owners who can each run their own check beats one owner who cannot run half of theirs
- 3a passing says nothing about 3b. Nobody may write "the fork path is green" without naming which half they mean

### ADR-034: The deployment DAG is generated per environment, from the rendered app-of-apps graph and an in-process Terragrunt parse (2026-09-25); binds open issue #53a

**Context:**
- The backlog verdict on #53a requires the deployment DAG to be *derived* from what the repository already declares — ArgoCD sync waves and Terragrunt `dependency` blocks — rather than hand-written, because a third hand-maintained ordering file goes stale the first time someone edits a sync wave. That condition was recorded before anyone read both ordering inputs end to end, and three of the criteria beneath it do not survive contact with the repository at `2f0ddf1`
- The criteria scope the sync-wave input to `charts/gitops`, `charts/addons` and `charts/applications`. `charts/bootstrap` is also an app-of-apps parent: `charts/gitops/values.yaml` declares an Application at `path: charts/bootstrap` with its own templated wave. `internal/verify/gitops.go` already records why that matters — ArgoCD orders waves only *within* one Application, so the parent wave dominates every child wave beneath it. Omitting a parent orders its children correctly among themselves and puts the whole subtree in the wrong place: a defect that looks fine in review and shows up on a cold cluster
- The parent waves are environment-specific. `charts/gitops/values.yaml` sets bootstrap 0, addons 2, applications 3; `charts/gitops/values-homelab.yaml` overrides addons to 1 and applications to 10. The order key is `{parent wave, wave}` (`internal/verify/gitops.go`), so one artifact cannot describe both environments — it would be wrong for one of them
- The waves cannot be read from the chart sources at all. Seven wave annotations under `charts/` are Helm-templated (`git grep -n sync-wave -- charts | grep '{{'` at `2f0ddf1`): three are exactly these parent waves, two are the `previews` waves, and two — `charts/addons/templates/_smoke.tpl` and `charts/applications/templates/_smoke.tpl` — take the wave from a *template argument*, `argocd.argoproj.io/sync-wave: {{ .wave | quote }}`, which no analysis of chart sources can resolve under any technique. The input is a render, not a file
- There are two deployable environments, not one: 11 Terragrunt units under `terragrunt/environments/homelab` and 2 under `terragrunt/environments/localdev`, and `cmd/homelab/commands/bootstrap.go` already has separate `deployLocaldev` (2 phases) and `deployHomelab` (4 phases) paths. localdev is the path a stranger runs first, so a homelab-only artifact makes #52's `--dry-run` wrong on exactly the surface the fork-ability contract cares about
- **Level 0 renders homelab from the example config, not from the operator's.** `resolveEnvConfig` "deliberately reads env.EnvFile (the PII-free example for homelab) and never configuration/environments/homelab.yaml" (`internal/verify/render.go`), and `internal/verify/types.go` pins `EnvFile: configuration/environments/homelab.yaml.example`. That example sets `GPU_VENDOR: "intel"`, and `GPU_VENDOR` decides *which Applications exist*: `scripts/toggle-test.ts` documents `none` -> no GPU operator Applications, `intel` -> `intel-gpu-device-plugin` present. So a committed homelab artifact is definitionally the DAG of the example config, and a byte-exact gate that regenerates from the same example passes on every fork by construction. A fork running `nvidia`, or the `none` default, would boot against an artifact naming nodes its cluster never deploys — the cold-cluster hang this ADR exists to prevent, reached by the one path the gate cannot see. This class hides well: the header comment in `toggle-test.ts` asserts the example sets `nvidia` while it sets `intel`, and that stale comment has survived in-tree
- The GitOps half of the graph largely exists — `internal/verify/gitops.go` renders the app-of-apps graph, reads the wave annotations, carries the order key, and runs inside `task verify` as `verify:gitops`. The Terragrunt half does not exist at all: nothing in `internal/` or `cmd/` parses a `dependency` block and `go.mod` has no HCL dependency. #53a therefore carries a choice that decides the artifact's provenance and its failure mode when a unit is added
- Ordering is declared by `dependencies { paths = [...] }` as well as by `dependency` blocks, and ordering-only edges have **two spellings** in the tree today: `terragrunt/environments/homelab/talos-cluster/terragrunt.hcl` uses `dependencies { paths }` to reach `../truenas`, and `terragrunt/environments/homelab/gitops-bootstrap/terragrunt.hcl` expresses the same ordering-only edge to `../truenas` as a `dependency` block with `mock_outputs = {}` and a comment saying no outputs are read. Both are edges; a reader that looks only at `dependency` blocks drops the first silently
- Every unit inherits two `include` blocks (`root` and `env`, both via `find_in_parent_folders`). Neither `terragrunt/terragrunt.hcl` nor `terragrunt/environments/_env/env.hcl` declares a dependency today, so a per-unit-file parse is correct *now* and silently wrong the day one of them does
- A unit with no edges is legal. `terragrunt/environments/homelab/unifi-gateway` declares no dependencies and nothing references it; `terragrunt/README.md` documents it as independent — FRR BGP peer config and syslog/NetFlow exports on the gateway. "Orphan" therefore cannot mean "a unit with no edges", or the homelab artifact fails on its first generation
- The code the generator will sit beside already holds two hard-coded notions of the parent set: `internal/verify/charts.go` `ParentCharts` and a literal `[]string{"bootstrap", "addons", "applications"}` loop in `internal/verify/gitops.go`. `parentWave` is read as a plain map lookup (`g.parentWave[app.Chart]`), so an undeclared parent resolves to wave 0 with no error — the same silent-omission mode that put `charts/bootstrap` outside the criteria

**Decision:**
- **GitOps input is every chart the environment renders, discovered from the render — no hard-coded chart list.** A chart is in scope when an Application in the rendered graph claims `spec.source.path: charts/<name>`; its parent wave is that Application's wave. A hard-coded list is itself a second place to edit, which is the class of defect this ADR exists to prevent, and it is why `charts/bootstrap` was missed in the first place
- **Discovery has an explicit, fenced scope.** `ApplicationSet` templates are out of scope: `charts/gitops/templates/previews-applicationset.yaml` carries `template.spec.source.path: charts/applications`, a generated per-pull-request Application that is off the cold-boot path and whose chart is already claimed by a real Application. A path under `charts/` that is deeper than `charts/<name>` (for example a kustomize tree such as `charts/secrets/onepassword`) is a **hard failure naming the Application**, not a skipped node — reusing `chartNameFromPath`'s depth-2 rule as a silent filter would reintroduce the omission mode. An Application whose parent chart has no discovered wave is a hard failure too; the generator may not read a parent wave through a defaulting map lookup
- **The generator owns discovery outright and does not consume `ParentCharts` or the literal parent loop.** Because both stay in `verify:gitops` for now, a contract test asserts that the generator's discovered parent set equals those two lists for both environments, so the two notions of the graph cannot diverge silently. Unifying them is follow-up work, not a precondition
- **One artifact per deployable environment**: `configuration/deployment-dag.<env>.yaml`, generated for `localdev` and `homelab`. `homelab-preview` is excluded — it is a render-only verification environment with no Terragrunt units and no bootstrap path. The generator fails when the set of artifacts and the set of environments holding Terragrunt units disagree in either direction, so adding an environment cannot silently skip its artifact
- **The committed artifact is the gate's frozen reference; #52 orders from the operator's own resolved config.** The generator is a library (`internal/dag`) called by both the level-0 gate and bootstrap. At bootstrap time #52 regenerates the DAG in process from the operator's resolved config and orders against *that*; the committed file is what the byte-exact gate compares against, and the input to `--dry-run` when no operator config is present. Each artifact records `provenance: { configSet, envFile }` so a reader can see which config produced it, plus `configDigest`, a digest over the full resolved config. #52 hard-fails, naming the digest mismatch, if it ever has to fall back to a committed artifact whose `configDigest` does not match the operator's resolved config — on a fork that is the correct refusal, because the example's graph is not the fork's graph
- **The Terragrunt half is parsed in-process with `hashicorp/hcl/v2`, not by shelling out to `terragrunt`.** The parser reads both `dependency` blocks (`config_path`) and `dependencies { paths }`, resolves each path relative to the declaring unit, and requires literal strings
- **The literal-only fence sits at the parse level, not the value level** — a fenced subset that yields no edge and no error is not fenced. Four hard failures, each naming the file: (1) `paths` that is not a literal tuple (`paths = local.deps`, `concat(...)`) fails before entries are inspected, rather than iterating zero entries; (2) a `paths` entry or `config_path` value that is not a literal string — `find_in_parent_folders()` included — fails; (3) a `dependency` block without exactly one `config_path` attribute fails, so an absent or misspelled attribute cannot present nothing to check; (4) an *included* file (`terragrunt/terragrunt.hcl`, `terragrunt/environments/_env/env.hcl`, or any other `include` target) that declares `dependency` or `dependencies` fails, because the per-unit parse does not follow `include` and must not pretend the inherited block is absent
- **Cycle detection is a generation-time hard failure. "Orphan" is defined narrowly and is not a unit-level check.** An orphan is a chart or Application in the render with no ordering position; a Terragrunt unit with no edges is legal and is recorded as an isolated node (`unifi-gateway` is one today)
- The artifact carries `version: 1`, is validated against `configuration/schema/deployment-dag.schema.yaml`, and is serialized deterministically (sorted keys, stable edge order) so the drift gate can be byte-exact
- **The drift gate is level 0 of `task verify`**, for every environment: regenerate in memory and fail when the committed artifact differs. It reuses the shape of the existing `committedValuesCheck` — `labelledDiff` output plus the named regenerate task in the failure detail — rather than reporting that files differ
- The artifact stays a repository file read from the checkout, not embedded in the binary. Bootstrap already runs from a checkout, and reading the same file the gate checks keeps "edit a sync wave, regenerate, commit" the only loop
- It lives under `configuration/`, not `contracts/`. `contracts/` is the normative surface this repository and the commercial control plane both build against; this artifact describes *this* repository's declared order and has one consumer. Promoting the format to `contracts/` when a second consumer appears is additive, and is the reversible path out. `version: 1` under `configuration/` is a declared hint for that future promotion, **not** an enforced compatibility gate: `task contracts:check` does not cover `configuration/`, and nobody may read the field as if it did
- **terragrunt stays the authority on meaning, through a test rather than a runtime dependency.** A cross-check test compares the parsed edge set against the DOT output of the pinned terragrunt in `mise.toml` and skips when the binary is absent. That keeps a second opinion on the semantics without putting an external binary in the level-0 gate path

**Alternatives Considered:**
- **Shell out to `terragrunt graph-dependencies` (now `terragrunt dag graph`) and parse the DOT** -> terragrunt is the authority on its own semantics, which is the real argument for it and the reason the cross-check test exists. Against it: it puts a pinned external binary in the path of a level-0 gate that needs none today; the command was renamed in terragrunt's 1.0 CLI redesign, so the shell-out surface is version-coupled where the HCL block syntax is not; DOT is an unversioned text format we would have to parse anyway; and when it fails it fails as an opaque terragrunt error in the middle of a verification run
- **A hand-written `configuration/deployment-dag.yaml`** -> already rejected as a third source of truth. Restated here because "generated" is the property every other clause in this ADR protects
- **One artifact with a section per environment** -> tidier on disk, and it makes a change to one environment fail the other environment's gate. Separate files keep a regeneration's blast radius at one environment
- **`go:embed` the artifact into the CLI** -> removes a file read, and makes a forker who edits a sync wave rebuild the binary before bootstrap agrees with the repository. The gate already guarantees the file matches the repository
- **#52 reads the committed artifact and validates it with a digest over only the config keys that gate Application membership** -> cheaper than regenerating, and rejected twice over: enumerating those keys is a second place to edit, exactly the defect this ADR removes elsewhere; and the digest would have to be maintained against every future membership toggle. A digest over the whole resolved config is the honest version, and it can only gate the fallback — as the primary path it would refuse to boot on every fork, because a fork's config differs by construction

**Consequences:**
- A new Go dependency, `hashicorp/hcl/v2`, and a bounded subset of terragrunt's config semantics re-implemented here — literal `config_path` and `paths` only, fenced at parse level by four hard failures and cross-checked against terragrunt in a test
- A `config_path` that becomes a computed expression stops the build instead of silently losing an edge. So does an inherited `dependency` block, a non-tuple `paths`, and a deeper `charts/` source path. That is the intended trade: a lost edge is a cold-cluster hang at 3am, a hard failure is a five-minute fix
- Two artifacts to regenerate, and level 0 fails on a pull request that edits a sync wave or a Terragrunt unit without regenerating. The cost is measured and small: at `2f0ddf1`, `git log --since="6 months ago" -G'sync-wave' -- charts` is 14 commits out of 149 in that window, and `git log -G'config_path' -- terragrunt` is 10 commits in the repository's whole history — far too rare to drive anyone around the gate. (The first figure is window-relative; re-measure with the command rather than quoting the number.)
- **Bootstrap renders and regenerates rather than trusting a committed file.** That adds a render to #52's path and makes `internal/dag` shared code between the gate and the CLI — one set of bones, not two. It adds no prerequisite: `helm` is already a prereq check at tier `Localdev` in `internal/prereq/prereq.go`, and a check at tier *t* is required by every tier at or above it, so the homelab bootstrap path already requires helm
- #52 dry-runs localdev — the surface a stranger reaches first — and orders a fork's real cluster from the fork's own config, not from `homelab.yaml.example`
- The `dependencies { paths }` edge (`talos-cluster` -> `truenas`) survives the move to a generated DAG, along with every other ordering-only edge, in both of its spellings. Nobody may "simplify" the `mock_outputs = {}` spelling into the other one on the assumption that only one is understood
- Blast radius when the generator is wrong: the DAG is wrong for one environment, bootstrap orders that environment wrong, and the failure surfaces on a cold cluster rather than in review. The byte-exact level-0 gate, cycle detection, the four parse-level hard failures, the provenance digest and the terragrunt cross-check are what stand in front of that
- Delivery guarantee of the ordering itself is unchanged and worth stating: the DAG constrains *order*, not retry semantics. ArgoCD reconciles at-least-once within a wave, and bootstrap's phase waits are the only barrier between waves
- This is a cross-boundary design by its own author, so it was not self-approved. The second review (board MCAA-81, by the Senior Application Engineer) returned **approve-with-conditions** at head `beeeafe8`; its conditions C1 (config provenance), C2 (the parse-level fence), C3 (the orphan definition) and C4 (discovery scope and the two hard-coded lists) are folded into the clauses above, along with two corrections to the figures. Everything in this ADR that the review touched is amended here rather than left to the implementer to rediscover

> **Numbering note (2026-09-25).** `ADR-036` is allocated to
> [#372](https://github.com/ryanmcafee/homelab/pull/372) (the triage-agent alert→fix→Pushover
> DAG), a pull request that is open and unmerged at the time this one lands. The gap is an
> allocation, not a lost decision. It is recorded as a blockquote rather than a reserved
> `### ADR-0xx` stub on purpose: a stub is a heading, and a heading is what produces a duplicate
> ADR number when the real one merges — which is exactly the hazard this file hit when #365
> landed `033`.

### ADR-035: Cluster topology and the etcd quorum rule are a data contract, not ported code (2026-09-25); applies ADR-031 to #39

**Context:**
- Issue #39 adds an etcd quorum guard to the control-plane recreate path. The guard decides whether it is safe to destroy a control-plane node, so it is the highest-blast-radius predicate in the repository: wrong in the permissive direction, it consents to the destruction of a quorum
- The tested implementation is TypeScript: `scripts/cp-storage-migrate.ts` exports `parseEtcdStatus` (L433), `EtcdHealth`/`etcdHealth` (L465/L476), `EXPECTED_MEMBERS = 3` (L134) and `DEFAULT_RAFT_TOLERANCE = 10` (L132), with unit tests in `cp-storage-migrate_test.ts`
- The recreate command is Go — `homelab talos recreate` in `cmd/homelab/commands/talos.go` — and ADR-031 puts the distributable CLI there. Today that command contains no etcd logic at all: `grep -rl etcd --include='*.go'` returns nothing. The quorum guard is new work in whichever language it lands in, not an extension of existing Go
- ADR-031's boundary rule is distribution, not preference. `cp-storage-migrate.ts` is run from a checkout by an operator who already has Bun, so it stays TypeScript. It is not slated to move, and nothing should imply it is
- Both sides therefore need the same rule permanently. This is exactly the case ADR-031 anticipated and called a review failure: "a second implementation of the same logic is a review failure"
- `EXPECTED_MEMBERS = 3` is not a tuning constant, it is a topology assumption. `configuration/environments/homelab.yaml.example` encodes the same assumption in the *shape* of its keys — `CP1_IP`, `CP2_IP`, `CP3_IP` — with no key anywhere expressing the control-plane count. A fork running one or five control-plane nodes cannot state that fact, and the guard would refuse to proceed on a healthy cluster

**Decision:**
- The **rule** is a contract, the **procedure** is code. `contracts/cluster/topology.v1.yaml` holds the control-plane member count, the RAFT INDEX tolerance and the named health predicate; Go and TypeScript consume it as data at build or run time. Neither language owns the numbers
- The control-plane count is **derived** from the ConfigSet's control-plane address keys — the set matching `^CP([0-9]+)_IP$` — and there is no separate count key. The contract supplies the resolver rule, the permitted range and the quorum formula. A repository constant that fixes the count is a fork-ability defect (ADR-029), not a default
- A required `CONTROL_PLANE_COUNT` key was the first answer and is **rejected**: the ConfigSet already states the control plane by enumerating its addresses, and a second key stating the same fact can disagree with the first. An operator who adds a node and forgets the count gets a guard that refuses to proceed on a healthy cluster — the exact failure this ADR exists to prevent, reintroduced by the fix. One fact, one source; that is the same principle that puts the quorum rule in a contract rather than in two languages
- **This makes the address list load-bearing, so it has to become a real list.** Today it is not one: `configuration/schema/network.schema.yaml` declares `CP1_IP`, `CP2_IP` and `CP3_IP` as three individually `required: true` scalars, and `scripts/cp-storage-migrate.ts` (L110-112) binds them to a fixed three-row node table. A fork cannot add `CP4_IP` — nothing admits or reads it — and cannot omit `CP2_IP`/`CP3_IP`, because both are required. Deriving a count from that resolves to `3` for every fork on earth, which is `EXPECTED_MEMBERS = 3` with extra steps and the fork-ability defect intact but now invisible. So the schema must admit `^CP[0-9]+_IP$` as a pattern with `CP1_IP` required and the rest optional. That is a **merge condition on #39**, not a follow-up: shipping the derivation without it is strictly worse than the hard-coded constant, because it looks parameterised and is not
- **`countSourceSchemaReady` is the gate on that merge condition, and it is enforced rather than documented.** The flag was originally a note to the reader, which meant a consumer could append a `^CP([0-9]+)_IP$` derivation while the flag was still `false` and leave the suite fully green — a condition stated in a file nobody reads is not a merge condition. `scripts/topology-contract_test.ts` now walks every `consumers[].path` and fails if any of them references `countKeyPattern` or a `CP[0-9]+_IP`-shaped regex while the flag is `false`, alongside the existing check that no consumer restates a contract value as a literal. The flag flips to `true` in the same commit that lands the `network.schema.yaml` pattern, and that commit is what releases the consumers to implement the derivation
- #39 proceeds in Go as the Platform PM's default proposed. The port is approved **on the condition** that it ports the procedure and consumes the contract — a Go file that restates `EXPECTED_MEMBERS = 3` and re-implements `etcdHealth` is rejected at review under ADR-031
- `parseEtcdStatus` is explicitly **not** shared. It is an adapter to one release of `talosctl`'s human-readable table, it belongs to whichever binary shells out to `talosctl`, and it is the one part where two implementations are acceptable because each is a private detail
- The check for machine-readable output resolved **no**, so the second parser is avoided a different way: **the Go consumer does not shell out at all.** It calls the Talos API directly through `pkg/machinery/client`'s `EtcdStatus`, which returns the member status as typed fields. `talosctl etcd status` has no machine-readable mode on either pinned version — the cluster runs Talos `v1.12.2` (`terragrunt/environments/homelab/env.hcl:50`) and the client tool is pinned one minor ahead at `talosctl 1.13.8` (`mise.toml:22`), and the Senior Platform Engineer confirmed empirically on 1.13.8 that `etcd status` registers no flag but `--help`, while `talosctl get` does carry `-o`; `cmd/talosctl/cmd/talos/etcd.go` **at tag `v1.13.8`** writes a `tabwriter` table with no output-format flag registered. Cite 1.13.8 for that file, not `v1.12.2`: `mise.toml` is what puts `talosctl` on an operator's `PATH` here, so 1.13.8 is the CLI whose source settles the question, and the empirical check was run against it. (The finding is the same at `v1.12.2`; the citation was the part that was wrong.) `talosctl get -o json` is not a substitute either, because `MemberSpec` carries only `MemberID`: four of the five health conditions (`LEADER`, `RAFT INDEX`, `RAFT TERM`, `LEARNER`, `ERRORS`) exist only in the `EtcdStatus` gRPC response and in no COSI resource
- Taking `github.com/siderolabs/talos/pkg/machinery` as a dependency of the distributable CLI is **approved** and is not new lock-in under ADR-031. Talos is already the operating system; `pkg/machinery` is the client module Sidero publishes for external consumers of exactly this API. Shelling out is the *harder* dependency of the two — an unpinned binary that must already be on the operator's `PATH`, whose interface is an unversioned human-readable table. A pinned, semver'd Go module with typed fields is the duller mechanism. It **deletes one failure class and introduces another**, which is a trade rather than a strict win, and the ADR says so rather than claiming the win:
  - **Deleted.** The existing table parser requires a `NODE` column that Talos emits only when `Metadata.Hostname` is non-empty, so on a hostname-less cluster it returns `[]` and the operator is told "0 member(s) answered" instead of the real reason. Fail-closed, but for a fabricated cause
  - **Introduced.** `pkg/machinery` reaches etcd *through Talos `apid`*, not directly. A healthy etcd behind a wedged, unreachable or mTLS-rejecting `apid` reads as "did not answer", so the same misattribution reappears one layer up. The trade is still worth taking — the transport error is typed and reportable, where a missing table column is silent — but it is only worth taking if the consumer reports it. `contracts/cluster/topology.v1.yaml` therefore states `evaluation.transportFailureIsNotMemberFailure: true`: a dial, deadline or auth failure is reported as the transport error it was, never flattened into a member count
  - **Two Talos pins exist and they disagree.** The cluster runs `v1.12.2` (`terragrunt/environments/homelab/env.hcl:50`); the `talosctl` on an operator's `PATH` is `1.13.8` (`mise.toml:22`). **`pkg/machinery` follows `env.hcl`**, because the gRPC call talks to the cluster's API version and that is the compatibility that can actually break at runtime; `mise.toml` pins a human's CLI and is free to run ahead. Conditions: pin `pkg/machinery` to the `env.hcl` version, track it with the cluster's existing Renovate entry so the two move together, and keep the call behind an interface in `internal/etcd/` so the conformance test runs against fixtures rather than a live cluster
- The predicate is fail-closed: unparseable output, a member that does not answer, or a control-plane address set that resolves to no members all mean "not safe to proceed". Silence is never consent for a destructive path
- **The member set is etcd's own membership; the derived count is only the expectation compared against it.** This is stated in the contract (`health.memberSetSource`) because it is the difference between a check and a tautology. "The number of members that answered equals the derived count" has two readings: members as etcd reports them, or the addresses the consumer chose to dial. On the second reading the condition validates its own input and can never fail. Worked failure on that reading: a real five-member control plane whose `CP4_IP`/`CP5_IP` are absent from the ConfigSet and whose nodes are already down. The guard derives 3, dials 3, finds 3 healthy, computes quorum 2, and consents. Destroying one leaves 2 of a real quorum of 3 — **quorum lost, and the guard said yes.** So the member set comes from `EtcdStatus`/`MemberList` from at least one reachable endpoint, the derived count is compared against it, and it is never the enumeration used to build it. No reachable endpoint means the membership is *unknown*, which is indeterminate and therefore unsafe — not "zero members"
- **The observation is bounded in time, and the consumer sets a context deadline.** `revalidateBeforeDestructiveStep: true` is meaningless without a window: a reading gathered over four minutes is not "immediately before" anything, and a consumer with no deadline blocks on a wedged endpoint and then acts on an observation older than the fault it exists to catch. The contract pins both halves — `evaluation.maxObservationAgeSeconds` (how old an answer may be when it is acted on, 30s) and `evaluation.observationDeadlineSeconds` (how long the consumer may wait for one, 10s, across every dial and retry). Exceeding either is a failure to observe: indeterminate, therefore unsafe
- **There are two named predicates, not one, and each evaluation point names the one it uses.** The first revision of this contract stated a single whole-cluster predicate (`member-count` requires that the members answering equal the derived count) together with `revalidateBeforeDestructiveStep: true`. Those two are contradictory on the procedure they govern, and the contradiction was found by the implementing engineer before a line of the guard was written. Between "member removed" and "node rejoined" the cluster is deliberately at `count - 1`, so the whole predicate is unsatisfiable *by construction* at exactly the moment revalidation is required — a fail-closed guard would abort mid-procedure and leave the degraded control plane #39 exists to prevent. The same is true of the idempotent re-run: after a crash the target is already gone, the whole predicate cannot tell "resume, I removed it" from "refuse, this cluster is degraded", and the operator's only route forward is to bypass the guard. A safety check that must be bypassed to complete a legitimate recovery is not a safety check. So the contract states:
  - `whole` — every expected member present and converged. The gate at `preflight` and at `completion`. Unchanged in meaning from the first revision
  - `survivable` — quorum holds, at most `maxUnavailable` members are absent, every absence is a **declared target** of the operation in progress, and every member that answered satisfies `no-errors` / `no-learners` / `single-leader` / `raft-index-converged`. The gate at `before-destructive-step` and at `resume`
- `survivable` is weaker than `whole` in exactly one way — it forgives the declared target's absence — and no weaker in any other. An absent member that is not a declared target, or more absences than `maxUnavailable`, is still unsafe. `contracts/cluster/topology.v1.yaml` states that relation and `scripts/topology-contract_test.ts` asserts it, so the gate at the most dangerous moment of the procedure cannot quietly become laxer than the gate at the door
- **`quorum` and `maxUnavailable` are consumed by a stated condition (`quorum-present`), not merely published.** In the first revision they were defined with a worked table that no condition read: data that looks like a rule and enforces nothing. The contract's own test now fails if any condition is defined that no predicate evaluates, or any predicate names a condition that does not exist
- A control plane of `count: 1` has `maxUnavailable: 0`, so no removal is ever survivable on it. The guard refuses and names the procedure that does apply — recreating a single-member control plane is a snapshot restore, not a member removal — rather than reporting bare quorum arithmetic the operator will try to argue with
- Each consumer carries a conformance test that asserts its behaviour against the contract's own fixtures, so the two implementations cannot drift apart without a red test — the same shape as the event gate in ADR-030. A consumer that implements `whole` alone is not conformant, however careful that predicate is

**Alternatives Considered:**
- **Port it and accept two copies** -> one day of work now and a permanent fork of the rule that decides whether a control plane survives; the copies drift at the first tolerance change and the drift is silent, because each side's tests pass against its own constants
- **Keep the recreate path in TypeScript** -> no duplication, and it puts a destructive cluster operation behind a toolchain the operator may not have at the moment they need it, against ADR-031's grain for no gain the contract does not already deliver
- **Share via a generated Go package emitted from the TypeScript** -> a real option that keeps one source of truth, and it makes the Go binary's build depend on Bun and makes the TypeScript the owner of a rule the Go side is accountable for. A data file both sides read is duller and has no build-order coupling
- **Leave `EXPECTED_MEMBERS` hard-coded and fix topology later** -> retrofitting the count after two consumers exist means changing both; and it ships a guard that is wrong for any fork that is not shaped like this cluster
- **A required `CONTROL_PLANE_COUNT` key, plus a check that it agrees with the address count** -> this works and was seriously considered. It keeps one source of truth at the cost of a consistency check that exists only to police a duplication we chose to create. Deriving needs no such check, because there is nothing to disagree with. Rejected on **boring is a feature**: the check is a moving part whose only job is to detect a problem the other option does not have
- **Shell out to `talosctl` from Go and port the table parser** -> the originally scoped work. Rejected because the parser is an adapter to an unversioned human-readable table and the one we already have is subtly wrong in a way that misreports the cause; shipping a second copy of that in a second language is the duplication this ADR exists to prevent, wearing the label "private detail"
- **One `whole` predicate plus a `--force` or `--resume` flag for the states where it cannot hold** -> the obvious fix, and the one to refuse hardest. It moves the decision "is this absence the one I asked for" out of the checked, tested predicate and into an operator typing a flag at 3am on a degraded control plane, which is precisely when the judgement is worst and the cost of being wrong is highest. `survivable` makes that same decision from the member list, and the contract's test asserts it is bounded to the declared target
- **One `whole` predicate, evaluated only at preflight and completion, with no gate at the removal** -> honest about the contradiction and it deletes the guard at the only moment it would have paid for itself: the window between preflight and the destructive step is exactly where an unrelated member can fail, and a point-in-time check taken minutes earlier is the check this ADR already rejected
- **Relax `member-count` to `>= quorum` for all predicates** -> one predicate, no contradiction, and it silently accepts starting a node replacement on a cluster that was already a member short — the failure the whole gate exists to catch. The relaxation must be bounded to the declared target or it is not a relaxation, it is a hole

**Consequences:**
- #39 costs more than the one day the port was scoped at: the contract, the schema change to the `CPn_IP` key set, the `pkg/machinery` integration, and two conformance tests. The premium buys one definition of the rule instead of two, and it is paid once
- There is no `CONTROL_PLANE_COUNT` key. A fork states its topology by listing exactly the control-plane addresses it has, which is the same act that already gets it a working cluster — one fact, stated once, in the place a forker was already going to look
- The `CPn_IP` schema change is a merge condition on #39 and it touches the bootstrap path, so it needs the Senior Platform Engineer. Until it lands, the derivation is correct in form and wrong in effect, which is the one state worse than not having done it
- A change to the tolerance or the predicate is a contract change and gets the ADR-030 treatment — baseline, diff, rule set — rather than an edit to a constant in one language. **With one honest caveat: that treatment does not exist for this file yet.** `scripts/contract-check.ts` hard-codes `CONTRACTS_DIR = "contracts/events"` (L485), so the frozen baseline and the breaking-change rule set cover `events/` only; `topology-contract_test.ts` checks internal consistency, which is a weaker property — a contract can be self-consistent and still have silently dropped a field a consumer reads. Until `CONTRACTS_DIR` is extended, `cluster/topology.v1.yaml` is gated by review rather than by CI, and `contracts/README.md` records that plainly along with the rule it implies: after the first shipped consumer, a rename or removal takes `topology.v2.yaml`. Extending the baseline mechanism to every subdirectory under `contracts/` is the durable fix and is tracked as such
- Exactly one `talosctl` table parser exists, the TypeScript one, and it is now the only thing depending on the table format. The Go side depends on the gRPC contract instead. If the table format changes, one consumer breaks; if the API changes, the pin and Renovate surface it at upgrade time rather than at 3am on a destructive path
- The Go CLI now links the Talos client library. A forker on a Talos version far from the pin may need a matching build; that is the cost of typed access, and it is visible in `go.mod` rather than latent in a parser
- A consumer has four gates to implement, not one, and the contract says which predicate belongs at each. That is more work than a single `isHealthy()` and it is the difference between a guard that completes a recovery and one an operator has to switch off to finish
- The procedure must **declare its target** before the destructive step, because `absences-are-declared` is unevaluable otherwise. That is a small API obligation on the caller — the guard takes the outgoing member as an argument, it does not infer it — and it is what makes the resume case decidable rather than merely degraded-looking
- Adding `survivable` is additive inside `version: 1` and needs no version bump: no consumer has shipped against this contract (it is unmerged), the meaning of `whole` is unchanged, and the change is a *stricter* specification of gates that previously had none rather than a relaxation of any gate that existed. Had a consumer shipped, this would have been a v2: a gate moving from unsatisfiable to satisfiable changes observable behaviour, and **backward compatibility by default** means assuming a consumer you cannot redeploy
- The moment a third consumer needs the rule, it reads the same file. That is the test of whether this was worth doing

**Implementation note — the `CPn_IP` merge condition is satisfied (2026-09-25, MCAA-118):**
- The Decision bullet above describes the schema as it stood when this ADR was written ("three individually `required: true` scalars… a fork cannot add `CP4_IP`"). That is no longer the state, and the Consequences bullet beginning "The `CPn_IP` schema change is a merge condition on #39" is discharged. Both are left as written, because they record why the condition existed
- `configuration/schema/network.schema.yaml` declares the address set as a `keyPatterns` entry — a key-**name** pattern rather than a literal key — carrying `role: control-plane-address`. `CP1_IP` stays an individually required literal (`Taskfile.yml` bootstraps from it by name) and higher ordinals are optional. `contracts/cluster/topology.v1.yaml` `countSourceSchemaReady` is now `true`
- The pattern string is stated **twice and no more**: in the contract as `countKeyPattern`, and in the schema as the `keyPatterns` map key. `TestControlPlaneKeyPatternMatchesContract` asserts the two are character-identical, so the copy cannot drift from the thing it copies
- The derivation happens **once**, in the resolver, into `ResolvedConfig.ControlPlane` — an ordinal-ascending list. Templates range over that field and #39's guard reads it; neither re-applies the pattern. Giving templates a way to filter `.Values` by key pattern was the alternative, and it was rejected because it restates the rule once per template, and template text is the one place no test can see it
- Load-time rules on the new construct, each with a test: a pattern must be anchored (unanchored, `CP[0-9]+_IP` also matches `OLD_CP1_IP_BACKUP`); a literal key wins over a pattern match; a name matching two patterns is an error rather than last-one-wins, so resolver output never depends on map order; and a pattern may not be `required`, `const` or `default`, none of which mean anything without a key name
- `configuration/environments/single-node.yaml.example` is committed, and it is the part that was missing rather than merely unwritten. Before it, every environment file in the repository declared three control-plane addresses, so **no test had ever rendered a topology that was not this cluster's** — without it the schema's fixed shape would simply have moved into the test matrix. `TestSyntheticTopologiesRenderEveryTemplate` covers counts 3, 5 and 7 alongside it
- **Blank is not zero (2026-09-25 ruling, MCAA-118).** Omitting a higher ordinal means a smaller control plane; declaring `CPn_IP` and leaving it blank is indeterminate and refuses the whole set, per `evaluation.onIndeterminate: unsafe`. The two are not interchangeable because this value gates a destructive operation (#39): "I am shrinking to two" and "I have not filled this in yet" are both honest readings of a blank, and the resolver may not pick one silently
- One scope note for the ADR-037 owner: `examplePlaceholderSubnets` in `internal/config/guard.go` gained RFC 5737 TEST-NET-1 (`192.0.2.0/24`), because the one-node fixture must not reuse `homelab.yaml.example`'s RFC 1918 range. Only TEST-NET-1 was added; TEST-NET-2/3 stay out so the existing "public address is not a placeholder" case on `203.0.113.10` keeps its meaning

### ADR-037: The fork-ability gate's scope is what it can actually scan; Go source is outside it (2026-09-25); refines ADR-029
**Context:**
- ADR-029 states the rule repository-wide — `docs/contracts/fork-ability.md` says "No file in this repository may contain … a specific domain name or hostname … a cluster name, node name or hardware serial" — and then enforces it with checks whose real scope is narrower than "no file"
- The enforcement is `homelab config guard`. Its scope is two lists in `internal/config/guard.go`: `DefaultGuardPathspecs` (L355) covers `configuration/**`, `charts/**/values-homelab.yaml`, `scripts/**`, `docs/**`, `.github/**`, `Taskfile.yml`, `ansible/**`; and `guardScanExtensions` (L370) admits `.yaml .yml .json .md .ts .svg`
- `cmd/**` and `internal/**` are in neither list, and `.go` is not a scannable extension. The Go half of the repository — the half ADR-031 just made the home of everything a stranger runs first — cannot be scanned by the rule that exists to protect strangers
- This is not hypothetical and the precedent is written in the file. `guardScanExtensions` admits `.ts` with the comment: "a TypeScript script that hardcodes a real address or hostname as a flag default is a leak the same as one pasted into `configuration/`, and three of them did exactly that before the scope was widened." The identical construct in Go is unguarded: `cmd/homelab/commands/talos.go:61` defaults a node name in `cmd.Flags().StringVar(&node, "node", "worker-1", …)`
- ADR-035 moves the etcd quorum rule from `scripts/` (scanned) into `cmd/`+`internal/` (unscanned). Executed without this ADR, #39 moves a topology assumption out of the gate's coverage as a side effect of a language decision
- Checks 1–3 all verify that *values* are parameterised. None verifies that the *shape* is: `homelab.yaml.example` names `CP1_IP`, `CP2_IP`, `CP3_IP` and nothing states a count, so a fork with a different topology fails with every value correctly externalised. Check 3 catches this only if the clean-machine run happens not to copy this cluster's shape, which is luck rather than a check

**Decision:**
- The gate's scope follows the rule, not the other way round. `DefaultGuardPathspecs` gains `cmd/**`, `internal/**` and `terragrunt/**`; `guardScanExtensions` gains `.go`. Owner: SRE & Observability Engineer, as for checks 1–2
- **The `config-guard` hook in `.pre-commit-config.yaml` is widened in the same commit, both fields.** The scan scope is expressed twice and `internal/config/guard.go:316-318` says so at the list itself — "It mirrors the pre-commit hook's `files:` pattern so the hook and CI agree on what is guarded; change the two together or they drift." Today the hook's `types_or` is `[yaml, json, markdown, ts, svg]` with no `go`, and its `files:` regex is `^(configuration/|charts/.*/values-homelab\.yaml$|scripts/|docs/|\.github/|Taskfile\.yml$|ansible/)` with no `cmd/`, `internal/` or `terragrunt/`. So this ADR must name the hook or it *produces* the exact drift the code it edits warns about: `types_or` gains `go` and `files:` gains the three directories, in the same commit as the Go-side change. Neither half is optional — widening `DefaultGuardPathspecs` alone gives a gate that passes locally and fails in CI, and widening only the hook gives the reverse, which is worse because it teaches contributors the hook is noise. The three-way pairing (`DefaultGuardPathspecs`, `guardScanExtensions`, the hook's two fields) is now also written into `docs/contracts/fork-ability.md` as a standing condition, so the next person to add a language meets it where they are working
- Fork-ability gains **check 4 — bootstrap key resolution**: the bootstrap resolves every operator-specific value from the ConfigSet and exits non-zero naming the missing key. This is a runtime check in the Go CLI, distinct from checks 1–2, which look at rendered chart output and at example-file completeness and cannot see the bootstrap's own key requirements. Owner: **Senior Platform Engineer**. The mechanism exists — `internal/config/eval.go:25` already collects `required key %q is missing or empty` for every missing key — so this is wiring bootstrap to the existing resolver, not a new failure mode
- Check 2 is widened from "every key the render requires" to "every key the render **or the bootstrap** requires". The bootstrap must expose its required-key set as data for the check to consume; a second hand-maintained list in the checker would fork the key list, which is the defect this whole ADR is about
- Check 3 gains a written condition: the clean-machine run must not reproduce this cluster's topology. A fork run that fills in three control-plane IPs proves nothing about a fork that has one. Owner: DX & Docs Advocate, unchanged
- The synthetic ConfigSet used by check 1 must use RFC 5737 values distinct from those in `homelab.yaml.example`, which carries plausible RFC 1918 addresses (`192.168.1.x`). If the two overlap, check 1 cannot distinguish a leaked real value from a placeholder
- Ownership of the four checks is one owner per check, and it is the table in `docs/contracts/fork-ability.md`. Where an issue body assigns "the fork-ability gate" to a single person, it is wrong; the gate is four checks with four owners

**Alternatives Considered:**
- **Scan every file type in the repository** -> maximal coverage and a flood of false positives from binaries, fixtures and vendored schemas; the extension allowlist exists because line-based matching needs a file it can read
- **Treat Go as out of scope because it is compiled and reviewed more carefully** -> this is the argument that was already tried for TypeScript, and three leaks landed anyway. Review attention is what ADR-030 exists to stop relying on
- **Add a topology check to level 0** -> a static check cannot tell a supported topology from an unsupported one without running the thing; the honest place for it is check 3, which is already a run
- **Leave the count hard-coded and document the three-node requirement** -> defensible for a homelab, and it makes "shared bones, not copies" false the first time an enterprise cluster has five control-plane nodes

**Consequences:**
- The scan scope is now stated in four places that must move together: `DefaultGuardPathspecs`, `guardScanExtensions`, and the hook's `types_or` and `files:`. That is one more coupling than before and it is the honest count; the mitigation is the comment already at `internal/config/guard.go:316` plus the standing condition in `docs/contracts/fork-ability.md`, not a promise to remember
- Widening the scan will surface existing violations in `cmd/` and `internal/`; they are found at the moment the scope changes rather than by a stranger, which is the point, but it is a one-off cleanup cost on the SRE's change rather than a clean no-op
- `--node worker-1` and similar defaulted node keys become things the gate can at least ask about. Whether a generic node key is a violation is a judgment call for the rule's owner; today nothing can raise the question at all
- Check 4 gives the Senior Platform Engineer a check of their own, which is what removes the two-owners-or-none collision on #52 AC4
- A fork with a non-three control-plane topology becomes a supported case rather than an accident: ADR-035 derives the count from the `^CP[0-9]+_IP$` key set, so the address list is what expresses it
- The gate is now four checks across three owners plus the rule's owner; that is more coordination than one check, and it is the price of the scope being honest about what it covers

### ADR-038: The audit stream is sourced, the work queue has a real dead-letter path, and `rs` is deleted — event-contract revisions from the second-reviewer pass (2026-09-25); refines ADR-026

*Numbering note: `main` carries ADR-001..033 plus 035 and 037; 034 and 036 are allocated to the open pull requests named in the blockquote above. This decision takes 038 rather than filling that contested range. A gap is cheaper than a duplicate number.*

**Context:**
- ADR-026 and `contracts/events/` were merged in #339 with `task contracts:check` and 36 unit tests green. The second reviewer did not read the stream config, they **ran it**: `nats-server v2.10.22` with JetStream, creating each stream field for field from `subjects.v1.yaml`
- Three of the things the contract specified, the server refuses outright, and a fourth loses data silently. The gate was green on all four, which is the more important finding: a boundary gate that is green on a configuration the broker rejects is worse than no gate, because it converts "someone will notice in review" into "CI said it was fine"
- Every error quoted below is the server's own, and every gate result below was re-run against the real files in this repository

**Decision:**
- **`PF_AUDIT` sources from `PF_EVENTS`; it has no subject filters of its own.** Two streams in one account may not have overlapping subject filters (`subjects overlap with an existing stream`, 10065), and `PF_AUDIT`'s filters were a strict subset of `PF_EVENTS`'. The stream as specified could not be created. Sourcing also deletes the "consumers see each twice" cost entirely and makes the envelope `sequence` unambiguous: one publish, one PubAck, one sequence, from `PF_EVENTS`
- **`replicas` is the operator-supplied placeholder `<replicas>` on every stream**, defaults per surface (homelab `1`, commercial `3`, needing a 3-peer meta-group). A hard-coded `3` made every stream uncreatable on a single-node fork (`replicas > 1 not supported in non-clustered mode`, 10074)
- **`PF_WORK.max_age` is 24h, and age expiry there is documented as a silent-loss path** covered by a stream-level alert, not by a consumer advisory. `max_age` on a work queue deletes unacked work with no signal on the path that matters, and the max-deliveries advisory does not fire because nothing was ever redelivered. An earlier draft of this bullet named `state.first_ts` as the alert's input; that was wrong and is corrected below — the metric is `nats_stream_first_seq`
- **Every `PF_WORK` consumer binds one fully-specified subject, and that rule assumes one NATS account — therefore one `PF_WORK` — per tenant.** The assumption is normative rather than implied because the alternative fails silently and destructively: **a durable consumer create with an existing name is an update, not a conflict.** Two tenants running the same component create the same tenant-free consumer name, the second silently repoints the first's filter, and `10100` cannot catch it because it fires on an overlapping filter under a *different* name and stays silent on an identical one. The first tenant's queued work then has no consumer, a work queue retains rather than drops it so nothing alerts, and `max_age` deletes it 24h later down the no-advisory path above. Reachable by a routine second-tenant deployment
- **A real dead-letter path: a `dl` suffix and a `PF_DLQ` stream.** On final failure a consumer republishes the **full original envelope** to the derived `dl` subject, preserving `id`, `source` and `correlationid`, then `Term()`s the original. JetStream's advisory is metadata-only — no payload, no subject, no correlation id — and fires only on the next fetch after exhaustion
- **Every `PF_WORK` consumer binds exactly one fully-specified subject**, named `<component>-<entity>-<action>-v<major>`. Work-queue consumer filters must be unique and non-overlapping (10100), and `PF_WORK` spans every domain, so one domain-wide consumer would foreclose every other component in that domain
- **`rs` is deleted from the grammar and every `wq` type must name a `completion` type** — a registered `.ev` event carrying the same `correlationid`. A reply goes to the requester's `_INBOX.…`, which is outside this subject space by construction, so `rs` was unconstructible; and a durable request with no defined reply left the requester no way to learn the work finished
- **`durable_request` is removed from the registry**; durability is derived from the subject suffix, which is the one place a reader already sees it. Three gate rules existed only to reconcile the two copies
- **`sequence` becomes optional**, `ordering: per_subject` is documented as a stream property and not a delivery property with `max_ack_pending` given an explicit default, and the `duplicate_window` claim becomes a rule on producers rather than a property of the stream
- **`domain`, `entity` and `action` allow internal hyphens**, and a `delivery` domain is added for pipeline and progressive-delivery events, which had no honest home
- **The gate now pins the whole contract, not just the type list**: the envelope **attribute by attribute** — the property set in both directions, each attribute's declared type, its `pattern`, `format` and `const`, its `required` membership, and the `additionalProperties` flag — the stream set (filters, sources, retention, discard, delivery, ordering), the subject grammar and **the payload schemas' own top-level properties**. It rejects status demotion, `dataless` body removal, `requires` *removal*, `producer` reassignment, filter narrowing, retention shortening, a hard-coded tenant in a new type, a `dataschema` that resolves to no file, and — statically — an overlapping stream set
- **Publishing the payload schemas made them boundary contracts, so they are gated like one.** Pinning the `dataschema` *path* while leaving the file's contents unpinned reproduced exactly the defect this ADR was written to fix: a gate green on a breaking change. A newly required payload property, a deleted property, a retyped property, a schema that stops resolving, and closing a schema to additions are each rejected against the baseline. Nesting is deliberately out of scope — only top-level properties are pinned, so the baseline diff stays readable by eye, and a nested break still surfaces as a type change on its containing property
- Normative detail: `docs/contracts/event-contract.md`. `pf.>` is reserved for the platform bus; third-party buses get their own root and their own NATS account

**Alternatives Considered:**
- **Exclude identity and control from `PF_EVENTS` instead of sourcing** -> removes the overlap, and a consumer wanting "every v1 event" would then bind two streams and reconcile two sequence spaces. That is the cost sourcing avoids, moved somewhere less visible
- **Treat the max-deliveries advisory as the dead-letter path and document its limits** -> cheaper, and it leaves recovery of the actual work requiring `$JS.API.STREAM.MSG.GET` by sequence, i.e. stream-admin rights the failing component does not have. "Every event traceable end to end" has to survive the failure path or it is not a property
- **Define `rs` properly as a persisted completion subject and fix the gate to allow it** -> workable, and it invents a fourth delivery path to do what the `.ev` path already does durably. Reuse beat symmetry
- **Keep `replicas: 3` and call single-node a deployment concern** -> it is a fork-ability failure at the first stream a stranger creates, which is the definition of the contract we said we would not break
- **Accept the six gate gaps and rely on review** -> ADR-030 exists precisely because "review will catch it" is not a control. Each of the six was demonstrated passing, and each now fails

**Consequences:**
- `PF_AUDIT` holds a second physical copy of identity and control events on disk. That cost is real and was always going to be paid; what is gone is the per-consumer duplicate delivery
- The stream set grows to four. `PF_DLQ` needs its own retention budget (30d) and its own operator attention — a DLQ nobody reads is a slower silent loss
- Every `wq` producer now ships two types, the request and its completion. That is more registry surface for a genuinely better property: the requester has a durable, replayable outcome instead of a reply it may not be alive to receive
- The compatibility baseline changes shape, from a bare array of types to an object pinning grammar, envelope, streams and types. It is regenerated once in this change; no previously-tracked field of any stable type changed, which was verified against the pre-change baseline before regenerating
- `sequence` moving from required to optional is a relaxation of a promise to consumers, which this ADR otherwise treats as breaking. Stated precisely, because an earlier draft of this paragraph was not: `envelope.v1.schema.json` already existed on `main` with `sequence` in `required`, so this **is** an edit to a published schema, not a pre-publication correction. What begins here is the *gate's* pin of the envelope — the baseline was a bare array of types and never opened the envelope file, so no tooling ever enforced the old shape. Two things make the relaxation safe to take now rather than defer. First, the old shape was **unsatisfiable on the `rq` path**: core NATS request/reply has no stream and no PubAck, so nothing can assign a sequence and a producer could satisfy `required` only by writing a placeholder — removing a requirement no honest producer can meet is a defect fix, not a relaxation. Second, for the stream paths it genuinely is a relaxation, and it is taken now because the cost is provably zero today (no producer, no consumer) and unbounded once either exists. After this, both directions are rejected
- The twelve payload schemas all set `additionalProperties: false`, which is the right default for a **producer** validating what it emits and the wrong one for a **consumer**: a consumer validating an incoming event against the copy it shipped against rejects every event carrying a property added later, which forecloses the additive path this contract calls non-breaking. The schemas keep `false`, and `docs/contracts/event-contract.md` now makes consumer-side leniency normative — consumers MUST ignore unknown payload properties. The gate pins the flag so a later `true -> false` flip on a stable type is a visible, rejected change rather than a silent one
- The baseline grows a `payload` object per stable type — 70 pinned properties across twelve types. It is regenerated a second time in this change, and that regeneration is provably additive: `jq 'del(.types[].payload)'` over the new baseline is byte-identical to the one produced before this rule existed
- **The envelope's `properties` block is pinned, because pinning `required` alone reintroduced this ADR's own defect one level down.** `sequence` moving out of `required` (above) left it pinned by nothing at all, and deleting it outright from the schema passed `contracts:check` — in the same change that made `consumers.ordering_reality` normative and told every consumer to use `sequence` to detect reordering. Two more escaped with it: adding an *optional* attribute, which is the precise hazard `event-contract.md` §4 describes under `additionalProperties: false` and which a required-only pin cannot see, and narrowing the `type` pattern to drop the hyphen support this ADR adds. The asymmetry was the tell — payload schemas pinned property by property, 70 of them, while the one file every event on the bus validates against was pinned by an eight-element string array. The baseline is regenerated a third time and that regeneration is provably additive too: `jq 'del(.envelope.properties, .envelope.additionalProperties)'` over the new baseline is byte-identical to the one produced before this rule existed. This is also what makes `sequence` optional safe to keep: the field's presence and type are now pinned even though its *requiredness* is not
- **Correction to C3's metric, from the SRE pass (MCAA-134):** the alert cannot be derived from the stream's `state.first_ts`, because `prometheus-nats-exporter` exports no message age and no timestamp for a stream at all — verified against 0.18.0, the tag the NATS chart pins, and against the exporter's `main`. The server has `state.first_ts` in `/jsz`; the exporter drops it. The SLI is `nats_stream_first_seq` plus `nats_stream_total_messages`: on a work queue the head leaves only when it is acked, so a frozen `first_seq` over a window the stream was never empty *is* the age of the oldest unacked message. This ADR named a metric that does not exist; the requirement was right and the input was wrong, which is the argument for pinning the input against a deployed exporter rather than a plausible name
- **Correction to C3's advisory claim, same pass:** "no advisory of any kind" was too strong. Age expiry emits exactly one `io.nats.jetstream.advisory.v1.terminated` for a message that was *in flight on a consumer* when the budget expired. It emits nothing for a message that was queued and never delivered — and that is the shape of every consumer outage, because a consumer that is down fetches nothing. The conclusion is unchanged and the reason is now the precise one: the advisory exists but cannot cover the failure mode the alert is for
- A stricter gate means more changes need `baseline --write` and therefore a visible diff and a reviewer. That is the intended cost
- The operator model, SDK boundary and BYO seams in #339 were out of scope for the review and remain unrevised here

### ADR-039: An ADR number is allocated by a level-0 uniqueness gate at merge, never reserved at authoring time (2026-09-25); refines ADR-030

**Context:**
- Several branches are open against `docs/project_notes/decisions.md` at any time. Each author appends "the next ADR number" measured against `main`, so they all measure the same number and all take it. Measured 2026-09-25 with `main` at ADR-033: **ADR-034 was claimed by four open pull requests** (#368 deployment DAG contract, #372 alert triage agent, #387 Envoy Gateway, and #388 by inheritance from #382), and a previous instance of the same collision had already been adjudicated by hand a day earlier
- The failure is silent, not noisy. Whichever branch merges first takes the number; the second branch's rebase appends its heading at a *different* offset in the same file, so git merges both without a conflict and `main` ends up with two `### ADR-034:` headings. Every existing citation of ADR-034 — in contracts, in handoffs, in other ADRs' `refines`/`supersedes` lines — silently becomes ambiguous, and nothing in the repository or in CI reports it
- The dangerous variant has the same shape. A branch that reserves a number with a placeholder heading (`### ADR-033 **Reserved — lands in #365**`) gets *no* conflict when the real ADR-033 merges: confirmed on #382, where the rebase reported a conflict only in another file and `main`'s ADR-033 was simply gone from the result
- There is no shortage of numbers and no contention over content. The only thing missing is a mechanism. Each instance was being resolved by an architect enumerating claims across every open branch by hand and writing a ruling — which does not scale, is not durable, and was itself wrong once: a renumber applied on 2026-09-25 moved a branch off the four-way ADR-034 pile straight onto a number a *different* branch already claimed, because the claim table had been enumerated for the number being vacated and not for the number being landed on
- ADR-030 already settled the governing principle for this class of problem: a boundary is held by a frozen artifact plus a diff plus a named rule, not by review attention. The ADR record is a boundary — it is the repository's decision contract, cited by files that outlive every branch — and it was the one boundary with no gate on it

**Decision:**
- **The ADR record has one canonical heading shape:** `### ADR-NNN: <title> (<date>)`, three digits, zero-padded, at heading depth three. No other heading in `decisions.md` may name an ADR number — prose headings *about* the record (`## ADR numbering conventions`) are fine, because they claim no number
- **A number is claimed by merging, not by intending.** An author appends the lowest number free at the time of writing and expects no guarantee. If another ADR of that number reaches `main` first, the second author renumbers during the rebase they were doing anyway, keeping the ADR body byte-identical and moving only the heading number
- **`homelab verify all --level 0` enforces both**, in `internal/verify/decisions.go`, as the checks `decisions/adr-format` and `decisions/adr-numbers` — plus `decisions/adr-record`, which replaces them when the record cannot be parsed, because a checker that silently read nothing must not emit a green. It reads the repository, needs no cluster, and runs on every pull request twice: `pr-contract.yml` on the head and `verify.yml` on the merge result. **Only the head run blocks.** "Verification claim matches level 0" is `main`'s single required status check; `verify.yml` is not in the required set, so a collision visible only in the merge result is red without being a merge gate. The rebase is what makes it blocking, and the rebase is what the second author is doing anyway. Adding `Level 0 (render, schema, gitops, snapshot, policy)` to the required contexts closes that window for every level-0 check at once and needs repository admin; it is tracked separately, and is preferred over building a second merge-result path for this one check
- **The checker reads the record the way Markdown renders it.** Up to three leading spaces still make an ATX heading, so an indented `### ADR-034:` is a real heading and is checked; four spaces is an indented code block and is not. A heading that names no number (`## ADR numbering conventions`) is prose; one that names a number at any depth is a claim on that number and is checked. This is the difference between a gate and a gate-shaped regex: every form that renders as a heading has to be visible to it
- **A number you intend to use is recorded as prose, never as a heading.** A blockquote above the next real ADR states the intent and can never duplicate; a placeholder heading carries the exact shape that makes the merge ambiguous, so `decisions/adr-format` rejects it
- **No contiguity and no ordering requirement.** The gate checks uniqueness and shape only. Branches merge out of order, so a gap or an out-of-sequence entry is the *normal* result of the rule above and must not be a failure — a contiguity check would force renumbering on branches that were not in conflict with anything
- **The checker has its own test**, including one that runs it against the committed `decisions.md` (quality-gates.md §2 point 4). A gate that can be committed green against fixtures while `main` already carries a duplicate is not a gate
- **Citations follow the number.** Renumbering an ADR that is cited outside `decisions.md` obliges the renumbering author to update those citations in the same commit. Where two branches both carry outside citations, the tiebreak is whichever number is cited in a *published* document or a completed review, because those cannot be edited by rebasing

**Alternatives Considered:**
- **A central allocator (a registry file, or an architect who hands out numbers)** -> adds a serialization point to every ADR, and the registry file becomes the new hottest conflict in the repository. It also does not detect the failure it is meant to prevent: a branch that ignores the allocator still merges silently
- **Keep adjudicating collisions by hand** -> what was happening, and it produced a wrong allocation within a day of being written down. It also scales with the number of open branches, which is the wrong direction
- **Derive the number from the merge commit or the PR number** -> removes the collision and the human-memorable sequence with it. Every existing citation is of the form ADR-0NN; changing the identifier scheme invalidates them all to fix a bookkeeping problem
- **One file per ADR (`docs/adr/0039-*.md`)** -> genuinely removes the merge ambiguity, since two branches adding different files do not conflict. Rejected for now because it is a migration of 33 entries plus every citation of them, and it does *not* remove the duplicate-number problem — two branches can still create `0039-a.md` and `0039-b.md`. The gate is needed either way, so it lands first; the split stays on the table as a separate decision
- **Enforce contiguity as well as uniqueness** -> would have forced a renumber on branches that had no conflict at all, purely to close a gap that harms nobody
- **A lint rule in a pre-commit hook instead of level 0** -> a hook runs on the author's machine before the rebase that creates the duplicate, which is exactly when the file is still clean. The duplicate is created by a merge, so the check has to run on the merge result

**Consequences:**
- The second branch to rebase onto a taken number gets a red check with both line numbers and the next free number in the message, instead of a green merge and a corrupted record. This moves work onto the second author, deliberately: they are the one already editing the file
- Level 0 gains two checks and a few milliseconds. It reads one more file and no cluster, so it costs nothing on the critical path
- `decisions/adr-format` is stricter than the record has historically been. All 33 entries on `main` at the time of writing already conform, so the strictness costs nothing today and prevents the placeholder-heading failure permanently
- The gate reports a duplicate; it does not choose which ADR keeps the number. That judgment stays with an architect, and the citation tiebreak above is what it is decided on. The gate's contribution is that the decision now happens before the merge rather than being discovered after it
- An author can no longer assume the number they wrote is the number that ships. Branch names, PR titles and commit messages citing the old number are cosmetic and are left alone; citations in committed files are not, and move with the renumber
- **Blast radius when a duplicate does land:** the checks read the repository, not the diff, so a duplicate on `main` turns the required check red on *every* open pull request until `main` is fixed, urgent ones included. The recovery is fix-forward and takes seconds — renumber the later heading on `main` and every PR goes green on its next run — and the only bypass is the repository owner merging past the required check under `enforcement_level: non_admins` with the reason in the issue. There is no per-file exemption annotation for these checks; `docs/runbooks/verification.md` carries the procedure
- The one-file-per-ADR split is deferred, not rejected. If the record keeps growing this way, the gate written here is what makes that migration safe to attempt

### ADR-040: Envoy Gateway replaces Traefik; Istio gateways deployed for comparison (2026-09-25); supersedes the 2026-02-13 dual-ingress entry

**Context:**
- Two Traefik releases served every UI through Ingress objects plus Traefik-only CRDs (IngressRoute, Middleware), so routing was tied to one vendor's API
- Gateway API is the Kubernetes routing standard; its CRDs were already installed for Istio waypoints (ADR-020), and every upstream chart in use already renders an HTTPRoute
- Each app requested its own certificate through cert-manager annotations, and the Traefik OIDC plugin (Middleware `oidc-auth`, `oidc-redis`, `auth.<DOMAIN>`) was deployed but attached to no route

**Decision:**
- Envoy Gateway v1.9 (OCI charts `gateway-helm` + `gateway-crds-helm`, one key `charts.envoy-gateway`) runs two Gateways with their own GatewayClass, EnvoyProxy and LoadBalancer Service: `envoy-internal` (LAN + tailnet, UniFi DNS) and `envoy-external` (Internet, WAN port forwards, Cloudflare DNS), namespace `envoy-gateway-system`
- The Envoy Services take over the Traefik addresses (`GATEWAY_EXTERNAL_STATIC_IP`, was `TRAEFIK_STATIC_IP`; `GATEWAY_INTERNAL_STATIC_IP` pins the old internal address) so DNS records and port forwards do not change at cutover
- One wildcard certificate (`<DOMAIN>`, `*.<DOMAIN>`) terminates TLS at the `https` listener of both Gateways; the `http` listener only redirects
- Every Ingress and IngressRoute becomes an HTTPRoute with `sectionName: https`, through the upstream chart's route support where it exists; external-dns switches to the `gateway-httproute` source filtered by Gateway name
- The OIDC plugin is dropped; edge authentication, when needed, will be an Envoy Gateway `SecurityPolicy`
- Gateway API CRDs (standard channel) get their own Application at wave 1, the only producer for Envoy Gateway, Istio gateways and waypoints
- `charts/istio-gateways` deploys `istio-internal` / `istio-external` with the same listeners and certificate, but only an `echo` route attaches to them (plus `envoy-internal`), so both implementations can be compared on the same request without taking traffic

**Alternatives Considered:**
- **Traefik's Gateway API provider** -> keeps the controller, but the Kubernetes Gateway provider lags Traefik's own CRDs and the OIDC plugin/middlewares would still be Traefik-only
- **Cilium Gateway API** -> no extra controller, but it ties ingress to the CNI's release and configuration (inline Talos manifest, `task render` + `tf apply` for every change) and exposes little of Envoy's access log and policy surface
- **Istio gateway as the ingress** -> istiod is already running, but it would make the opt-in mesh (ADR-020) a hard dependency of every UI; deployed side by side for measurement instead

**Consequences:**
- Networking objects are portable Gateway API resources; no vendor CRD sits between an app and its route
- No Ingress object may exist: Envoy Gateway ignores them, so a chart that can only render an Ingress needs an HTTPRoute template of our own
- Per-app certificates and their cert-manager annotations disappear; one renewal covers every host, and a host outside `*.<DOMAIN>` needs its own listener
- The cutover needs the renamed keys in `homelab.yaml` and the 1Password `homelab-environment-config` document before merge; there is a short gap between Traefik's Services being pruned and Envoy's receiving the freed addresses (`docs/runbooks/envoy-gateway.md`)
- The Istio gateways cost two small Deployments and two pool addresses; remove `charts/istio-gateways` once the comparison is done

## Tips

- Number decisions sequentially (ADR-001, ADR-002, etc.). Write the heading as `### ADR-NNN: <title> (<date>)` — three digits, heading depth three — and take the lowest free number. The number is yours when it **merges**, not when you write it: if another branch lands it first, renumber yours during the rebase, keep the body byte-identical, and move the citations with it (ADR-039). `task verify` fails on a duplicate number and on any other heading shape
- Never reserve a number with a placeholder heading. Say it in a blockquote above the next real ADR instead; a placeholder heading merges cleanly over the real ADR of that number and deletes it
- Include date for temporal context
- Be honest about trade-offs (both positive and negative consequences)
- Keep alternatives brief - just enough to show what was considered
- Don't include implementation details - focus on the "why" not the "how"
