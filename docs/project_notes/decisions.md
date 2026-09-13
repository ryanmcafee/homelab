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
- Kind sizing (single replica, no autoscaling, small resources, 1d Prometheus retention, alertmanager/node-exporter off, cloudnative-pg and argo-workflows off) is keyed on `{{ if eq .Set "localdev" }}` inside the templates, because it describes the Kind host rather than a platform capability
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
- The root `gitops` Application (`localdev/argocd/gitops-app.yaml`) points at GitHub `main`, but every Application is synced from the working tree with `argocd app sync --local`, tier by tier (parent wave, then own wave) by `scripts/localdev-argocd.ts sync`; `wait` and `verify --level 2` judge `health` + `operationState.phase`, never `sync.status`
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
- After a local sync every Application is `OutOfSync` against `main` by design; tooling and docs must never treat that as a failure
- Localdev never exercises automated sync (prune/selfHeal); the homelab snapshots and the `app-automated` policy still cover it
- A new app needs a `smoke:` block, a seeded Secret if 1Password provides one, a chainsaw test, and health Lua + fixtures for any new CR kind; `localdev/fakes/README.md` and `tests/e2e/README.md` hold the recipes
- CI takes up to 45 minutes and the cache is best-effort (several GB, evicted at the repository budget); `hosts.toml` falls back to the upstream
- Kind host port mappings (30080→8080, 80→9080, 443→9443) work on Linux only: Docker Desktop on macOS forwards packets with bad TCP checksums that Cilium's BPF delivery lets the pod validate and drop. The ArgoCD script therefore uses its own `kubectl port-forward` (default `127.0.0.1:18080`), `task localdev:ui` / `task localdev:traefik` expose the UI (8080) and Traefik (9080/9443) from macOS, and every check that matters (smoke hooks, e2e) runs in-cluster (see bugs.md, 2026-09-13)
- `tools.kind`, `tools.argocd`, `tools.chainsaw`, `images.kind-node`, `images.curl` join `versions.yaml` and are mirrored in `mise.toml` and `tilt-ci.yml`

- **2026-02-11: ArgoCD CMP for PII removal** — Moved config generation from commit-time to ArgoCD render-time using a Config Management Plugin sidecar. Bootstrap chart breaks chicken-and-egg with 1Password operator. All committed values files sanitized to safe defaults. The design doc (`docs/plans/2026-02-11-argocd-cmp-pii-removal-design.md`) was removed in c4daa10 once implemented; the mechanism is documented in `Claude.md` "CMP Architecture" and extended to child charts by ADR-010.

- **2026-02-13: Dual Traefik Ingress Controllers** — Split single Traefik into external (`external` IngressClass, static IP 172.16.100.200, OIDC, port forwarding) and internal (`internal` IngressClass, dynamic IP, no OIDC). Plex uses external; all other apps use internal. OIDC middleware annotations removed from internal apps. Design doc: `docs/plans/2026-02-13-dual-traefik-ingress-design.md`.

## Tips

- Number decisions sequentially (ADR-001, ADR-002, etc.)
- Include date for temporal context
- Be honest about trade-offs (both positive and negative consequences)
- Keep alternatives brief - just enough to show what was considered
- Don't include implementation details - focus on the "why" not the "how"
