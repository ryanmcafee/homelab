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

- **2026-02-13: Dual Traefik Ingress Controllers** — Split single Traefik into external (`external` IngressClass, static IP <TRAEFIK_STATIC_IP>, OIDC, port forwarding) and internal (`internal` IngressClass, dynamic IP, no OIDC). Plex uses external; all other apps use internal. OIDC middleware annotations removed from internal apps. Design doc: `docs/plans/2026-02-13-dual-traefik-ingress-design.md`.

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

### ADR-024: Every stateful platform capability is a Kubernetes operator reconciling a CRD (2026-09-25)

**Context:**
- Homelab and the commercial PaaS must share one architecture; the first place two codebases appear is a capability built as a bespoke service on one surface and as an operator on the other
- The platform is event-driven over NATS, and every event path it can offer is at-least-once (ADR-025) — a design that carries state in events would be wrong on delivery semantics from day one
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

### ADR-025: A seven-token NATS subject taxonomy and a narrowed CloudEvents envelope, with no exactly-once path (2026-09-25)

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
- Three streams: `PF_EVENTS` (7d), `PF_AUDIT` (365d, `discard: new`, deliberately overlapping), `PF_WORK` (work queue). A subject no stream covers is an error, not a warning
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
- Every consumer must be idempotent, which is real work — it is the same property ADR-024 already demands of operators, so the cost is shared rather than doubled
- Seven fixed tokens force some awkward `<entity>` choices for events that are not about a resource; that is the price of stable wildcards
- Anything that must outlive stream retention (7d / 365d) lives in Postgres or a CRD `status`, never only in a stream
- `PF_AUDIT` deliberately duplicates identity and control events already on `PF_EVENTS`; consumers see each twice, which is safe only because of the idempotency rule

### ADR-026: One SDK and one API contract for both surfaces, contract before implementation (2026-09-25)

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

### ADR-027: Bring-your-own cloud, key, identity centre and agent identity are pluggable seams designed before the first customer (2026-09-25)

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

### ADR-028: Fork-ability is an enforceable rule in the static gate with a named owner (2026-09-25)

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

### ADR-029: Boundary contracts are gated by a frozen baseline and a named rule set, not by review attention (2026-09-25)

**Context:**
- ADR-025 and ADR-026 are only worth having if a breaking change actually fails; otherwise they are documentation that the next deadline overrides
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

### ADR-030: Go for the distributable `homelab` CLI, TypeScript/Bun for repository scripting (2026-09-25); refines ADR-005

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
- **Port the CLI to TypeScript/Bun for one language** -> honest about the stack, and it makes the first command a forker runs depend on installing Bun first, which is exactly the fork-ability friction ADR-028 is trying to remove. It would also discard working, tested Go in `internal/verify` and `internal/scaffold`
- **Move everything to Go** -> contradicts ADR-005 for no gain; `scripts/` runs in an environment that already has Bun, and Biome plus `bun test` are working well
- **Bun's single-file executable compilation** -> genuinely closes some of the distribution gap and is worth revisiting, but it is a newer path with a larger binary and less cross-compilation history than Go's. A reversible decision to leave for later

**Consequences:**
- Two languages, permanently, with a rule for which is which — the cost is contributor context-switching and two toolchains in `mise.toml`, both of which already exist today
- A forker downloads one binary and runs it; no runtime prerequisite before the bootstrap can even report what is missing
- Logic needed by both sides risks being written twice; the mitigation is that anything shared must be expressed as a contract under `contracts/` and consumed as data, and a second implementation of the same logic is a review failure
- #52 proceeds as specified in Go with no sequencing change

## Tips

- Number decisions sequentially (ADR-001, ADR-002, etc.)
- Include date for temporal context
- Be honest about trade-offs (both positive and negative consequences)
- Keep alternatives brief - just enough to show what was considered
- Don't include implementation details - focus on the "why" not the "how"
