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
- **"For any change to bootstrap, secrets or identity" is enforced by a `paths:` trigger, not by a CODEOWNERS rule.** `.github/CODEOWNERS` assigns `*` to the single repository owner and gives every listed path that same single owner, so a CODEOWNERS entry cannot carry this obligation in this repository — it would be prose wearing a machine-readable costume. `fork-path-cold.yml`'s own `paths:` filter still covers only the workflow file itself, so the obligation is carried by the `Fork-ability check 3a change gate` job in `verify.yml` (`scripts/fork-path-gate.ts`)
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

> **Numbering note (2026-09-25).** `ADR-034` is allocated to
> [#368](https://github.com/ryanmcafee/homelab/pull/368) (the generated deployment DAG contract
> for #53a), a pull request that is open and unmerged at the time this one lands; its number is
> already published in backlog v3.2 and in a completed second review. The gap is an allocation,
> not a lost decision. It is recorded as a blockquote rather than a reserved `### ADR-0xx` stub
> on purpose: a stub is a heading, and a heading is what produces a duplicate ADR number when the
> real one merges — which is exactly the hazard this file hit when #365 landed `033`.

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

### ADR-036: An in-cluster alert triage agent that fixes through pull requests, as an Argo Workflows DAG (2026-09-25)

**Context:**
- Every alert so far was root-caused and fixed by hand from a workstation: read the alert, read the cluster through `homelab-readonly`, change the repository, run the checks, open a PR
- The read-only identity (`charts/agent-readonly`), the repository's agent instructions and level-0 checks already make that safe to automate; the goal is a fix PR on the phone with no human in the loop until review

**Decision:**
- An intake (`triage-agent serve`) receives every alert (Alertmanager webhook with `continue: true`, plus a sweep of `/api/v2/alerts`), groups and dedupes it with a 24h cooldown and submits one Workflow per group from the `triage-fix` WorkflowTemplate
- The DAG shifts verification left: triage -> plan -> implement -> deterministic verify (the repository's own tasks, bounded 3-attempt loop with the log fed back) -> commit -> PR (force-with-lease, update the open PR of the branch) -> CI watch (bounded 2-round loop, then draft + `triage-agent/needs-human`) -> onExit Pushover notification. Only triage, plan and implement call the model
- The cluster stays read-only: steps run as a ServiceAccount bound to `view` + `homelab-agent-readonly`; a PreToolUse hook denies mutating kubectl, `gh pr merge`, pushes to main and Alertmanager/Prometheus writes. `argocd app sync` is allowed through a dedicated ArgoCD account limited to get + sync; force pushes to non-main branches are allowed
- The user's global instructions come from the private dotfiles repository at runtime, never from this public repository

**Alternatives Considered:**
- One long agent run per alert (the first draft of this PR) -> no retries per stage, no deterministic gate, and the model would decide when checks passed
- Paperclip agents -> built for issue work, not for reacting to Alertmanager; a separate path keeps alert triage independent of Paperclip's health
- Report only -> leaves the fix to a human at a keyboard, which is what the feature exists to avoid

**Consequences:**
- Each new alert group costs up to five model runs on the subscription; the semaphore (1 workflow), the mutex per alertname and the cooldown bound it
- The fine-grained PAT can technically merge; the deny hook and review are what keep merging human
- exec and in-cluster `curl` GETs stay trust-based (docs/runbooks/triage-agent.md, Security model)
- Workflows share one 100Gi workspace claim (a directory per workflow) instead of per-workflow claims: the NFS class retains every released PV, so per-workflow claims would leak a TrueNAS dataset per run; the price is a janitor in the intake that must keep deleting finished directories, watched by its own alerts

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
- **Correction to C3's metric, from the SRE pass (MCAA-134):** the alert cannot be derived from the stream's `state.first_ts`, because `prometheus-nats-exporter` exports no message age and no timestamp for a stream at all — verified against 0.18.0 and the exporter's `main`, and re-verified at 0.20.1, the tag the NATS chart actually pins (MCAA-387: 0.18.0 was not the deployed version when this was written, which is the same mistake in miniature). The server has `state.first_ts` in `/jsz`; the exporter drops it. The SLI is `nats_stream_first_seq` plus `nats_stream_total_messages`: on a work queue the head leaves only when it is acked, so a frozen `first_seq` over a window the stream was never empty *is* the age of the oldest unacked message. This ADR named a metric that does not exist; the requirement was right and the input was wrong, which is the argument for pinning the input against a deployed exporter rather than a plausible name
- **Correction to C3's advisory claim, same pass:** "no advisory of any kind" was too strong. Age expiry emits exactly one `io.nats.jetstream.advisory.v1.terminated` for a message that was *in flight on a consumer* when the budget expired. It emits nothing for a message that was queued and never delivered — and that is the shape of every consumer outage, because a consumer that is down fetches nothing. The conclusion is unchanged and the reason is now the precise one: the advisory exists but cannot cover the failure mode the alert is for
- **Confirmed on a real server (2026-09-28): a stream may take two `sources` entries from one origin stream.** That was the shape this ADR was least certain of — the `10065` overlap it replaced is a create-time refusal, so a wrong answer would have made `PF_AUDIT` uncreatable and the fix would have been one source with two `subject_transforms`. Measured on Kind through the deployed NACK and chart at `249125e`: `PF_AUDIT` reports both `pf.*.control.*.*.*.ev` and `pf.*.identity.*.*.*.ev` active from `PF_EVENTS` at lag 0, with no `10065`. The decision stands as written and the reopening condition recorded in the #438 conformance review is retired. What this does **not** prove is the filters themselves: the run published only `workload` events, which both filters exclude, so the negative assertion — a `workload` event is absent from `PF_AUDIT` while an `identity` event is present — remains the open e2e condition. **Both halves now measured and both pass (ADR-044), and that ADR also revises the shape this bullet confirmed: "the server accepts two sources" is create-time acceptance, and two entries from one origin make the exporter's scrape un-gatherable**
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

### ADR-042: Every platform stream carries an operator-supplied `max_bytes`, because an unlimited stream makes its `discard` policy decorative and its failure shared (2026-09-28); refines ADR-026 and ADR-038

*Numbering note: `main` carried ADR-040 when this was written. ADR-041 is claimed by the open RED-metric-contract branch (MCAA-267), which was checked before writing rather than after merging, so this takes 042 per ADR-039. No number is reserved here for anything.*

**Context:**
- The ADR-026/ADR-038 conformance review of #438 read the stream set against what JetStream actually does with it. `contracts/events/subjects.v1.yaml` gave all four streams a `discard` policy and **no size or count limit at all** — no `max_bytes`, no `max_msgs`, no `max_msgs_per_subject` — and neither did `charts/nats-config`
- **JetStream applies `discard` only when a stream reaches `max_msgs`, `max_bytes` or `max_msgs_per_subject`. Age expiry is a separate path that ignores it entirely.** So every `discard` value in the contract was decorative, and three sentences the contract asserted as behaviour could not happen
- `PF_WORK`'s `discard: new` was documented as "when the queue fills, publishers get an error instead of the stream silently dropping work. Backpressure belongs on the producer." `PF_WORK` never fills: with no size limit it grows until the shared file store is exhausted, so there is no backpressure on the producer at any point
- `PF_AUDIT`'s `discard: new` was documented as refusing "ITS OWN writes rather than dropping history", and as therefore no longer blocking live publishes on `PF_EVENTS`. With 365d of retention and no ceiling, the only thing `PF_AUDIT` can exhaust **is** the shared store — and that failure refuses writes for **every** stream on the peer, `PF_EVENTS` included. The isolation the sentence promised was precisely inverted
- **Blast radius is the whole point.** The failure mode is not "the audit stream stops accepting audit events", it is "JetStream on this peer stops accepting anything" (`insufficient resources`, 10023). One stream's retention budget becomes a bus-wide outage. That is the opposite of what ADR-038's `PF_AUDIT` decision was taken to buy
- The gate was green on all four streams in this shape, which is the more important finding and the same finding ADR-038 recorded: a boundary gate green on a configuration that cannot behave as documented is worse than no gate. ADR-038 closed that for things the server *refuses at create time*; nothing covered a stream the server happily creates and that then behaves nothing like its documentation
- This is a defect in the **contract**, not in #438, so it did not block that pull request

**Decision:**
- **Every stream carries `max_bytes`, and it is the literal operator-supplied placeholder `<max_bytes>`** — the same pattern `replicas` already uses, for the same fork-ability reason. A committed byte count is one operator's disk. Defaults live in a new `max_bytes_defaults` block, per surface, per stream
- **`max_bytes_defaults` is per surface with every stream named, and both surfaces use one split.** Homelab budgets 6 GiB of the 20 GiB file store it provisions (30%); commercial budgets 96 GiB of 128 GiB (75%), divided 33.3% / 50% / 4.2% / 12.5% across `PF_EVENTS` / `PF_AUDIT` / `PF_WORK` / `PF_DLQ` on both. An earlier revision of this bullet and of the contract comment said homelab budgeted 6 GiB **of 8 GiB**, at 75% like commercial. That was an invented premise: the real number is `nats.jetstream.storage.size` in `configuration/templates/helm-addons.tmpl`, which is 20Gi for homelab and 2Gi for localdev, and the rendered `tests/snapshots/homelab/addons.yaml` injects `fileStoreSize: "20Gi"`. Nothing failed, because the two surfaces are sized independently and 30% passes a 75% ceiling — but the prose would have told an operator that raising one stream required lowering another when 14 GiB was free, which is the wrong decision from an accurate-looking sentence. **75% is the ceiling the chart refuses to render above, not a target the defaults aim at**, and homelab staying well under it is the **reversibility** lens on sizing: raising a `max_bytes` is additive, while lowering one below what a stream already holds makes JetStream discard or refuse at the new limit. `PF_AUDIT` is the largest because 365d of identity and control history is what it exists to hold; `PF_WORK` is the smallest because a drained work queue is nearly empty and a deep one is already an alert. One split rather than two is the **shared bones** lens applied to sizing: a commercial operator reading a homelab install reads the same shape scaled up, and a divergence between the two surfaces for the same concern is the thing that lens forbids
- **The sum rule is stated in the contract: the four streams' `max_bytes` must total strictly below the JetStream file store, with headroom.** `max_bytes` bounds a stream against itself; it does **not** reserve or partition the store. Four streams whose limits sum above the store are individually bounded and collectively unbounded — the shared-store failure returns unchanged, the peer just hits 10023 before any stream hits its own limit, and which publish gets refused is a race rather than a policy. Headroom is required because JetStream accounts for index and metadata alongside message bytes. The neighbouring error is a different one and worth separating: an operator who sizes a *single* stream above the whole store gets `insufficient storage resources available` (10047) at stream **create**, not a bus outage at publish
- **The sum rule is arithmetic an operator applies at sizing time, not a static check, and the ADR says so rather than implying a gate exists.** The file store size is a cluster fact (`nats.jetstream.storage.size` in `configuration/templates/helm-addons.tmpl`, rendered into the upstream NATS chart's `fileStore.pvc.size`), not a value in this contract. What the gate enforces is that the numbers live in `max_bytes_defaults` where the sum is *visible at all*, instead of being scattered across four chart values where nobody adds them up
- **The runtime half of the sum rule is an alert on JetStream file-store utilisation**, owned by the SRE & Observability Engineer: warn at 75%, critical at 90%, plus an absence alert for the same reason `PFWorkStreamMetricsAbsent` exists. Without it the first symptom of a mis-summed budget is 10023 on every publish. A `max_bytes` set with no utilisation alert is the ADR-038 pattern one level out: the limit is real, the approach to it is invisible. **The SLI is `sum(nats_account_storage_used)` over `nats_server_max_storage`** — an earlier draft of this bullet named `nats_server_jetstream_storage_used_bytes`, which the exporter does not export under that or any name, repeating ADR-038's own `state.first_ts` defect three paragraphs after citing it (MCAA-378). The numerator is the per-account store total rather than `nats_server_total_message_bytes` because `wouldExceedLimits` compares `js.storeUsed` — the sum of exactly those per-account totals — against `config.MaxStore`, while message bytes omit the index and metadata that fill the disk and are the reason this rule demands headroom. No kube-state-metrics fallback is needed: the NATS chart writes `max_file_store` from `fileStore.pvc.size` whenever a PVC is enabled, so `nats_server_max_storage` already is the PVC capacity, read from the process that refuses the write. Verified against `prometheus-nats-exporter` 0.18.0 and 0.20.1 (the tag chart `nats-2.15.0` pins), whose storage surface is identical
- **No metric counts a refused publish, so backpressure must be alerted on derived signals.** A 10023 or a `discard: new` rejection is answered to the publisher and never reaches `/jsz`; `JetStreamStats.API.Errors` counts API requests, covers neither, and is not exported. A "this stream is refusing writes" alert is therefore derivable only as bytes pinned at `nats_stream_limit_bytes` while `nats_stream_last_seq` is frozen. Recording it because it is the constraint every future backpressure alert meets (MCAA-378)
- **`task contracts:check` gains static rules, and they fail the shape that was on `main`.** `max-bytes-hardcoded` mirrors `replicas-hardcoded`. `discard-without-limit` rejects any stream declaring a `discard` policy with no `max_bytes` above zero for it to act on — presence is not limit-ness, because JetStream reads `-1` and `0` as unlimited. Verified: the pre-change contract now fails with 10 violations across all four streams; the revised one passes
- **Capacity in this contract is expressed in bytes only: `max_msgs` and `max_msgs_per_subject` are rejected outright** (`count-limit-unsupported`). Both were accepted by the schema and gated by nothing, so a hard-coded count cap landed clean — `max-bytes-hardcoded`'s own defect in a different unit, and worse on `PF_AUDIT`, where `discard: new` plus a count cap refuses audit writes at the count however much of the byte budget is unused. Neither field was in the baseline either, so adding one later was not a compatibility break. There is no use for them here; rejecting beats teaching a second unit
- **A stream with subjects of its own must declare `max_msg_size`, and every such stream is checked** (`max-msg-size-missing`, plus `max-msg-size-mismatch` per stream). The first version of the equality rule found the first stream that declared the field and skipped silently when none did — the `limits-incomplete` shape one rule below it, and reachable: deleting the cap is a compatibility *widening* the comparator must pass, so the static invariant is the only thing holding the sentence that says the stream enforces the budget. Verified by mutation: deleting `PF_EVENTS.max_msg_size` passed before and fails now
- **`duplicate_window` must not exceed `max_age`** (`duplicate-window-over-max-age`). NATS refuses the stream with "duplicates window can not be larger then max age" (10052). Harmless at today's values and uncreatable the moment an operator shortens `max_age`, which puts it in the same class as the 10065 and 10074 rules already in the checker
- **`limits.max_event_bytes` was unreachable and is restated as a producer budget below the server limit.** It was `1048576`, "matching the nats-server default `max_payload`". `max_payload` bounds the whole NATS message — **headers plus body** — and the bound is inclusive (`len(headers) + len(body) <= max_payload` is accepted, verified at the protocol level), so an envelope of exactly 1 MiB is refused because the SDK always adds `Nats-Msg-Id` on top of it, not because equality fails. Which error the producer sees depends on the client: one that knows `max_payload` from INFO refuses locally with the connection intact, and only a client that sends anyway gets `-ERR 'Maximum Payload Violation'` and a reset connection. The contract now states `server_max_payload: 1048576` separately and sets `max_event_bytes: 983040` (960 KiB), reserving 64 KiB for headers: `Nats-Msg-Id` plus whatever a tracing propagator adds. Measured, the worst realistic header block — `Nats-Msg-Id`, `traceparent`, and `tracestate` and `baggage` both at the W3C SHOULD-limits — is **8862 wire bytes**, so the reserve is 7.4x that and costs 6.67% of the producer budget. Deliberate: a budget a later header can silently invalidate is the same defect one size down. A producer checks against `max_event_bytes` and never against `server_max_payload`
- **`PF_EVENTS.max_msg_size` equals `max_event_bytes`, so the budget is enforced by the stream rather than restated as advice**, and the gate pins both the equality (`max-msg-size-mismatch`) and the strict inequality with a 64 KiB header reserve (`max-event-bytes-unreachable`). `limits-incomplete` requires both numbers to be present, because a rule that compares two values silently stops applying when one is deleted — which is how the budget came to equal the server limit in the first place
- **`max_msg_size` joins the compatibility baseline, and narrowing it is breaking** (`stream-max-msg-size-narrowed`); raising it is additive. This change itself narrows `PF_EVENTS.max_msg_size` from `1048576` to `983040`, which is taken now under ADR-038's own `sequence` argument: there is no producer and no consumer today, so the cost is provably zero, and it is unbounded once either exists. After this the pin makes both directions visible
- **`max_bytes` is deliberately NOT in the compatibility baseline.** Its contract value is always the literal placeholder, so pinning it would freeze a constant string and add baseline churn with no detection value. What must not regress is the *presence* of the placeholder on every stream, and `max-bytes-hardcoded` plus `discard-without-limit` cover that in both directions — deleting the field fails, and replacing it with a number fails
- **`contracts_base_uri` has no configuration key, and that gap is now written down instead of waiting to be discovered.** `event-contract.md` requires `dataschema` to resolve as `<contracts_base_uri>` + the registry path, and no key exists in `configuration/schema/`, so nothing today can resolve a `dataschema` at all. **The key lands with the first real producer — the SDK slice — not now.** An operator-facing key no code reads makes every fork answer a question about a URI nothing fetches, and its correct default depends on how the SDK loads schemas (bundled at build time, fetched at startup, fetched lazily), which is the SDK slice's decision. Until then a producer has no resolution path and MUST NOT invent one; consumers compare by `$id`, which needs no configuration
- **The chart-vs-contract drift gate must be symmetric and surface-complete, and both conditions this ADR placed on #438 are now met.** As this bullet was first written, `scripts/nats-streams-contract_test.ts` checked `maxMsgSize` only when the *contract* declared it, so a chart that capped a stream the contract does not cap passed; and it checked `sources[].filterSubject` while never checking `sources[].name`, so a stream sourcing the right subjects from the wrong origin passed. Both are discharged by the gate #438 carries, and the assertions that discharge them are named rather than pinned to a commit, because #438 has rebased more than once and a PR-commit link does not survive that: in `scripts/nats-streams-contract_test.ts`, `maxMsgSize matches the contract in both directions` asserts equality unconditionally for every contract stream, so a chart-only cap fails against `undefined`; and `a stream ingests directly or by sourcing, never both` compares origin and filter as one sorted `name`+filter pair list, so the origin is checked *with* the filter rather than not at all. The gate file itself reaches `main` with #438, so this records a condition discharged on that branch rather than a gate `main` ran when this ADR landed. What carries forward is the rule rather than the two fields: a drift gate that reads one side's optional fields only is a gate against one direction of drift, and one that never enumerates the surfaces is blind to a surface that simply omits the field

**Alternatives Considered:**
- **Hard-code `max_bytes` per surface in the chart's `values-homelab.yaml` / `values-localdev.yaml` and leave the contract silent** -> the numbers then exist but nobody can see them add up, and a fork inherits one operator's disk size as a default it never chose. It also leaves the contract asserting `discard` behaviour it still does not have
- **Set `max_msgs` instead of `max_bytes`** -> a count limit does satisfy `discard` (and the gate accepts it), but it does not bound the thing that actually exhausts: a stream of 1,000 small events and 1,000 near-budget events differ by three orders of magnitude on disk. Bytes are what the file store runs out of
- **Rely on the file store filling and alert on that alone** -> this is what exists today. It converts a per-stream retention decision into a shared, undiagnosable outage, and the alert fires when the bus is already refusing writes rather than when one stream is overrunning its budget
- **Give `PF_AUDIT` its own file store (a second JetStream domain or a separate NATS account)** -> genuinely delivers the isolation `discard: new` claims, and costs a second operator surface, a second PVC and a cross-domain sourcing path for every fork including single-node ones. `max_bytes` buys the same isolation for a number in a values file. Left on the table for the commercial surface if audit volume ever justifies it
- **Add the `CONTRACTS_BASE_URI` key now so `dataschema` resolves** -> a key no code reads, whose default the SDK slice will want to change, asked of every fork. Deferring is reversible; a shipped key with the wrong default is not
- **Make the sum rule a static gate check** -> it cannot be. The file store size is not in this contract, and a gate that checked the sum against a hard-coded store size would bake in the disk this ADR exists to stop baking in

**Consequences:**
- A fork now sizes five numbers instead of four (`replicas` plus four `max_bytes`), and gets defaults for all of them. That is the intended cost of not committing one operator's disk
- **`PF_WORK` now has two independent loss boundaries and they must be reasoned about separately.** `max_bytes` bounds the queue's SIZE and refuses new work at the ceiling (loud, on the producer); `max_age` bounds its messages' LIFETIME and deletes queued work silently (the path ADR-038 C3 documents). Neither substitutes for the other, and a consumer outage can now end in *either* — refused publishes if producers keep pushing, silent expiry if they do not. The `PFWorkOldestUnackedAging` alert covers the second; the file-store alert covers neither, because `PF_WORK` can hit its own ceiling while the store is half empty. A depth alert on `PF_WORK` against its `max_bytes` is the missing third, and is part of the SRE hand-off
- **`PF_AUDIT` will now discard-new at its ceiling, which means audit history genuinely stops being written while the rest of the bus keeps running.** That is the trade ADR-038 chose and it is now real rather than nominal. It is strictly better than the previous behaviour — the whole bus stopping — but "the audit stream refused a write" must be an alert someone answers, or the isolation just relocates the silence
- The pre-change contract fails the new gate with 10 violations. Any open branch carrying its own copy of `subjects.v1.yaml` — #438 does — picks up the requirement on rebase and must add the placeholders
- **The window where #438 could merge a chart setting no `max_bytes` is closed.** When this ADR landed, #438's drift gate did not check `max_bytes` on either side and could not be edited from here, so a chart leaving every stream unlimited would have passed it -- the contract would have required a bound the deployed chart did not have. Two assertions in `scripts/nats-streams-contract_test.ts`, as #438 carries it, close the window from both directions: `stream maxBytes stays a placeholder in the contract and defaults to the homelab values` pins the contract to the literal `<max_bytes>` and pins the chart default and `values-homelab.yaml` to `max_bytes_defaults.homelab`, and `every surface sets a positive maxBytes for every stream` requires each surface's values file to name a positive integer for all four streams. The closure does not retire the point the bullet was making, which is why it was named: a reader must not infer from "the contract requires it" that the deployed chart has it. That inference is refused by a check on #438 rather than left to the reader's caution
- The baseline is regenerated once, and the regeneration is provably additive: the diff is exactly four `max_msg_size` lines and nothing else
- The gate grows nine rules and the unit suite grows fourteen tests, to 104. Level 0 reads one more block of the same file and no cluster
- `max_event_bytes` dropping from 1 MiB to 960 KiB is a 6% smaller event budget, against a limit no honest producer could reach anyway. The 64 KiB header reserve is now a measurement rather than a judgement — 7.4x the 8862-byte worst case above — and it is the number the gate enforces, so raising it later is a visible contract change rather than a silent one
- **The refusal a producer meets at a stream's own ceiling is `maximum bytes exceeded`, err_code 10077, HTTP 503** — identical on `workqueue` and `limits` retention, so `PF_WORK` needs no special case. 10077 is a wrapper whose description carries the real reason, so an alert or a client MUST match the description and not the number: `maximum bytes exceeded` is backpressure working as designed on one stream, `insufficient resources` (10023) is the peer out of store and a bus-wide outage, and both arrive as 503
- **The four defaults were self-inconsistent when first written and no check caught it.** Homelab's `PF_DLQ` was 512 MiB, making the four sum to 5.75 GiB against a stated 6 GiB budget, with an inaccurate comment as the only signal; it is corrected to 768 MiB and both surfaces now use one split. This is the ADR's own subject one level out — a number documentation asserts and nothing verifies — and it is left ungated deliberately for the reason stated above: the store size is a cluster fact. Gating the *internal* arithmetic (each surface's four shares summing to a declared budget) needs the budget and the split declared as contract data, which is a contract-shape change this ADR does not take. It is the open question on MCAA-362, not an oversight

### ADR-043: Tenancy on the bus is a NATS account, a per-user subject permission and a closed `$JS.API`; the bus credential is a seam with one declaration and two backends (2026-09-28); makes ADR-026 D5 real

> `main` carries ADR-042 (merged by #451) and ADR-045 when this merges. ADR-041 is still claimed by
> two open pull requests (#433 and #362), and 044 and 049 by open branches, so this decision takes
> 043. Per ADR-039 the number is allocated by the level-0 uniqueness gate at merge, not reserved
> here.

**Context:**
- ADR-026 D5 says `tenant` "is a trust boundary enforced by NATS account and subject permissions, not
  by consumer-side filtering; homelab runs the same enforcement with the single reserved tenant
  `local`". `envelope.v1.schema.json` requires the attribute, `subjects.v1.yaml` reserves `pf.>` and
  speaks of publish permissions, and ADR-038's `consumers.workqueue_tenancy` is normative *on the
  assumption of* one NATS account per tenant
- As deployed in #438 none of that mechanism exists. There is no account, no user, no credential and
  no subject permission: `config.authorization` is unset, NACK connects anonymously to
  `nats://nats.nats.svc.cluster.local:4222`, `nats-box` connects anonymously, and anything with pod
  network reach can publish any `tenant` token, bind any consumer, or create and delete streams over
  `$JS.API`. The reserved tenant `local` is a naming convention and the enforcement point the
  contract names is absent
- That is defensible for a single-tenant homelab on a ClusterIP-only bus — the blast radius is
  in-cluster — and it is not defensible as the thing the commercial surface inherits, because every
  multi-tenant claim in the contract rests on the account seam being real. ADR-028 is explicit that
  homelab is a peer implementation and not a toy: "homelab exercises the multi-tenant wiring with a
  single tenant". One tenant is the cheap part. Zero enforcement is a different decision, and it was
  never written down
- ADR-038's own lesson governs how this one is argued: a gate green on a configuration the broker
  refuses is worse than no gate. Every mechanism claimed below is read out of **the versions this
  repository actually deploys**, established by rendering `nats` chart 2.15.0 with #438's values:
  server `nats:2.15.0-alpine` and `natsio/prometheus-nats-exporter:0.20.1`, neither of which #438
  overrides, alongside `nack` chart 0.35.0 (controller 0.24.0) and `nats.go` v1.37.0. The first draft
  of this ADR reasoned from `nats-server` v2.10.22 and exporter v0.18.0 — the tags ADR-038's second
  reviewer used — and that was the wrong basis. It was not a harmless citation error: v2.15.0 serves
  a materially larger account-scoped `$JS.API` surface, which is what forced D5 to change shape
  rather than merely be restated. Where a claim is *not* verified against a running server it is
  named as such

**Decision:**
- **D1. One NATS account per tenant, and the account is the enforcement. The `<tenant>` token is
  not.** Subject namespaces do not cross accounts at all. Stated precisely, because the first draft
  overstated it: a client in `TENANT_A` *can* spell `pf.b.…` — nothing reserves the string — but it
  publishes into its own account and no subscriber in `TENANT_B` receives it. The account stops the
  reach, not the spelling; stopping the spelling is D2's job. The token stays in the subject because
  it outlives the connection that carried it — in a `PF_AUDIT` record, in a `PF_DLQ` envelope, in a
  Postgres row — and because a message that crosses an account boundary deliberately must still say
  where it came from
- **D2. Both halves are required and neither substitutes for the other.** The account stops
  cross-tenant reach. A per-user subject permission stops a workload forging a foreign `tenant`
  token *inside* its own account, which is precisely where the account offers nothing. Without the
  second half every consumer that trusts `tenant`, which §5 of the event contract says it must, is
  trusting a value its own tenant's workloads can write freely. **`pf.<tenant>.>` is the ceiling, not
  the grant:** no principal is issued the whole tenant prefix. Each component gets the
  producer-owned prefixes the registry assigns it, narrowed within its tenant — preserving the
  producer boundary the event contract §5 already had — and `pf.*.>` and `pf.>` are issued to
  nothing
- **D2a. Envelope attribution is validated, because subject permissions do not read message
  bodies.** A publisher authorized for a subject can put any `tenant`, `source` or `type` in the
  CloudEvents JSON. Before an event is authorized against, aggregated across tenants, or persisted,
  the consumer requires the envelope `tenant` to equal both the subject's `<tenant>` token and the
  tenant its connection's account maps to, and `source`/`type` to match a producer allowed to own
  that type; a mismatch goes to `PF_DLQ` and is never stored. This is validation of an
  already-authenticated context, not a retreat to consumer-side filtering — the broker still decides
  who may publish. It closes the one thing D1 and D2 together do not: an authorized tenant publisher
  contaminating shared audit and database attribution without ever crossing an account
- **D3. No export or import between tenant accounts, ever.** Cross-tenant aggregation is a
  per-tenant consumer publishing outward under its own identity, never a cross-account subscription.
  An export is the one construct that can reopen D1, and it does so invisibly to every subject
  permission, so it is refused at the contract rather than reviewed case by case
- **D4. `$SYS` is for operating the server, and no platform component holds it.** Its use is server
  events, `$SYS.ACCOUNT.*.>` advisories and break-glass administration. The `nack` 0.35.0 chart
  invites the opposite — its `values.yaml` names the controller's credential `nats-sys-creds` with
  key `sys.creds` — and a system-account NACK has cross-account reach over every tenant's streams,
  which is exactly the boundary D1 buys. NACK instead holds one narrowly-permissioned user per
  tenant account, supplied through the `Account` CRD (`accounts.jetstream.nats.io` v1beta2, shipped
  in the same chart's `crds/crds.yml`, controller 0.24.0). The static backend uses **`spec.nkey`**,
  with the matching public user key assigned to the tenant account; `spec.creds` is an nsc
  credentials file and the two are not interchangeable. Both are Secret references, so the delivery
  path is the one this repository already has (External Secrets + 1Password). **What this does not
  buy, correcting the first draft:** per-tenant `Account` objects bound a *leaked credential* to one
  tenant, but the single NACK process still holds all of them, so controller compromise retains
  combined authority over every tenant's streams. That is accepted residual risk (D7), bounded by
  Kubernetes RBAC on Secret/`Account`/`Stream`/`Consumer` and by admission rules stopping a tenant
  selecting another tenant's account or Secret; real isolation would need separately scoped
  controllers
- **D5. `$JS.API` authorization is default-deny, and the exact allow-list is the contract — not an
  enumeration of dangerous verbs.** The stream set is GitOps state (ADR-038, #438), so nothing but
  NACK needs stream lifecycle rights. The first draft named six denied operations as though that
  were the boundary. Re-read against the deployed v2.15.0 that is plainly insufficient: the
  account-scoped surface also includes `STREAM.RESTORE`, `STREAM.SNAPSHOT`, `STREAM.MSG.GET`,
  `ACCOUNT.PURGE`, `CONSUMER.PAUSE`, `CONSUMER.UNPIN`, `CONSUMER.RESET` and the
  peer-remove/evacuate/leader-step-down endpoints (`jetstream_api.go` v2.15.0, lines 1122-1143) —
  `STREAM.MSG.GET` reads any message body in the account and `ACCOUNT.PURGE` destroys all of it.
  A deny list I have to keep complete is a deny list that goes stale at the next chart bump. So the
  rule is inverted: a NATS user's explicit `allow` set is exhaustive and everything unlisted is
  already refused. A component's allow-list is exactly `$JS.API.INFO`,
  `$JS.API.STREAM.INFO.<stream>`, `$JS.API.CONSUMER.INFO.<stream>.<consumer>`,
  `$JS.API.CONSUMER.MSG.NEXT.<stream>.<consumer>` and its own consumer-create subject (D6). The
  named denies that remain (D6) are defence in depth against a future broader grant, not the thing
  doing the work
- **D5a. Two grants a publish-only list omits, and the client fails without them.** Each principal
  gets subscribe permission on its **own private inbox prefix**, with the client's inbox prefix
  configured to match — JS API replies and pulled messages arrive there, and a shared `_INBOX.>`
  grant would let any principal in the account read every other principal's replies. And its **own
  ACK namespace**, not `$JS.ACK.>`: the broad form admits acknowledging other consumers' messages
  inside the account, while the server derives ACK subjects from the stream and consumer name
  (`$JS.ACK.<stream>.<consumer>.…` and the v2 `$JS.ACK.<domain>.<account-hash>.<stream>.<consumer>.…`
  form, `consumer.go` v2.15.0 lines 1444-1454), so both forms are scopable to this principal. The
  conformance suite therefore tests cross-*principal* refusal inside one account, not only
  cross-tenant refusal
- **D5b. Components bind their stream explicitly.** `nats.go` v1.37.0's subscribe path performs
  stream discovery over `$JS.API.STREAM.NAMES` unless the stream is named, and that subject is not
  in the allow-list. Components pass `BindStream` (or equivalent) and pin the client API options
  they depend on. Granting account-wide discovery to accommodate an implicit SDK choice is the
  wrong repair
- **D6. The consumer-create permission is what makes ADR-038 D2 unrepresentable, and it has three
  entrances.** A `wq` consumer binds exactly one fully-specified subject, so `nats.go` v1.37.0 sends
  `$JS.API.CONSUMER.CREATE.<stream>.<consumer>.<filter>` — the consumer name **and** its filter are
  both in the subject. A permission scoped to that one subject means silently repointing another
  component's filter is denied rather than accepted as an update, which is the failure ADR-038 D2
  documented and could not close with `10100`. v2.15.0 routes three subjects to the same handler
  (`jetstream_api.go` lines 1137-1139): `$JS.API.CONSUMER.CREATE.*`,
  `$JS.API.CONSUMER.CREATE.*.>` and `$JS.API.CONSUMER.DURABLE.CREATE.*.*`; the first carries no
  consumer name in the subject at all. **Correcting the first draft: those alternates are not a
  "leak".** Under D5's default-deny they are unlisted and therefore already refused. They are
  written as explicit denies — for the name-only form and the legacy durable form — purely so a
  later broader grant cannot silently re-open them. **The broad `CONSUMER.CREATE.*.>` form is
  deliberately *not* denied:** deny takes precedence over allow, so denying it would also kill the
  filtered endpoint the component legitimately needs. Two honest limits: the filtered endpoint is
  not bind-only authority, since a principal reaching it can also change other permitted config
  fields on its own consumer; and what the name-only entrance can reach with a body-supplied `Name`
  remains **unmeasured** — v2.15.0 rejects that route when the body sets `Durable` and does not
  overwrite a body-supplied `Config.Name`, but whether it can thereby reach an *existing* consumer
  is a conformance test against a running server, covering durable and named-ephemeral consumers
  with and without `Durable`, not a claim this ADR makes
- **D6a. Wildcard and multi-filter consumers use a different path.** The audit and DLQ readers do
  not send the fully-specified create subject, so D6's argument does not cover them. They bind a
  consumer pre-created by NACK — a separate startup path with its own grant and its own
  conformance test. The `PF_WORK` exact-filter case does not establish their behaviour
- **D7. Platform components sit inside the tenant account as ordinary users with narrow
  permissions.** No platform component gets a wildcard tenant, including the operators and the
  DLQ reporter. **Correcting the first draft, which said the only cross-account credentials are
  `$SYS` break-glass and a hypothetical operator signing key — that is false as soon as D10's
  callout backend is switched on.** There are three standing cross-account authorities, and the ADR
  names all of them: `$SYS`; the **auth-callout service's signing seed**, because the callout places
  an authenticated user into whichever account its signed JWT names (D10); and the **NACK
  controller process**, which holds every tenant's credential Secret at once even though each
  credential is per-tenant (D4). Short-lived JWTs and per-tenant Secrets bound what a *stolen user
  credential* reaches; neither bounds a compromised signer or a compromised controller
- **D7a. The Argo Events bridge is a bus principal like any other, and naming it is what makes
  ADR-045's containment enforceable.** ADR-045 merged after this ADR was drafted and rules that the
  only legal path from the platform bus to a Sensor is a named durable pull consumer declared in
  `charts/nats-config`. It does not say what that bridge is on the bus, and under this ADR it is a
  `BusPrincipal` (D10) inside the tenant account, taking D6a's bind path to a NACK-pre-created
  durable with no consumer-create grant, D5b's explicit stream bind, and D5a's ACK grant scoped to
  its own stream and consumer. **The bridge binds a durable no other consumer shares.** ADR-045
  claims the trigger bus "cannot move `PF_EVENTS` or `PF_AUDIT` state"; that claim is a property of
  the bridge's permissions, not of running a second StatefulSet, because an ack on a *shared*
  durable advances the delivery state every other reader of it depends on. A bridge sharing a
  durable would leave the Argo Events failure domain reaching into the audit record's consumer
  state while every subject permission still reads correct. The bridge's credential is a Secret in
  the Argo Events namespace, which makes it one more `(component, tenant)` pair in D4's count
- **D8. Per-account JetStream limits are mandatory, and this is where ADR-042 and this ADR have to
  agree.** v2.15.0 accepts `jetstream { max_memory, max_store, max_streams, max_consumers }` inside
  a config-file account (`opts.go`), and without it one tenant's streams exhaust the shared file
  store and every account on that peer is refused with `insufficient resources (10047)`. That is the
  bus-wide outage ADR-042 bounds per stream, reappearing one level up. **ADR-042 is now merged
  (#451), so this is a constraint on shipped behaviour rather than a forward note on a draft.** Its
  `maxBytesBudgetFraction` caps a surface's summed `max_bytes` at 75% of the whole file store and
  the chart refuses to render above it. That denominator is correct for exactly one account and
  wrong at the second: applied unchanged, it measures every tenant's streams against the whole
  store, so it passes a configuration in which one account is overcommitted against its own
  `max_store` and admits the 10047 refusal the gate exists to prevent. The budget rule therefore
  moves down a level — per-stream `maxBytes` sums below its **account's** `max_store`, and the
  account `max_store` values sum below the store ceiling with headroom. Homelab's single account
  makes the two arithmetics identical today, which is exactly why the discrepancy is invisible
  until a second account exists; reconciling the gate is owed by this ADR's implementation and
  gates onboarding the second tenant. Note also that storage limits bound storage only — CPU,
  connection count and shared-node contention stay shared-server residual risk
- **D9. The monitoring port is outside the account boundary, and the contract says so rather than
  letting a reader assume otherwise.** `config.monitor` defaults to enabled on port 8222 in chart
  2.15.0, TLS is off, and the v2.15.0 handlers apply no tenant authorization: `/jsz` reports across
  accounts (`accounts=true` for account detail, `streams=true`/`consumers=true` for stream and
  consumer detail, account enumeration paginated) and `/connz` reports connection detail.
  **Correcting the first draft's "the Service exposes it":** rendering the chart shows the ordinary
  `nats` Service publishes only 4222, while `nats-headless` publishes 8222 — and the pod IP is
  reachable either way, so the exposure is in-cluster, not absent. The exporter is a second copy of
  the same problem: `natsio/prometheus-nats-exporter:0.20.1` runs on port 7777 with `-jsz=all`
  (which queries `consumers=true&config=true&raft=true`) and republishes cross-account stream,
  consumer and config metadata to anything that can scrape it. The controls are a NetworkPolicy
  scoping **both** 8222 and 7777 at pod ingress, plus `config.monitor.tls`; TLS is transport
  protection and not authorization, and neither is a substitute for stating the limit. The gate is
  an untrusted-pod denial test alongside an authorized-scrape test
- **D10. The bus credential is a seam, `BusPrincipal -> NATS user`, with one declaration and two
  backends.** The declaration is the seam's artifact: per principal, the subjects it may publish, the
  subjects it may subscribe to, and its `$JS.API` allow-list. The static backend renders it into the
  server's `accounts {}` block, diffable in Git, with the credential delivered as a Secret; it is the
  homelab default. The callout backend renders the same declaration into a short-lived user JWT
  minted by an auth-callout service that authenticates a platform principal — an OIDC subject for a
  human (ADR-028 §3), a projected ServiceAccount token or `AgentIdentity` for an agent (ADR-028 §4).
  One declaration and one conformance suite is what makes this one seam instead of two
  implementations of the same idea; a provider-shaped permission set written per customer is the fork
  ADR-028 exists to prevent
- **D10a. The callout backend's conditions, which are contract and not implementation detail.**
  `allowed_accounts` is always set explicitly and never lists `$SYS` — v2.15.0 delegates **every**
  account when it is left empty (`parseAuthCallout`, `opts.go`), so the secure value is not the
  default. The callout service's signing seed and xkey are custody obligations on the level of
  `$SYS` (D7), the callout exchange is encrypted via `xkey`, and JWT lifetime is bounded.
  Service-side placement checks constrain ordinary callers, not a compromised signer. The tests are
  wrong-issuer, wrong-audience, unauthorized account placement, expiry, callout-service outage and
  signer rotation. **`auth_users` is the bootstrap exemption:** with callout configured the server
  calls out for every user not listed there, including valid static ones, so the NACK and bootstrap
  principals are listed and agent principals never are — and no exempted user holds
  callout-response or signing authority. A static-only deployment may leave callout disabled
  entirely. v2.15.0 also refuses `auth_callout` in FIPS-140 mode, so a regulated deployment takes
  the static backend or operator mode
- **D10b. Revocation and rotation are named mechanisms with stated bounds, not properties inherited
  from short tokens or from the Secret store.** ADR-028 requires testable agent revocation, and
  refusing the next login or waiting for a JWT to expire does not revoke an **established**
  connection; the mechanism and its time bound are stated and tested per backend, or the conflict
  with ADR-028 is resolved explicitly before that backend is accepted. Rotation is a drill, not a
  property of the Secret store: staged new-key publication, Secret delivery, server config reload,
  client and NACK reconnect, old-key removal, and refusal of both new *and* already-established old
  sessions within a stated bound, plus rollback and a `$SYS` recovery path that works while the
  identity service is down. External Secrets and 1Password synchronise material; they do not supply
  this protocol
- **D11. The NATS operator/nsc JWT hierarchy is deliberately not adopted, and the reason is
  reversibility.** Operator mode is all-or-nothing at the server: adopting it forecloses config-file
  accounts entirely and makes every existing credential a reissue.
  `authorization { auth_callout { issuer, account, auth_users, xkey, allowed_accounts } }` parses in
  **config mode** in v2.15.0 (`parseAuthCallout`, `opts.go`), so the dynamic issuance D10 needs is
  available without that commitment. **The custody half of this argument was overstated and is
  withdrawn:** an operator seed can be held offline, and the callout design chosen here has its own
  privileged signing custody (D7, D10a), so this is a choice between two custody obligations rather
  than avoiding one. What survives is the reversibility argument alone, which is sufficient. Operator
  mode remains legitimate where stronger delegated-issuer control is wanted; it is a server-mode
  migration even though the D10 declaration survives it, and the declaration is what makes nsc a
  third backend rather than a rewrite
- **D12. Homelab conforms with one account.** `TENANT_LOCAL` plus `$SYS`, real users, real
  permissions, one credential per component, and `nats-box` holding a named context rather than
  connecting anonymously. The single tenant is what keeps this cheap; the enforcement is what makes
  ADR-026 D5 and ADR-028's peer-implementation claim true instead of aspirational
- **D13. The gate is split honestly between what a static check can see and what only a server can
  settle.** Level 0 can assert, over rendered manifests: that no account grants publish or subscribe
  on `pf.>` or any `pf.*.` form, that no grant exceeds its principal's producer-owned prefixes, that
  every `Stream` and `Consumer` names `spec.account`, that no component credential is the system
  account, that no principal is granted `$JS.ACK.>` or a shared `_INBOX.>`, that `allowed_accounts`
  is non-empty and excludes `$SYS`, and that every consumer-create allow carries the name-only and
  legacy-durable denies from D6 while *not* denying the broad extended form. It cannot assert that
  the server refuses. That is the level-2 conformance suite, run **against the rendered image
  digests rather than a version read from a document**, and it covers: start, create/bind, pull,
  ACK/NAK/TERM and reconnect under the real rendered ACL; refusal of every lifecycle and alternate
  create entrance; cross-*principal* inbox and ACK refusal inside one account, not only cross-tenant
  refusal; the D6 name-only endpoint question; the monitoring and exporter NetworkPolicy
  (untrusted-pod denial plus authorized scrape); the rotation and revocation drill in D10b; and cold
  start on fresh synthetic credentials with no maintainer account, no identity service and no
  anonymous fallback. Per ADR-038 the static gate must not be the only thing that is green
- Normative detail: `docs/contracts/event-contract.md` §5; the seam in
  `docs/contracts/byo-extension-points.md`

**Alternatives Considered:**
- **Leave the bus open inside the cluster and rely on Kubernetes NetworkPolicy** -> honest for
  homelab today and it fails the moment there are two tenants, because a NetworkPolicy cannot express
  "this pod may publish `pf.a.>` but not `pf.b.>`". It also puts the tenancy boundary in a different
  system from the one the contract names, so the contract would have to be rewritten rather than
  implemented
- **One account for everything, with tenancy carried only by per-user subject permissions on the
  `<tenant>` token** -> cheaper, one stream set, one NACK credential. It contradicts ADR-038's
  `workqueue_tenancy` directly: one `PF_WORK` for every tenant plus a consumer-name grammar with no
  tenant token means two tenants' identically-named consumers silently repoint each other's filters,
  which is the destructive silent failure that rule was written to make impossible. Per-consumer
  create permissions (D6) would contain it, and it would still leave a single `max_store` budget and
  a single stream set where one tenant's retention is every tenant's outage
- **Adopt the NATS operator/nsc model now** -> the native multi-tenant answer, with JWT-based account
  and user issuance, revocation lists and per-account limits in the account JWT. Rejected for now on
  reversibility (D11): it is a server-wide mode switch, it makes an operator seed a permanent custody
  obligation, and auth callout delivers the dynamic issuance we actually need in either mode. This is
  the decision most likely to be revisited, which is why D10's declaration is the durable artifact
  and the backend is not
- **Auth callout as the only backend, with no static path** -> one code path instead of two, and it
  puts a service of ours on the critical path of every connection in a single-node homelab, including
  NACK's connection at bootstrap. A forker would need the callout service running before the bus
  would accept anything. The static backend is the boring one and it is the default for that reason
- **A JetStream domain per tenant instead of an account** -> domains separate JetStream namespaces
  for leaf nodes; they do not authorize anything and do not stop a client naming another tenant's
  subject. Wrong tool: it is a topology feature, not a trust boundary
- **Give NACK the system account, as the upstream chart's values suggest** -> one credential instead
  of one per tenant, and it recreates the cross-tenant reach D1 buys, in the one component that can
  delete every stream. The `Account` CRD exists precisely so this is not necessary

**Consequences:**
- **Nothing on the bus is anonymous any more, and that reaches the runbooks.** Every `nats` command
  in `docs/event-backbone.md` currently runs against an anonymous `nats-box`; each becomes a named
  context with a credential. A forker's first bus interaction now requires a secret to exist, which
  is real friction against the fork-ability contract and is why the static backend renders from a
  declaration in Git rather than from a hand-written conf file
- **Credential count is one per (component, tenant), and that is the cost of D1.** With one homelab
  tenant it is a handful of 1Password items; on the commercial surface it is why D10's callout
  backend exists rather than being deferred
- **The PF_WORK alerts are wrong the instant there are two accounts, and this is measured, not
  suspected.** All three rules in the `homelab-nats-jetstream` group select only
  `stream_name="PF_WORK"`, and `PF_WORK` exists once per account. `PFWorkOldestUnackedAging` survives,
  because `changes()` and `min_over_time()` preserve the full label set and `and` matches on it. The
  same defect one dimension out — two NATS **installs** on one Prometheus rather than two accounts in
  one install — is fixed (MCAA-458): both aggregating rules now group `by (stream_name, namespace,
  job)`, and `PFWorkStreamMetricsAbsent` is a per-label-set `unless` rather than a global `absent()`,
  because `absent()` emits neither `namespace` nor `job` and so cannot be joined on them. The account
  dimension is still open: within one namespace the grouping still collapses accounts, so tenant A's
  head advance is netted against tenant B's consumer acks and can both mask a real loss and invent
  one. The exporter carries `account`, `account_name` and `account_id` on every `nats_stream_*` series
  (0.20.1 `collector/jsz.go` lines 95-98, the deployed exporter), so the fix is available: add
  `account` to the existing grouping, after confirming `nats_consumer_*` carries it too — the loss
  rule subtracts a consumer aggregate from a stream aggregate, and a label present on only one side
  breaks the match. Until it does, the multi-tenant path has no working silent-loss alert
- **`docs/event-backbone.md` must state today's reality plainly until this lands** — the bus is
  unauthenticated within the cluster and single-tenant, and the `<tenant>` token is a convention, not
  a boundary. Without that line a reader of the contract would reasonably attach a second tenant to a
  bus that cannot separate them. That is a condition on #438's follow-up, not on this ADR
- **Blast radius, stated per boundary.** A leaked component credential reaches one tenant's bus and,
  under D5, cannot destroy its streams — and under D5a cannot read its neighbours' replies or
  acknowledge their messages either. A leaked NACK per-tenant credential can reshape one tenant's
  stream set. Three authorities are wider than one tenant and each gets its own rotation and
  recovery drill (D7): `$SYS`; the callout signing seed, which can place a user into any delegated
  account; and the NACK controller process, which holds every tenant's Secret at once. The
  auth-callout service being down blocks *new* connections and leaves established ones untouched,
  which is the same bound ADR-028 puts on the identity broker and is why the static backend exists
  for the bootstrap path — and is also why revocation needs its own mechanism (D10b), since that
  same property means an outage does not evict anyone
- **This ADR does not make the platform multi-tenant.** It makes the mechanism the contract already
  names exist, at one tenant, so the second tenant is a configuration change rather than a
  rediscovery. Onboarding a second tenant additionally needs D8's account budget arithmetic, the
  alert-aggregation fix above, and the D6 conformance test actually run
- **What is unverified against a running server is named rather than assumed:** what the name-only
  consumer-create entrance can reach with a body-supplied `Name` (D6); whether NACK 0.35.0's
  `Account` CRD path behaves as documented when a `Stream` moves between accounts; whether an
  updated Secret promptly replaces a cached or already-established NACK connection (D10b); and the
  established-session revocation bound for each backend. All are level-2 tests in the implementing
  change, run against the rendered image digests. ADR-038 exists because the alternative is a green
  gate over a broker that disagrees
- **This ADR was revised after independent review ([MCAA-383](/MCAA/issues/MCAA-383), Security &
  Secrets Engineer, approve-with-conditions).** The corrections are recorded inline above rather
  than as a changelog, but three are worth naming because they change what a reader should trust:
  the first draft reasoned from `nats-server` v2.10.22 rather than the deployed v2.15.0 and
  consequently enumerated a deny list that misses `STREAM.MSG.GET` and `ACCOUNT.PURGE` (D5); it
  claimed `$SYS` and a hypothetical operator seed were the only cross-account authorities, which the
  callout signer and the NACK controller both falsify (D7); and it described the monitoring port as
  exposed on the ordinary Service when it is the headless one (D9). The review's own conditions on
  the implementing PR — rotation drill, cold start, client binding, network scoping — are carried in
  D10b, D13 and §5.2-5.4 of the event contract

### ADR-044: `PF_AUDIT` sources through one entry with two `subjectTransforms`, because two entries from the same origin stream make the exporter's whole scrape un-gatherable (2026-09-28); refines ADR-038

*Numbering note: `main` carried ADR-042 when this was written. ADR-041 is claimed by the open RED-metric-contract branch (MCAA-267) and ADR-043 by the NATS-tenancy branch (MCAA-363), which has since merged as ADR-043 above; both were checked in their worktrees before writing rather than after merging, so this takes 044 per ADR-039. No number is reserved here for anything.*

**Context:**
- ADR-038 replaced `PF_AUDIT`'s own subject filters with two `sources` entries from `PF_EVENTS`, and its last consequence confirmed on a real server that a stream may take two sources from one origin: both filters active, lag 0, no `10065`. That measurement is correct and it answered a **create-time** question. It was then read — by its author most of all — as approval of the shape
- Two e2e steps landed on #438 within an hour of each other: `audit-source-filters`, the #438 conformance review's condition C3, which asserts what the two filters *select*; and `exporter-label-set`, asked for by the SRE & Observability Engineer, which reads the JetStream series the silent-loss alerts consume. Their first completed level-2 run is [36388898714](https://github.com/ryanmcafee/homelab/actions/runs/36388898714) at `c9b88d6`
- C3 passed on its first real execution, both halves and the anti-vacuity guard. `exporter-label-set` failed, and not on a label value. `/metrics` on `nats-0:7777` returns **HTTP 500**, carrying the exporter's own text: `collected metric "nats_stream_source_lag" {... source_name="PF_EVENTS" ... stream_name="PF_AUDIT" ...} was collected before with the same name and label values`, and the same for `nats_stream_source_active_duration_ns`
- The label set the error prints is the whole of it: `account`, `account_id`, `account_name`, `cluster`, `domain`, `is_meta_leader`, `is_stream_leader`, `meta_leader`, `server_id`, `server_name`, `source_api`, `source_deliver`, `source_name`, `stream_leader`, `stream_name`, `stream_raft_group`. **The filter subject is not among them.** Two source entries that differ only in `filterSubject` are indistinguishable to the exporter, and the Prometheus client library answers a duplicate label set by failing the entire gather

**Decision:**
- **Two `sources` entries naming the same origin stream are banned on this bus.** A stream needing more than one filter from one origin takes **one** entry with **two `subjectTransforms`**, which the NACK `jetstream.nats.io/v1beta2` Stream CRD carries as `{source, dest}` pairs — verified against the vendored schema at `tests/schemas/jetstream.nats.io/stream_v1beta2.json`, so this is available on both surfaces with no version move. One entry means one `StreamSourceInfo`, one label set, and a gatherable scrape
- **A stream's effect on the exporter's scrape is part of the stream contract.** A configuration the server accepts and that makes `/metrics` return 500 is a contract violation, reviewed as one. ADR-038 established that a gate green on a configuration the broker refuses is worse than no gate; this is its other half — a configuration the broker *accepts* and that silently removes the ability to observe it
- **The chart change is the implementing engineer's (MCAA-7, #438) and carries condition C4:** the replacement is not proven until a Kind run shows all three of `/metrics` returning 200, exactly one `nats_stream_source_lag` series for `PF_AUDIT`, and `audit-source-filters` still passing both halves. The previous confirmation was right at the layer it measured and wrong as a conclusion; asserting an empty `dest` keeps both filters active, without running it, would repeat that exactly
- **`exporter-label-set` is a required assertion from here on.** It is the only check that can see this class of defect, and it found this one on its first run

**Alternatives Considered:**
- **Give `PF_AUDIT` its own non-overlapping subject filters** -> `10065`, the refusal ADR-038 exists to fix. Already settled
- **Split into two audit streams, one source each** -> gatherable, and it doubles the operator surface, splits the sequence space, and turns "every identity and control event in order" into a two-stream reconciliation. That is the cost ADR-038 declined, reintroduced to work around a label
- **Widen to one source filtering `pf.*.*.*.*.*.ev`** -> one entry, one label set, and `PF_AUDIT` becomes a full second copy of `PF_EVENTS`. It discards the retention isolation ADR-042 paid for and doubles audit storage against a `max_bytes` sized for a subset
- **Patch `prometheus-nats-exporter` to label sources by filter subject** -> the correct upstream fix, and the wrong dependency for us to hold. A fork pulling the released exporter still breaks. Worth filing upstream; not worth blocking a chart on
- **Accept the 500 and read JetStream state some other way** -> there is no other path in this deployment, and the alerts read exactly these series

**Consequences:**
- **The blast radius is every JetStream series from that exporter, not the source metrics.** A Prometheus gather is all-or-nothing, so `nats_stream_first_seq`, `nats_stream_total_messages` and `nats_consumer_ack_floor_stream_seq` are all absent while the condition holds. ADR-038's silent-loss alert and ADR-042's file-store alert read series that are not there, and the only rule that can fire is the absence alert that exists for this shape of failure. The disk isolation ADR-038 bought was paid for with the broker's entire observability surface, and the invoice arrived three weeks later
- **It shipped invisible and stayed invisible through every gate we had.** `PF_AUDIT` has carried two sources since the chart landed; level 0 renders, and levels 1-2 asserted a `Ready=True` Stream, which it genuinely is. Nothing read `/metrics` until the SRE asked for it. A resource that is healthy by its own conditions and breaks the process observing it is not a shape any CR-condition assertion can see
- **The reopening clause retired in ADR-038's last consequence stays retired, and the condition it left open is now closed.** The filters do select what the contract says: an `identity` event reached `PF_AUDIT` and the `workload` event already in `PF_EVENTS` stayed out of it, with the presence-in-origin guard asserted first so the exclusion could not pass on an empty bus
- **One residual gap in that negative half, non-blocking.** It concludes "absent" from a read whose body lacks `"correlationid"`, and the read that produced it exited 1 with `no message found (10037)`. Any *other* error on that invocation is also a body without `"correlationid"`. The positive half runs the same command first and so covers a broken invocation form, which leaves only argument-specific failures — narrow, real, and closed by requiring `10037` specifically rather than accepting any error
- **Record the layer with the measurement.** "Confirmed on a real server" meant create-time acceptance and was written without naming that bound, which is how it came to be read as clearance for the shape. Every future confirmation of this kind names what it measured and what it did not
### ADR-045: Argo Events runs its own JetStream; the platform bus is reachable only through a named durable pull consumer, and the trigger bus states its own weaker guarantee (2026-09-28); refines ADR-026 and applies ADR-042

*Numbering note: `main` carried ADR-042 when this was written, with 034 and 041 as open gaps. 034 is claimed by the deployment-DAG branch (#368), 041 by the RED-metric-contract branch (#433, as ADR-042's own note records), 043 by the bus-tenancy branch (#455) and 044 by the audit-source-collision branch (#461); 046 (#362) and 047 (#399) sit above. All were re-checked at this branch's head rather than at writing, so this takes 045 per ADR-039. No number is reserved here.*

**Context:**
- #464 deploys Argo Events with an `EventBus` of its own, on its own storage, in its own namespace. That is a topology decision — the platform gains a second JetStream — and it was written in a pull-request description and a `docs/event-backbone.md` section, not in this record. Under **write before meeting** the decision was therefore not yet made, and the engineer was building against an unwritten one. This ADR is that decision, written after reading the branch rather than the prose
- The reasoning in #464 is sound and this ADR ratifies it: the platform bus is the durable record (168h of `.ev`, 8760h of `PF_AUDIT`, replayable from sequence one), while the Argo Events bus is trigger plumbing where a Sensor falling behind and catching up is normal operation. Putting triggers on the platform bus would let a Sensor's consumer state and a workflow's retries move stream state an audit reader depends on
- **The claim the whole design rests on is that an `EventBus` `streamConfig` merges over the chart's controller-config rather than replacing it.** If it replaced, an `EventBus` setting only `maxAge` would discard the controller-config's `replicas` and `maxBytes` and reintroduce both failures #464 exists to prevent. Verified at source, not accepted from the comment: `pkg/reconciler/eventbus/installer/jetstream.go` (v1.9.11, the `appVersion` of chart 2.4.27) reads the controller-config into viper and then calls `MergeConfig` with the `EventBus` value. It is a real merge
- Rendering chart 2.4.27 with this repository's overrides confirms what the merged config is: `maxMsgs: 1e+06`, `maxAge: 72h`, **`maxBytes: 1GB`**, `replicas: 1`, `duplicates: 300s`, **`retention: 0` (limits)**, **`discard: 0` (old)**
- **That combination is a materially weaker delivery guarantee than any platform stream, and nothing states it.** A `limits` stream with `discard: old` drops the *oldest* trigger when it reaches either bound, and there is no dead-letter path for what it drops. A Sensor down longer than 72h, or behind when the stream reaches its byte ceiling, loses triggers silently. `docs/event-backbone.md` states a guarantee for every platform stream precisely so no reader has to assume one, and the one bus whose guarantee is weakest is the one with no row
- **`maxBytes: 1GB` is inherited from an upstream chart default, not chosen by an operator** — while `replicas`, `version`, `maxAge` and storage size for the same bus are all explicit in `configuration/templates/helm-addons.tmpl`. ADR-042 established for the platform streams that an unlimited or unconsidered byte ceiling makes a `discard` policy decorative and its failure shared; the same argument reaches this bus, and ADR-042's scope does not. It bites hardest on localdev, where the PVC is `1Gi` and a single stream's ceiling of `1GB` is 93% of it, leaving less headroom for JetStream's index and metadata than ADR-042's own headroom rule requires
- **Enabling the admission webhook widens a trust boundary in a way the diff does not show.** The webhook is justified — all three `argoproj.io` CRDs declare `spec` and `status` as `x-kubernetes-preserve-unknown-fields`, so the API server accepts any spec and the vendored kubeconform schemas can confirm only that the kind is known. But rendering the chart with `webhook.enabled=true` produces a ClusterRole, a ClusterRoleBinding, a Deployment and a Service, and **no `ValidatingWebhookConfiguration`**; upstream's own `manifests/extensions/validating-webhook/` contains none either. The admission object is created at runtime by the webhook process, which holds `admissionregistration.k8s.io/validatingwebhookconfigurations` create/update/delete/patch
- Consequently the admission rules and their `failurePolicy` are runtime state, not GitOps state: ArgoCD cannot diff them, no level-0 gate can read them, and `argoproj.io` is the group ArgoCD's own `Application` and `AppProject` live in. What decides whether a webhook outage is contained to Argo Events or reaches cluster GitOps is the *rule scope* -- which kinds the webhook asks to intercept -- with `failurePolicy` deciding only what happens to kinds already in scope. Neither can be read from the repository at any head, and the measurement in the Consequences below is what settles both
- **The runtime object is not orphaned, which is the one part of "GitOps does not describe it" that turned out to be too strong.** The registered configuration carries `ownerReferences` to `ClusterRole/argo-events-webhook` with `controller: true` and `blockOwnerDeletion: true`, and that ClusterRole *is* a chart resource under ArgoCD management. So ArgoCD cannot diff or directly prune the admission object, but pruning the ClusterRole garbage-collects it: setting `webhook.enabled=false` removes the rules rather than stranding them. Owner and dependent are both cluster-scoped, so the reference is valid and the collection is real. **That holds only where the prune actually happens.** `charts/addons/templates/argo-events.yaml` emits `automated.prune` only under `global.automatedSync`, which `helm-addons.tmpl` derives from `ARGOCD_AUTOMATED_SYNC` and documents as off where the working tree is pushed with `argocd app sync --local`. With automated sync off, `webhook.enabled=false` leaves the Application OutOfSync, the ClusterRole is never deleted, and the admission object *is* stranded -- the operator has to prune it deliberately. **Reversibility** is therefore intact where this ADR assumed it was not, but it is *deletion* reversibility on an automated-sync surface, not drift reversibility, which the Consequences below treat separately
- The webhook ClusterRole also grants cluster-wide `secrets` get/list/create/update/delete/patch/watch. This is **not** a new capability for the namespace's trust domain — the argo-events controller ClusterRole already holds cluster-wide `secrets` create/get/list/update/patch/delete — so the genuinely new privilege is admission-configuration mutation, not secret access
- `spec.jetstream.version` is pinned to `"2.10.29"` as a literal in `helm-addons.tmpl`, while the chart version beside it comes from `configuration/versions.yaml` and is Renovate-managed. The pin resolves today: `2.10.29` is a real `version` key in chart 2.4.27's `configs.jetstream.versions`, mapping to `nats:2.10.29`

**Decision:**
- **Argo Events gets its own JetStream. Two buses is the ratified topology, not duplicated infrastructure.** The separation is by *purpose*, not by tenant: a durable, replayable record on one side, disposable trigger plumbing on the other. **Shared bones, not copies** is not violated because these are not two implementations of one concern — they are two concerns with different retention, different guarantees and different blast radii, and merging them would couple audit durability to workflow retry behaviour
- **The only legal path from the platform bus to a Sensor is a named durable pull consumer declared in `charts/nats-config`.** `no_core_nats_bridge` in `contracts/events/subjects.v1.yaml` already says this; this ADR states why it must not be relaxed. An Argo Events `nats` EventSource is a core-NATS subscribe — at-most-once, no durability, no replay — so pointing one at a `.ev` subject silently converts an at-least-once path into an at-most-once one. Neither Argo Events' documentation nor its status conditions report the downgrade. **Delivery-guarantee honesty** forbids a mechanism whose guarantee changes invisibly at the point it is configured
- **The trigger bus declares its own guarantee, in the same table as every platform stream, and that guarantee is weaker.** Triggers are at-least-once *while within bounds* and are dropped oldest-first on reaching `maxAge` or `maxBytes`, with no dead-letter path. Every Sensor is idempotent on its trigger, exactly as every platform consumer is idempotent on `(source, id)`. A row that says "Argo Events' internal guarantee" is not a stated guarantee
- **The trigger bus's `maxBytes` is operator-supplied like every other knob for it**, set in `helm-addons.tmpl` beside `replicas`, `version`, `maxAge` and storage size, and sized against the PVC that bus actually gets rather than inherited from a chart default. This is ADR-042's rule, applied to the bus ADR-042's scope excludes
- **No platform subject, envelope or guarantee is changed by this bus, and none may be added to it.** The `.ev`, `.wq`, `.dl` and `.rq` taxonomy of ADR-026 stays on the platform bus. The moment anything bridges the two, that bridge is a named durable pull consumer, declared in `charts/nats-config` like every other one, and documented in `docs/event-backbone.md` before it ships
- **Enabling the admission webhook is accepted, because a gate that cannot fail reads as coverage** — the ADR-038 finding one level out. It is accepted *with* its cost written down: a cluster-scoped admission object GitOps cannot diff, created by a controller holding the privilege to rewrite admission configuration. That cost is recorded here rather than discovered later
- **`failurePolicy: Ignore` costs the *guarantee*, not the validation, and this ADR's first wording of that was wrong.** Saying the webhook "fails open" invites the reading that it validates nothing, which is false: `failurePolicy` governs only what the API server does when the *call* to the webhook errors -- it is unreachable, the call times out, TLS fails, or a running webhook returns 5xx or an unparseable `AdmissionReview` -- while a reachable webhook answering `allowed: false` rejects under either policy. It did reject -- the first Kind run carrying a `dlqTrigger` was denied with `admission webhook "webhook.argo-events.argoproj.io" denied the request: invalid Sensor: atLeastOnce must be set to true within the dlqTrigger`, across all three retries, in the level-2 job of [run 36418115602](https://github.com/ryanmcafee/homelab/actions/runs/36418115602/job/108914185524) at `8176dbc` on #474 -- the exact defect ADR-049 exists to forbid, caught before ADR-049's own static gate merged. That run is cited because #474's later heads carry the fix and no longer reproduce it. What `Ignore` actually removes is the *promise*: within the 10s `timeoutSeconds`, or during a webhook rollout or restart, a malformed `EventBus`/`EventSource`/`Sensor` is admitted silently. So admission here is real validation with a window in it. That is why it is worth enabling **and** why a static gate over the rendered manifests is still required -- the gate must not depend on a window that nothing here watches
- **The image pin behind the bus belongs in `configuration/versions.yaml`, not as a literal in a template.** A pin the version-management system cannot see does not get bumped, and its failure is invisible statically: the CRD is schemaless, so an unresolvable version renders clean, passes level 0 and fails only at reconcile

**Alternatives Considered:**
- **One bus for everything, with Argo Events pointed at the platform NATS** -> the option this ADR exists to reject. It saves a StatefulSet and a PVC, and it couples the audit record's stream state to Sensor consumer state and workflow retries. The failure is not loud: an audit reader sees a stream that moved, with nothing naming the cause
- **One bus, with Argo Events isolated by NATS account and subject permissions** (the mechanism on the open tenancy branch, #455) -> genuinely stronger than the naive shared bus, and it addresses tenancy rather than the problem here. It does not separate *retention*: both workloads still share one file store, so a trigger backlog still consumes the disk the audit record is budgeted against, and ADR-042's shared-store failure (`insufficient resources`, 10023) still refuses writes for both. Worth revisiting if the operational cost of two StatefulSets ever outweighs that, but the isolation being bought here is storage, not identity
- **Leave the trigger bus's guarantee unstated as "Argo Events' internal concern"** -> what #464 proposed. It is the one thing this ADR will not accept. The boundary is inside this platform, a dropped trigger means a workflow that silently never ran, and "internal" is how a guarantee stops being anyone's to state
- **Accept the inherited `maxBytes: 1GB`** -> it is a *bounded* default, so this is far from the unbounded shape ADR-042 attacked, and the argument for taking it is real. It is rejected because the number is unexamined rather than wrong: nobody compared it to the PVC, and on localdev the comparison is 93%. An operator raising the bus PVC would also not know this ceiling exists to raise
- **Ship an explicit `ValidatingWebhookConfiguration` in `charts/argo-events-config` so the admission rules live in Git** -> the right instinct, and it collides with the webhook process that creates and patches that object itself. Two writers to one cluster-scoped resource is an ArgoCD sync loop, which is worse than the visibility gap. The gap is closed by recording the runtime `failurePolicy` instead
- **Leave the webhook disabled, as the chart ships it** -> then the three schemaless CRDs have no validation at all and level 0's CRD gate confirms only that the kind is known. That is the shape ADR-038 named: a gate green on a configuration it cannot actually check

**Consequences:**
- **#464 is approved with conditions, not merged as-is.** The conditions are: state the trigger bus's guarantee as a row in the `docs/event-backbone.md` table; move `maxBytes` into `helm-addons.tmpl` sized against each surface's PVC; move the `2.10.29` pin into `configuration/versions.yaml`; and capture the self-registered webhook's `failurePolicy` and rule scope from the level-2 run that the other open conditions already require, so the blast radius is a recorded fact rather than an assumption. **That last condition is discharged** — the measurement is in the bullet below
- **The blast radius of the trigger bus is now named.** Its failure stops *triggers* — workflows do not start, and a Sensor behind by more than 72h loses what it missed. It cannot stop platform publishes, cannot move `PF_EVENTS` or `PF_AUDIT` state, and cannot consume the platform file store. That containment is the entire return on running a second StatefulSet, and it holds only while `no_core_nats_bridge` holds
- **The blast radius of the admission webhook is now named, and it is the contained case.** As this bullet was first written the registration had never been observed, so it stated both branches: `failurePolicy: Fail` over the whole `argoproj.io` group would let a webhook outage block writes to ArgoCD's own `Application` and `AppProject` and take GitOps down with it, while a scope of `eventbus`/`eventsources`/`sensors` contains the failure. The registration was read verbatim off the level-2 job of [run 36413556910](https://github.com/ryanmcafee/homelab/actions/runs/36413556910/job/108899215084), which passed, measured at commit [`1954632`](https://github.com/ryanmcafee/homelab/commit/19546320a1472fb85ea629a8e1bb12cbffb4c641) on #464: **one webhook, `webhook.argo-events.argoproj.io` at chart 2.4.27, `failurePolicy: Ignore`, `sideEffects: None`, `timeoutSeconds: 10`, and three separate single-resource rules over `argoproj.io/v1alpha1` for `eventbus`, `eventsources` and `sensors` on CREATE/UPDATE/DELETE.** `applications` and `appprojects` are absent, and there is no wildcard rule -- the two ways this rule set could have reached ArgoCD's own kinds, neither of them taken. That is one property established twice, not two independent safeguards: if a rule widened, nothing else here would contain it. Still, it is the property that matters, and it means the containment does not rest on `Ignore` alone -- **with the rules as measured**, a flip to `Fail` on its own would only refuse writes to the three Argo Events kinds. This describes the configuration #464 ships -- `argo-events` is not in `helm-addons.tmpl` before it merges, so no earlier head registers anything at all
  - **`Ignore` narrows what enabling the webhook actually bought, and `docs/event-backbone.md` says so in those words.** When the call to the webhook errors -- the pod is unavailable, the call exceeds the 10s `timeoutSeconds`, or a running webhook answers 5xx -- the API server admits the object anyway, so during a webhook rollout or restart the webhook only shortens the window in which a malformed Sensor reaches runtime; it does not make these schemaless CRDs validated the way a schema would. **That window is unobserved here, not unobservable anywhere.** Kubernetes does record a fail-open: the API server increments `apiserver_admission_webhook_fail_open_count{name,type}` and annotates the audit event with `failed-open.validating.webhook.admission.k8s.io/round_X_index_Y`. Nothing in this repository scrapes or alerts on either, which is what makes the window invisible *on this platform* -- and which makes that metric the available way to close the gap, a hand-off to the SRE & Observability Engineer alongside the bus-metrics one below. The ADR-038 justification above still holds: a gate that cannot fail reads as coverage, and this one can fail while it is up. "Fails open" is not the phrase for that, for the reason the Decision bullet above gives -- a reachable webhook that answers validates and rejects under either policy, so what `Ignore` removes is the *promise*, not the validation -- and `docs/event-backbone.md` states the narrowing rather than letting "the admission webhook is the only validation" read as stronger than it is
- Wave ordering makes the mild case reachable on every fresh install too — wave 12 installs the webhook, wave 13 creates the `EventBus` through it — and ArgoCD's retry is what absorbs that, not the design. With the measured `Ignore` that retry is not even needed for correctness, only for the `EventBus` to be validated rather than admitted unchecked
- **The rule scope is runtime state, so naming it once does not keep it named.** Nothing in the repository constrains what the webhook registers; a chart bump could widen the rules to the group or flip the policy to `Fail`, and no level-0 gate could see it. **The level-2 assertion does not close that, and it is worth being exact about how little it covers.** Its predicate is a conjunction -- it fails only on a wildcard resource *and* `failurePolicy: Fail`. Since the measured policy is `Ignore`, the wildcard arm cannot fire in the state that actually ships: today the check passes on any rule set, wildcard included. And under `Fail` it still passes an explicit widening to `applications`/`appprojects`, because that is not a wildcard -- which is precisely the widening this ADR cares about. What it genuinely covers is one corner: wildcard and `Fail` together. Closing the gap means asserting the resource set *equals* `eventbus`/`eventsources`/`sensors` and dropping the `Fail` conjunct; until that lands, this bullet rests on the measurement above and not on a gate. Either way the assertion reads runtime state on a Kind cluster rather than anything in Git, so the gap's shape is permanent even once its coverage improves
- A fork now sizes one more number (the trigger bus `maxBytes`) and gets a default for it, and gains a second JetStream StatefulSet and PVC. On a single node that is a real cost, and it is the price of the containment above. `replicas: 1` is honoured by Argo Events without clamping, so a single-node fork runs the bus standalone rather than in a degraded cluster
- **Two buses means two sets of stream metrics, and only one of them has alerting.** The platform streams' storage and lag alerting is MCAA-8's; nothing watches the Argo Events bus approaching `maxAge` or `maxBytes`, which is exactly the state in which it starts dropping triggers. That is a hand-off to the SRE & Observability Engineer, and it is the runtime half of this ADR in the same way ADR-042's file-store alert is the runtime half of that one
- `argoproj.io` is now the first API group in `tests/gitops/crd-providers.yaml` with more than one provider Application, resolved with per-kind overrides rather than by moving the group default, because `argo-workflows` and `argo-events` are independently enabled. Any third `argoproj.io` provider inherits that shape
- **The exactly-once statement of ADR-026 is unchanged and now covers one more bus: no path is exactly-once end to end.** The trigger bus does not weaken that claim, it extends the set of paths it applies to

### ADR-049: A Sensor's dead-letter trigger is enforced reachable, or it is not a dead-letter path (2026-09-28); refines ADR-045 and applies ADR-026's delivery-guarantee honesty rule

*Numbering note: `main` carried ADR-045 when this was written. 034 is claimed by #368, 041 by #433, 043 by #455, 044 by #461, 046 by both #470 and #362 (a collision those two branches own, not this one), 047 by #399 and 048 by #476 — each checked by grepping `### ADR-` headings in the open branch, not citations, because a cross-reference to another ADR matches a naive search and makes a free number look taken. 049 is the lowest number free of all of them. No number is reserved here; if another branch lands first this renumbers during the rebase per ADR-039.*

**Context:**
- #474 adds the platform's first `Sensor`. ADR-045 stated the trigger *bus*'s guarantee; it did not state the guarantee of the hop **after** the bus — Sensor to trigger execution — because until #474 nothing in the repository took that hop. This ADR states it, and it exists because two upstream defaults make that hop weaker than the field names suggest
- Read at argo-events **v1.9.11**, the `appVersion` of chart 2.4.27 (confirmed from `charts/argo-events/Chart.yaml` at tag `argo-events-2.4.27`, not assumed from the chart version — ADR-042's own lesson)
- **`atLeastOnce` defaults to `false`, so a trigger is at-most-once unless it opts in.** `pkg/apis/events/v1alpha1/sensor_types.go:260` carries `+kubebuilder:default=false` and the field's own doc comment says "Defaults to false. Trigger execution will use at-most-once semantics." `pkg/sensors/listener.go:372` is the branch: with `AtLeastOnce` true `triggerActions` returns the blocking call, and with it false it launches a goroutine and **returns `nil` immediately**
- **A `dlqTrigger` configured under that default cannot run.** The DLQ is invoked from `listener.go:214`'s `actionFunc`, inside the `err != nil` branch of the `DoWithRetry` loop wrapped around `triggerActions`. When `triggerActions` always returns `nil`, that loop never errors, so the `trigger.DlqTrigger != nil` branch at `listener.go:225` is dead code. A field is set, a reader concludes there is a dead-letter path, and there is none
- **The same defect recurs one level inside the fix, and #474 currently has it.** `dlqTrigger` is itself a `*Trigger` with its own `AtLeastOnce`, also defaulting false. The Sensor at `8176dbc` sets `atLeastOnce: true` on the main trigger but not on the `dlqTrigger`, so `triggerActions(ctx, sensor, events, *trigger.DlqTrigger)` at `listener.go:233` returns `nil` immediately too. `dlqErr` is therefore always `nil`, the `failed to trigger dlqTrigger` error at `listener.go:237` is unreachable — and the consequence that matters is not the missing log line: **`actionFunc` returns and the message is acked while the dead-letter write is still in flight and may yet fail.** The envelope is acked as handled before anything knows it was dead-lettered
- **Being precise about what is and is not invisible:** upstream does bump `ActionRetriesFailed` and log `Failed to execute a trigger` from inside that goroutine (`listener.go:380-392`, added for argoproj/argo-events#3947), so a failing fire-and-forget DLQ is not *unobservable* — `action_retries_failed_total` moves. What does not exist is any **ordering** between that failure and the ack. The metric says something failed; nothing holds the message until the dead-letter write lands. That is the silent-loss window, and overstating it as "no signal at all" would be wrong
- **`retryStrategy` unset means one attempt, not no limit.** `listener.go:215` substitutes `Backoff{Steps: 1}` whenever it is nil. This is honest rather than broken, but it is not what "defaults to no retry" suggests to a reader who has not read the substitution
- Nothing in the repository can currently catch any of this. Both CRDs declare `spec` as `x-kubernetes-preserve-unknown-fields`, so a Sensor with a dead DLQ renders clean, passes level 0's schema gate, and reports no condition saying so. The admission webhook cannot help either: ADR-045's amendment records it as `failurePolicy: Ignore`, which fails open, and upstream does not validate this coupling at any policy

**Decision:**
- **On this platform, a Sensor trigger that declares `dlqTrigger` must set `atLeastOnce: true`, and that `dlqTrigger` must set `atLeastOnce: true` as well.** The rule is recursive because the defect is. Either both are set and the dead-letter path is real, or the `dlqTrigger` field is removed and the trigger is honestly fire-and-forget. A `dlqTrigger` that cannot be reached is forbidden, because a configured DLQ is exactly the thing a reader trusts without re-deriving it
- **The rule is one-directional, and deliberately so.** A Sensor that sets neither field is legal: at-most-once, fire-and-forget, no DLQ promised. `atLeastOnce: true` with no `dlqTrigger` is legal: retries, and a failure surfaced as an error and a metric. `retryStrategy` is **not** required — one attempt followed by a reachable DLQ is a coherent design, and requiring a retry budget would reject an honest document to no benefit. The invariant forbids one shape only: the claim of a dead-letter path that cannot be taken
- **Enforcement is a level-0 contract test over the rendered snapshots, not documentation and not admission.** It walks every `kind: Sensor` in `tests/snapshots/*/` and applies the rule to every trigger and every nested `dlqTrigger`. Snapshots are the right input because they are what actually ships on both surfaces, the check is network-free so it belongs in level 0, and it catches a Sensor added to *any* chart rather than only the one that happens to define the helper
- **The gate must report the number of Sensors and triggers it inspected, and must carry a fixture-based negative case that proves it rejects the dead-DLQ shape.** A rule whose subject list can be empty passes by vacuity, and this thread has now produced four instances of that failure class — an inert `maxBytes`, a jsonpath that yielded nothing, a promtool negative assertion against an absent rule group, and the coverage guard that could not fire cold. The gate for this rule will not be the fifth
- **The inspected-count is reported, not asserted `>= 1` against the production render.** `selfTest.enabled: false` is a supported configuration that legitimately renders zero Sensors, so a hard minimum on the real render would fail an honest fork. The proof that the rule can fail belongs to the fixture, which always has a Sensor in it
- **`docs/event-backbone.md` carries the Sensor → trigger hop as its own row, with both variants stated** — at-most-once by default, at-least-once only with `atLeastOnce: true` — in the same table as every platform stream. ADR-045 established that a guarantee nobody states is a guarantee nobody owns; this is the hop that inherits that rule
- **No platform subject, envelope, stream or guarantee changes.** This constrains how a Sensor may be written; it does not touch `.ev`, `.wq`, `.dl` or `.rq`, and `no_core_nats_bridge` is untouched

**Alternatives Considered:**
- **Document the coupling in the Sensor's comments and rely on review** -> what #474 does today, and the comments there are accurate and well-written. Rejected because the trap is precisely that the configuration *looks* correct: the next Sensor is written by copying a working one, or by a forker reading upstream's docs, and neither path passes through this review. A comment is not a gate
- **Require `atLeastOnce: true` on every Sensor trigger** -> simpler to state and simpler to check, and rejected because it forbids an honest document. `atLeastOnce: true` makes the trigger a blocking call that the ack waits on, which is a real throughput and head-of-line cost; a notification-shaped trigger that nobody dead-letters is legitimately fire-and-forget. Constrain the shape that lies, not the shape that is merely weak
- **A Helm render-time guard in `charts/argo-events-config/templates/_helpers.tpl`**, matching the `assertMaxBytesBudget` idiom already there -> the right instinct and a good fast failure, but it is not sufficient as *the* gate: it only sees Sensors authored in that one chart, and a fork's own Sensor in its own chart escapes it entirely. Worth adding as defence in depth because it is nearly free; the snapshot test is what makes the rule true
- **Rely on the admission webhook** -> it is `failurePolicy: Ignore`, so it fails open, and upstream validates no such coupling at any policy. Enabling it was justified for other reasons (ADR-045); it cannot carry this
- **Treat it as an upstream bug and wait for a fix** -> reasonable, and it does not help now. The reachability coupling is at least partly intentional upstream: `DlqTrigger`'s own doc comment reads "if the trigger fails to execute atLeastOnce, the dead letter queue (DLQ) trigger will be invoked", which states the precondition without enforcing it. Reversible either way — if upstream later defaults or validates this, the gate becomes redundant and is deleted, which is the cheap direction to be wrong in

**Consequences:**
- **#474 does not merge until the Sensor's `dlqTrigger` sets `atLeastOnce: true` and the contract test exists.** This is a blocking condition on a PR whose analysis was otherwise correct and better than the review that prompted it; the condition is the recursion the analysis stopped one level short of
- **The Argo Events DLQ path is now reachable and still unexercised, and that distinction is the whole point of this ADR.** Proving it needs a *failing* trigger, and a `log` trigger cannot fail. Until a chainsaw step drives a trigger that genuinely errors, "DLQ configured" is the honest claim and "DLQ proven" is not — exactly the line the platform bus already holds, where redelivery and max-deliveries exhaustion are proven and DLQ republish is explicitly not
- **A forker adding a Sensor now gets a failing gate that names the reason**, instead of a dead DLQ that renders clean and reports nothing. The rule is identical on both surfaces and reads from both snapshot directories, so homelab and the commercial golden path cannot drift on it — **shared bones, not copies**
- **Blast radius of the shape this forbids:** a trigger whose work silently never happened, with the message acked. It does not cross the platform bus, cannot move `PF_EVENTS` or `PF_AUDIT` state, and is bounded to the workflows that Sensor starts. It is a correctness failure with a narrow reach, which is why a contract gate is the proportionate response rather than a redesign
- **Runtime half, and it is the SRE's not mine:** a `dlqTrigger` that fails *after* the ack is visible only as `action_retries_failed_total` moving for that trigger name. Nothing alerts on it. That is the trigger-execution companion to the bus-bounds alerting already handed over, and it is a hand-off, not a thing this ADR builds
- **`atLeastOnce: true` is now on the platform's critical path for any Sensor with a DLQ, and it costs latency by design** — the ack waits for the trigger and its retries. An operator sizing `ackWait` on the trigger bus has to account for `retryStrategy.steps × duration × factor`, and a retry budget longer than `ackWait` gets the message redelivered while the first attempt is still retrying. Idempotency on the trigger is what absorbs that, which ADR-045 already requires of every Sensor
- **The exactly-once statement is unchanged: no path is exactly-once end to end.** This ADR adds a hop to the set that statement covers and strengthens one of them from at-most-once to at-least-once by configuration; it does not create an exactly-once path anywhere

### ADR-051: The status page's back end -> UI boundary is a contract, and a lost signal may not retract a fault the page can prove (2026-09-28); applies ADR-027 and ADR-030 to #41

**Context:**
- The status page (#41) has two owners by design: the SRE & Observability Engineer owns the Prometheus/Alertmanager reads and the alert wiring, the Senior Application Engineer owns the React UI. Neither half can be built against a guessed shape, and MCAA-419 was raised to settle the boundary before either started
- `docs/contracts/sdk-boundary.md` Sec. 2 already requires the contract and its tests to land before the implementation. This is the first surface where that rule is applied to a boundary that is not the platform API or the event bus, so it is also the precedent for how a per-surface contract is filed
- A status page is the one surface whose failure mode is *being wrong while being read*. A visitor loads it during the incident, so an over-claim of health is not a cosmetic defect — it is the product failing at the only moment it is used
- Two thirds of the components this repository ships have no instrumented SLI. Any contract that cannot express "not measured" will be satisfied by a green tile, because green is the default a nullable number decays to
- `configuration/schema/*.yaml` is a flat map of scalar keys with `description`/`required`/`default`/optional `enum`. All eight schema files were checked: there is no `type:` key in any of them and no array or object form. A component taxonomy with ids, display names, groups and application mappings cannot be expressed there

**Decision:**
- The boundary is `contracts/status/status-page.v1.yaml` — OpenAPI 3.1 for the HTTP shape, plus an `x-status-page` block carrying the rules OpenAPI cannot express — with a normative companion at `docs/contracts/status-page-contract.md` and consistency tests in `scripts/status-contract_test.ts`. This is deliberately the same shape as `contracts/cluster/topology.v1.yaml` (ADR-035); matching the existing precedent is worth more than any filing improvement
- **A per-surface contract gets an ADR.** It was first filed with a table caption asserting that per-surface contracts "carry no ADR of their own", which is a governance rule minted in a caption, contradicts ADR-035, and would by its own logic need an ADR. Registration is in **both** indexes: `contracts/README.md` for the machine-checkable artifact and `docs/contracts/README.md` for the normative document
- **One polled JSON document**, not SSE and not browser-side PromQL. The data cannot move faster than Prometheus' evaluation interval, so a stream delivers nothing sooner at the cost of a connection per visitor and a reconnect state machine. `pollAfterSeconds` is server-sent so cadence stays the producer's. Browser PromQL is rejected twice over: it puts Prometheus on the public path, and on an unauthenticated endpoint every query string is published cluster inventory
- **The component taxonomy is fixed in the contract, not the ConfigSet, and that is not a fork-ability regression.** The ConfigSet cannot hold the structure (see Context), and "Media" is a category rather than an operator's name, so ADR-029 does not ask for it to be configurable. What is genuinely operator-specific — the hostname and the page title — stays in the ConfigSet. The contract test asserts every mapped application still has a chart template, which is what stops the map becoming fiction after a rename
- **The page never claims more coverage than exists, and it is enforced rather than documented.** `operational` with `coverage.mappedAlertCount == 0` fails the contract test; a component nothing measures reads `unknown` with `no_signal`. `uptime.ratio` and every bucket are nullable with a required `unavailableReason`, and a headline percentage requires a full window of measured days — no synthesized history, and no "99.9% (of three days)"
- **A lost signal invalidates a claim of health; it does not retract a fault the page can still prove.** This is the correction the review produced and it is the reason this ADR exists rather than a line in the contract. The first revision evaluated `signal_unavailable` first and enforced it as a biconditional, which made it a *contract violation* to report `ingress: down` when Prometheus was unreachable and Alertmanager still held the firing critical. The page would have rendered every tile `unknown` above a live critical incident in its own feed. The premise was right — a frozen "nothing is firing" is not evidence of health — but it over-applied to a frozen "something IS firing", which is still evidence of a fault. So `alert_firing` is evaluated first and the rule is asymmetric: **`unknown` is the floor for unproven health, never a ceiling on proven fault**
- **Every derived field declares which upstream it depends on, and there are three of them.** `state` depends on Alertmanager and Prometheus (Prometheus evaluates the rules, so without it a responding Alertmanager serves a frozen view), `uptime` on Prometheus, `incidents` on Alertmanager. `incidents` was missing from the first revision, which meant an unreadable feed served `[]` — and the contract told the UI to render an empty feed as "no incidents in the last N days". The one document whose incident source was unreadable was the one affirming calm
- **A tile may not read better than the feed beneath it.** A component named by a firing incident reads at least that incident's `severityToState`. `info` maps to null and constrains nothing, preserving the feed-only rule. Without this, a red banner and a green tile for the same service satisfied every other invariant — the same defect as `operational` without a mapped alert, one level up
- **`maintenance` is a nullable overlay, not a fifth state.** A component genuinely broken during a declared window still reads `degraded` or `down`. A window that can replace a state is a mechanism for hiding outages, and it is the one status pages reach for
- **The path is the major**, per `sdk-boundary.md` Sec. 5. `schemaVersion` is retained but demoted in the contract's own words to an echo of the path major and pinned to it by invariant, because two majors that can disagree is a defect nothing catches. It is paired with an explicit **consumer must-ignore rule**: `additionalProperties: false` binds the producer and this repository's fixtures, and a consumer validating a live response strictly against a bundled schema copy would break on the first additive field — which would make the additive compatibility promise false against the very UI the contract was written for
- **Its own host and its own process, not the platform API.** That surface is authenticated; this page is deliberately unauthenticated and LAN-scoped. Serving an unauthenticated route from the authenticated service makes one authorization mistake an API exposure rather than a status page, and makes `Cache-Control: public` a property of the API host. `/api/v1/status` is reserved on the status host, so the platform API cannot later take the same path for its own health
- **Subscriptions are out of v1**, with `features.subscriptions: false` so the UI ships no control that posts into nothing. It is a PII store and an abuse surface behind an unauthenticated endpoint, needing double opt-in, unsubscribe tokens, rate limiting and a mail or push provider as a BYO seam. None of that is a rendering decision
- **No `tenant` field in v1.** `sdk-boundary.md` classifies tenancy as "same code path, different cardinality", not a shared-schema concern, and a field nothing sets is a field the producer has to lie about — the same ground on which a required `runbookUrl` was rejected. The must-ignore rule above is what keeps it a cheap additive change later; the right answer to "this gets expensive later" is to repair what makes it expensive, not to pre-place the field

**Alternatives Considered:**
- **Agree the boundary in the issue thread and build both halves against it** -> what MCAA-419 was raised to avoid. A thread is not diffable, nothing fails when an implementation disagrees with it, and the disagreement surfaces on the page during an incident
- **Direct Prometheus queries from the browser** -> deletes the back end entirely, and publishes the cluster's metric and label inventory on an unauthenticated endpoint while coupling the UI to PromQL. Rejected on trust boundary, not on effort
- **SSE or WebSocket push** -> listed in the contract as deferred and additive rather than rejected outright. It would be the right answer if the data ever moved faster than Prometheus' evaluation interval. It does not
- **Taxonomy in the ConfigSet** -> the framing the work started from, and it cannot be done without inventing a delimited-string encoding in a schema with no array type. It also confuses "operator-specific" with "configurable": the hostname is the former, the word "Media" is not
- **A fifth `maintenance` state instead of an overlay** -> simpler to render and it makes the calendar able to conceal an outage. Rejected on the same principle as every other decision here
- **`signal_unavailable` evaluated first, uniformly** -> the first revision, and it is safe-looking in the direction that does not matter. Reporting `unknown` for a fault the page can prove is not a conservative failure, it is the same over-claim inverted, produced in the hour the page is actually read
- **Require `runbookUrl` on every incident** -> rejected: runbook coverage is only now becoming mandatory (#462), so the field is nullable rather than a field the producer must fake
- **A central ADR-number allocator** -> not considered here because ADR-039 already rejected it. The number this ADR carries moved three times before it settled, and that is worth recording because the next author hits the same thing. Review suggested 034 from a heading grep of `main`; 034 is allocated to #368 by a **blockquote** numbering note, which a heading grep cannot see — and that form exists precisely because a reserving *heading* merges cleanly over the real ADR and deletes it. 046 was the next candidate and is authored by `docs/adr-033-toolchain-runtime-pins`. The claim set is only complete when three sources are swept together: headings on `main`, blockquote notes on `main`, and headings on every open PR head (local worktrees are a subset of the last). Measured 2026-09-28 across `main`, 60 open PR heads and every local worktree: 034 (#368), 041, 043, 044, 046, 047 and 048 are all claimed by unmerged branches — 048 by the contract-gate work this review raised. 049 was the lowest free number at that sweep and it did not survive: #477 merged it to `main` while this branch was open, which is ADR-039 working exactly as written. A re-measure on the rebase reported 050 free across `main` and "all 194 remote heads"; that sweep was wrong, because a ref list sorted lexically and truncated inspects `pr/1, pr/10, pr/100...` and never reaches `pr/470`. A sweep must report how many heads it inspected, or a truncated one reads as free. Re-measured with a count across `main`, all 84 open PR heads and 62 local worktrees, 050 is authored by #488 as well as by this branch and **051 is the lowest number free in all three sources.** Per ADR-039 it is still only this ADR's number on merge

### ADR-054: What counts as a key an upstream helm chart declares -- four packaging rules, a self-expiring allowlist, and a gate that is deliberately not required (2026-09-29); refines ADR-030

*Numbering note: `main` carried ADR-049 as its highest number when this was written, with 034, 041, 044, 046, 047 and 048 free in the file and claimed by open branches. Every open pull request that touches this file was checked by grepping added `### ADR-` headings in its diff rather than citations (a cross-reference matches a naive search and makes a free number look taken): 034 by #368, 041 by #433, 044 by #461, 046 by #362, 047 by #399, 048 by #476, 050 by #488, 051 by #470, 052 by #517, 053 by #520. Sibling worktrees were grepped too -- the one for #520 is where 053 is written. 054 is the lowest number free of all of them. No number is reserved here; if another branch lands 054 first this renumbers during the rebase per ADR-039.*

**Context:**
- [#483](https://github.com/ryanmcafee/homelab/pull/483) adds `task upstream:values` (`scripts/upstream-values-check.ts`, 665 lines at head `73e1436`): it pulls every pinned upstream chart an `Application` points at and fails when the Application passes a `spec.source.helm` key path the chart does not declare. This ADR is the decision that gate implements -- what "the chart declares this key" means. Until now that definition lived only in the script's docstring and in the 48 reasons of `tests/gitops/upstream-values-allowlist.yaml`, which is a decision carried in an implementation, not a recorded one
- **The defect it catches is silent by construction.** Almost no upstream chart ships a `values.schema.json`, so helm accepts an unknown key without comment. The key is dropped, the manifest renders, kubeconform validates it, the committed snapshot records the manifest *without* the key as expected output, and ArgoCD reports `Synced`. Every step behaves as designed, and no level-0 check in this repository can see it. Measured on `charts/addons/values.yaml` in MCAA-396: `spegel.registries` (the chart calls it `mirroredRegistries`), `spegel.resolveLatestTag` (`registryFilters`) and `spegel.appendMirrors` (`prependExisting`) were inert for the whole life of the pin, and ten registry entries never reached the DaemonSet. Those were removed by [#469](https://github.com/ryanmcafee/homelab/pull/469) (`9d5ad35`); the gate found four more inert keys across node-feature-discovery, Cilium, external-dns and Mosquitto, corrected in #483 itself
- **The naive rule does not work, and the number says how badly.** Measured in MCAA-434 over 80 Application chart sources across 41 distinct charts, "a path we set must appear in `helm show values`" reports **613 findings**. Unusable in the sense that matters: nobody triages 613 findings, so the gate would be turned off or blanket-allowlisted, and the three real ones would ship anyway
- **Each of the four causes is a packaging fact about how helm composes values, confirmed against the real charts rather than inferred.** `helm show values` prints the parent's `values.yaml` only; a `type: library` dependency merges at the **root**; a values document can wrap its own defaults under a private key; an upstream default of `{}` or null is an invitation rather than a constraint; and helm replaces a list wholesale rather than merging it. Applying them takes 613 to **136** -- the open-defaults rule alone accounts for 613 to 318
- **The remaining 136 are not all defects, and they are not all rule failures either.** They are chart surfaces that are genuinely free-form for a reason no rule can read: a subtree copied wholesale into a ConfigMap (`argo-cd.configs.cm`, `opentelemetry-collector.config`), a map keyed by user-chosen names (TrueCharts `persistence`, `workload`), a `toYaml` passthrough, or a key upstream leaves undeclared on purpose so `hasKey` can distinguish unset from false. Something has to carry those, and whatever carries them is a hole in the gate
- The gate is network-bound (`helm pull` per distinct chart, 42 today), which excludes it from level 0 by the contract in `docs/contracts/quality-gates.md`

**Decision:**
- **A key is declared when its dotted path appears in the declared key surface of the chart tree, and the surface is computed by four rules.** The subject is the union of `spec.source.helm.values` (a YAML string) and `spec.source.helm.valuesObject`, merged the way helm merges value sources, because that union is what reaches the chart:
  1. **Dependency merge.** A vendored dependency's `values.yaml` counts, keyed as helm merges it: under the dependency's `alias` when `Chart.yaml` gives one, else its `name` -- except a `type: library` dependency, which merges at the **root**. That last case is not a corner: it is where the TrueCharts `common` library declares `TZ`, `workload`, `persistence` and `service` for every app that depends on it, and without it every TrueCharts Application reads as almost entirely undeclared
  2. **Wrapped defaults.** A `values.yaml` whose *only* top-level key is underscore-prefixed is a defaults wrapper, not a key. istio 1.31 ships every default under `_internal_defaults_do_not_set` and merges it itself in `templates/_helpers.tpl`, so the real key surface is one level down. Unwrapping keeps the four istio charts this platform pins -- `base`, `istiod`, `cni`, `ztunnel` -- genuinely checked instead of allowlisted whole. A document with any other top-level key is left alone
  3. **Unconstrained defaults.** An upstream default of `{}` or null declares the key as free-form, so every path below it is accepted **by rule**: `resources: {}` is an invitation to set `resources.limits.cpu`. A key whose default is a *populated* map is not free-form, and that asymmetry is the whole discrimination of the gate -- it is why the spegel keys were reported. `spegel` has real children, so `spegel.registries` has no open ancestor to inherit from
  4. **Arrays are leaves.** Helm replaces a list wholesale rather than merging element by element, so an index carries no declaration and the check does not descend into one
- **Reporting is shallowest-first and stops at the first undeclared path**, under one stable rule ID, `upstream-values/undeclared-key`. Once `spegel.registries` is reported there is nothing to learn from its children, and the shallowest path is the one somebody has to fix
- **Both surfaces are the input, not just production.** The check reads the rendered snapshots of `homelab` and `localdev`, so a key that is inert only on the fork path still fails. One rule over both trees is what stops the two surfaces drifting on it -- *shared bones, not copies*
- **Whatever the rules cannot settle goes in `tests/gitops/upstream-values-allowlist.yaml`, and the allowlist is a contract with four clauses.** (a) An entry is keyed by `repoURL`, `chart`, `targetRevision` (compared via the pull cache key) plus a dotted `path`, and covers that path and everything under it. (b) A non-empty `reason` is **required** and is parsed as such -- a missing or blank field is a hard error, not a warning -- and the reason names the upstream `file:line` and mechanism that makes the key undeclarable by rule. (c) **An entry that matches nothing fails the gate**, so a hole cannot outlive its cause: when upstream declares the key, the entry has to go. (d) Entries are held back from that expiry check for a pinned identity that could not be pulled, because demanding removal on evidence nobody gathered is how a self-expiring list gets emptied by an outage
- **An allowlist entry is not a place to park a key the chart does not read.** That is the defect the gate exists to find. The entry is for a surface the *rules* cannot see, and it has to argue that in its reason
- **Nothing may pass by vacuity.** A chart that cannot be pulled is a failure, not a skip -- its Applications were not checked at all, and a green that covers an uninspected chart is worse than a red. Zero Application sources found is also a failure. This is the same floor ADR-049 put on its Sensor gate, for the same reason
- **A value-passing shape the gate does not understand must fail as unsupported, not fall through.** Three exist today and all three are currently silent skips, which is the single thing about this gate that violates its own blast-radius property: `spec.sources[]` (multi-source Applications -- `sourcesInDocuments` reads `spec.source` only), `spec.source.helm.parameters`, and `spec.source.helm.fileParameters`. No Application in either snapshot tree uses any of them, so this is latent rather than live; it stays that way only until someone adds one. Two adjacent cases get the same treatment: a pulled chart directory with no `Chart.yaml` is a **pull error**, not an empty key surface (an empty surface reports *every* key as undeclared -- loud, but pointing at the wrong thing), and two distinct `repoURL`s serving one chart name are resolved by identity keying (MCAA-848), because `base`, `cni` and `common` are generic enough to inherit another chart's holes
- **Placement: `.github/workflows/upgrade.yml`, not level 0 and not `pr-contract.yml`.** Not level 0 because `helm pull` reaches the network and level 0 is network-free by contract. Not `pr-contract.yml` because that workflow skips `renovate/*` heads, and a chart that renames a values key in a minor bump is the exact PR this gate exists for. `upgrade.yml` is where the bump lands, and its result feeds both the aggregate fail step and the `upgrade/automerge-gate` commit status that Renovate automerge waits on
- **The gate is deliberately not a required status check on `main`, and this is the recorded position rather than an oversight.** The only required context is `Verification claim matches level 0` (the `pr-contract.yml` job), carried by classic branch protection on `/branches/main`; the active ruleset holds no `required_status_checks` rule. Three things make that the right answer today, and the third is the one that decides it:
  - The unattended path is already blocked. A Renovate bump cannot automerge unless `upgrade/automerge-gate` is green, and that status is `failure` with the reason "an Application sets a helm value the chart does not declare" whenever this check fails. That is the case with no human in it
  - The attended path is covered but not blocked. `upgrade.yml`'s `paths:` filter names `charts/**`, `tests/snapshots/**`, the script and the allowlist, and an Application's helm values cannot change without touching at least `charts/**`. So the gate **runs and goes red** on a hand-written typo; what it does not do is prevent the merge. The hole is the requirement, not the trigger
  - Requiring it would mean deleting that `paths:` filter. GitHub leaves a required context that never runs *pending forever*, and a workflow filtered out by `paths:` publishes no check run at all -- measured on #345 and recorded in `verify.yml` under MCAA-164. (A job skipped by a job-level `if:` publishes `skipped`, which does satisfy the requirement; a filtered workflow does not.) So the price of making this required is pulling 42 upstream charts on every pull request in the repository, including docs-only ones
- **The reopening condition is named, so the position can be checked rather than re-argued:** make it required if a typo'd key ever merges red on a human PR, or if the pull cost is brought down enough (a cache, or a filter that can see an Application value change without covering every chart PR) that running it unfiltered is cheap. Absent either, the automerge status is the gate and review is the attended path

**Alternatives Considered:**
- **The naive rule: flatten `helm show values`, diff, report.** Rejected by measurement, not by taste -- 613 findings over 80 sources. A gate nobody can triage gets blanket-allowlisted, which is strictly worse than no gate because it reads as coverage
- **Require a real schema: validate values against the chart's `values.schema.json`.** This is the correct mechanism and it does not exist. Almost no upstream chart ships one, and this repository cannot retrofit schemas onto charts it does not own. Worth revisiting per-chart if upstreams start shipping them; the gate would then be redundant for those charts, which is the cheap direction to be wrong in
- **Generate a schema per pinned chart and gate on a frozen baseline of it**, in the ADR-030 idiom. Rejected as the same rule with more machinery: a schema derived from `values.yaml` encodes exactly these four rules, plus a baseline to regenerate on every bump. The pull-and-compare version has no artifact to drift
- **Infer free-form surfaces from the templates** -- detect `toYaml .Values.x` or `range .Values.y` and treat the subtree as open. Attractive because it would delete most of the allowlist, and rejected because it means parsing Go templates to decide a correctness question. *Boring is a feature*: 48 read-and-argued reasons beat a template analyser nobody can debug when it is wrong
- **Carry the free-form exceptions as comments in the chart values instead of a central allowlist.** Rejected because comments do not expire. The property that keeps this gate honest across version bumps is clause (c) -- an entry that stops matching fails -- and only a machine-read list can have it
- **Declare the exception on the Application rather than centrally** (an annotation naming the open subtrees). Rejected because the fact being recorded is a fact about the *chart*, so two Applications on one chart would each restate it and they would drift
- **Put it in level 0 and vendor the charts.** Rejected: level 0 is network-free by contract, and vendoring 42 charts to preserve that is a much larger commitment than this gate justifies
- **Make it required now and drop `upgrade.yml`'s `paths:` filter.** Rejected on cost, as above -- 42 chart pulls on every pull request, and a real network flake surface on the busiest path in the repository. Reversible the moment that cost changes, which is why the reopening condition is written down

**Consequences:**
- **When this gate is wrong it is noisy, never silent -- with three named exceptions, which is why closing them is a decision above and not an improvement.** A missing rule over-reports (a real key looks undeclared and somebody investigates); a broken pull fails; an obsolete allowlist entry fails. The only quiet directions are the unsupported shapes -- `spec.sources`, `helm.parameters`, `helm.fileParameters` -- and they are quiet today only because nothing uses them
- **Blast radius of the defect this prevents:** one inert key on one Application. It does not cross a trust boundary, cannot move platform bus state, and is bounded to the chart's own behaviour -- but it is invisible from every other signal, which is the argument for a gate rather than for review. The spegel case sat in `main` for the life of a pin with ten registry entries doing nothing
- **Blast radius of the gate itself failing:** a red `upgrade.yml` on chart PRs and a blocked Renovate automerge. It cannot block a human merge (it is not required) and it touches no cluster. The proportionate response to a false positive is an argued allowlist entry, not a revert
- **The allowlist is a standing maintenance cost and its shape should be read honestly: 48 entries over 23 charts, 20 of which cover a whole top-level key.** Twenty whole-key entries would normally be a sign the rule is too weak; here each one is a documented free-form or passthrough surface. The self-expiry clause is what keeps the number from ratcheting -- every bump that declares a key forces the entry out
- **Every chart bump with allowlist entries forces a re-review**, because the entries bind one pinned revision. This extra work is intended: an exception for an old chart cannot silently cover a new chart revision
- **A chart bump that renames a values key now fails with the path named**, instead of leaving the old key inert and passing every other check. That is the motivating case and it is now covered on the path where no human is looking
- **A fork inherits the gate and the cost.** A forker who adds a chart with a free-form surface meets a red gate and has to argue an allowlist entry with an upstream `file:line`. That is friction on exactly the fork path *shared bones* exists to protect, and it is accepted: the alternative is a fork whose values silently do nothing. The rule reads both snapshot trees, so neither surface can drift away from it
- **`upgrade.yml` now runs on `tests/snapshots/**` and `charts/**`, which is nearly every chart PR, each pulling ~42 charts.** Correct -- the gate reads the snapshots, so it must run when they change -- and it is a real network and flake surface added to a common path. The trade-off was made deliberately, and it is the same cost that argues against making the check required
- **The rule set is now written in three places -- this ADR, the script docstring, and the allowlist header -- and they must move together.** That is one coupling more than ADR-037 would like, and it is the honest count; the mitigation is that this ADR is the record and the other two are summaries that cite it. One drift already exists to fix rather than inherit: both the docstring and the allowlist header say "three rules" and then list three, with *arrays are leaves* documented separately at `declaredPaths`. There are four rules. Count them the same way in all three places
- **#483 is not blocked by this ADR** -- the docstring is adequate for the implementing engineer and a green-able gate should not wait on the record -- but the four conditions from its design review are: multi-source and parameter shapes failing loudly, the untar-directory assumption, and the chart-name collision. They belong on #483 if they are cheap and on a filed follow-up otherwise, which is the condition the review set on merge
- **This changes no event contract, subject, envelope or delivery guarantee.** It constrains what an `Application` may pass to a chart, and the gate that says so lives in CI, not in the cluster

## Tips

- Number decisions sequentially (ADR-001, ADR-002, etc.). Write the heading as `### ADR-NNN: <title> (<date>)` — three digits, heading depth three — and take the lowest free number. The number is yours when it **merges**, not when you write it: if another branch lands it first, renumber yours during the rebase, keep the body byte-identical, and move the citations with it (ADR-039). `task verify` fails on a duplicate number and on any other heading shape
- Never reserve a number with a placeholder heading. Say it in a blockquote above the next real ADR instead; a placeholder heading merges cleanly over the real ADR of that number and deletes it
- Include date for temporal context
- Be honest about trade-offs (both positive and negative consequences)
- Keep alternatives brief - just enough to show what was considered
- Don't include implementation details - focus on the "why" not the "how"
