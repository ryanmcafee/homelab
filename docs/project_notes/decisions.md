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
- Use TypeScript with Deno runtime for all scripts
- No Bash or Python scripts
- Explicit Deno permissions for security

**Alternatives Considered:**
- Bash -> Traditional but error-prone, hard to maintain
- Python -> Good but less type safety
- Go -> Overkill for scripts, slower iteration

**Consequences:**
- Type-safe automation
- Modern async/await patterns
- Requires Deno installation
- Some learning curve for shell-to-TS conversion

### ADR-006: Unified NFS Permission Model — apps:users (568:100) (2026-02-09)

**Context:**
- Containers run as UID 568 (apps) with GID 100 (users) per TrueCharts convention
- Democratic-CSI provisions NFS shares with mapall for k8s PVC datasets
- Media datasets (movies, tv, downloads, etc.) use direct NFS mounts, not CSI
- Initial setup used `rmcafee:users` for media shares and `apps:users` for k8s — causing permission mismatches when containers accessed media NFS mounts

**Decision:**
- ALL NFS shares use `mapall_user: apps, mapall_group: users` (568:100)
- ALL datasets owned by `apps:users` (568:100) with mode 770
- Single permission model for both CSI-provisioned and direct NFS mounts
- SMB access still works via group `users` (GID 100) shared between `rmcafee` and `apps`

**Alternatives Considered:**
- Keep `rmcafee:users` for media, `apps:users` for k8s → Split model, confusing, permission bugs
- Use `maproot` instead of `mapall` → Only maps UID 0, non-root containers get denied

**Consequences:**
- All media apps (NZBGet, Sonarr, Radarr, etc.) can access NFS mounts consistently
- SMB clients (desktop) still have access via group membership
- Dataset ownership is `apps` not `rmcafee` — SMB writes will appear as `apps` user
- Script `truenas-nfs-mapall.ts --all --fix-permissions` applies the full fix

### ADR-007: Split NFS Permission Model — apps:users for K8s, rmcafee:users for Media (2026-02-09)

**Context:**
- ADR-006 unified all datasets to apps:users (568:100)
- Personal datasets (media, backups, documents) are better owned by rmcafee for SMB access
- K8s workloads only need k8s datasets as apps:users

**Decision:**
- K8s datasets: apps:users (568:100) ownership + NFS mapall
- Media/personal datasets: rmcafee:users ownership + NFS mapall
- Mode 770 on all datasets (group users gets rwx)
- truenas-nfs-mapall.ts updated with split k8s/media behavior

**Alternatives Considered:**
- Keep unified apps:users (ADR-006) -> SMB files appear as apps, not personal user
- Use rmcafee for everything -> K8s pods would need reconfiguration

**Consequences:**
- SMB access shows files as rmcafee (natural for desktop browsing)
- K8s pods still access media via group users (GID 100) with mode 770
- NFS-created files from K8s pods will be owned by rmcafee (via mapall)
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
- Renovate `postUpgradeTasks` in the in-cluster Renovate -> needs Go, Helm and Deno in the Renovate image plus an `allowedCommands` admin change; the CI bot keeps the toolchain in one place
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

- **2026-02-13: Dual Traefik Ingress Controllers** — Split single Traefik into external (`external` IngressClass, static IP 172.16.100.200, OIDC, port forwarding) and internal (`internal` IngressClass, dynamic IP, no OIDC). Plex uses external; all other apps use internal. OIDC middleware annotations removed from internal apps. Design doc: `docs/plans/2026-02-13-dual-traefik-ingress-design.md`.

## Tips

- Number decisions sequentially (ADR-001, ADR-002, etc.)
- Include date for temporal context
- Be honest about trade-offs (both positive and negative consequences)
- Keep alternatives brief - just enough to show what was considered
- Don't include implementation details - focus on the "why" not the "how"
