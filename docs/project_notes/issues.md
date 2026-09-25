# Issues/Work Log

Track work completed on the homelab project. Keep it simple - just enough to remember what was done. Full details live in GitHub Issues/PRs.

## Format

Each entry should include:
- Date (YYYY-MM-DD)
- Issue/PR reference
- Brief description (1-2 lines)
- URL to issue/PR (if available)
- Status (optional: completed, in-progress, blocked)

## Recent Work

### 2026-09-23 - Observability: Traefik logs+metrics, OTel -> ClickHouse logs and traces, Hubble, UniFi flows, Istio ambient + Kiali, paperclip request path
- **Status**: PR #321 open; before merge create 1Password items `clickhouse-otel` and `clickhouse-grafana` (field `password`) and add `OTEL_LB_IP` to homelab.yaml and the homelab-environment-config document; after merge a human runs `task render && task render:push && task tf:apply`, restarts Cilium, and points UniFi syslog/IPFIX at `OTEL_LB_IP`
- **Description**: The Paperclip API occasionally fails to respond with no 5xx at Traefik. Every hop now leaves correlated data: Traefik JSON access logs (TraceId, timings, client) and metrics, OpenTelemetry collectors writing container logs, events, OTLP traces, the filtered Hubble flow log and UniFi syslog/IPFIX into ClickHouse (Altinity operator, iSCSI 100Gi, 90-day TTL), Istio 1.31 ambient with paperclip enrolled behind a waypoint, blackbox probes (ingress vs direct), Kiali, Hubble UI and the "Paperclip request path" dashboard with its runbook. ADR-019..022
- **URL**: https://github.com/ryanmcafee/homelab/pull/321

### 2026-09-20 - Firing alerts root-caused: stale failed Jobs, kube-proxy, Talos bind-address, unclassed IngressRoutes
- **Status**: PR #313 open; after merge a human runs `task tf:apply:component COMPONENT=talos-cluster` and deletes the four pre-TTL failed Jobs once
- **Description**: `KubeJobFailed` fired 17 days after one transient failure because neither CronJob expired finished Jobs; `KubeProxyDown` because Cilium replaces kube-proxy; `KubeControllerManagerDown`/`KubeSchedulerDown` because Talos binds both to 127.0.0.1; the nightly `ingress-verification` failed on `auth` (three IngressRoutes without an ingress class are loaded by no Traefik) and on the disabled Home Assistant. Guards: conftest `cronjob-ttl` and `ingressroute-class`. Follow-ups in the same PR: the `ingress-verification` CronWorkflow and its `argo-workflows-config` chart removed (no longer needed), `metrics-server` addon so the Traefik HPAs and `kubectl top` work, and `agent-readonly` may `exec` and port-forward so an agent can read what Alertmanager is firing. Details in `bugs.md` (2026-09-20)
- **URL**: https://github.com/ryanmcafee/homelab/pull/313

### 2026-09-15 - Sporadic Kubernetes API loss root-caused: etcd fsync on the shared VM pool
- **Status**: PR open (branch `fix/apiserver-etcd-stability`); migration is a human step, `docs/runbooks/control-plane-storage.md`
- **Description**: The API dropped for tens of seconds at a time because the three control-plane VM disks shared the ZFS mirror `vm-storage` with every worker disk; a worker image unpack (~6.5 GB) stalled etcd WAL fsync up to 48 s, leases expired and the Talos VIP moved. Fix: dedicated NVMe pool `cp-storage` for the control planes, etcd `heartbeat-interval=250`/`election-timeout=2500`, etcd metrics on :2381 with a `kubeEtcd` scrape and three alerts, plus `scripts/apiserver-stress.ts` (`task apiserver:probe` / `task apiserver:stress`). ADR-016. Measured: the API server sustains 742 req/s of concurrent reads with zero errors, so capacity was never the problem. Also found: the Proxmox root filesystem is 100 % full from an unmanaged failing `vzdump` job, and the unused Cilium LB pool `control-plane-vip` could let a labelled Service hijack the API VIP
- **URL**: https://github.com/ryanmcafee/homelab/pull/288

### 2026-09-13 - Tailscale split DNS for the homelab domain (private hostnames from mobile)
- **Status**: PR #278 merged 2026-09-14 (script, tasks, runbook); the ACL grant follows in its own PR (`tailscale-acl.yml` applies it on merge), then runbook steps 2-3 (OAuth client in 1Password, `task tailscale:dns:apply`)
- **Description**: Phones on the tailnet could not resolve `argocd.<domain>` because those records live only on the UniFi gateway. Adds the ACL grant `autogroup:member -> <GATEWAY_IP>/32 udp:53,tcp:53`, `scripts/tailscale-dns.ts` + `task tailscale:dns:{status,apply,remove}` (idempotent split-DNS PATCH via the Tailscale API, OAuth client `op://homelab/tailscale-dns-oauth` with the `dns` scope) and `docs/runbooks/tailscale-dns.md`. The gateway is addressed as GATEWAY_IP inside the advertised /24; its other VLAN address is not routed onto the tailnet.
- **URL**: https://github.com/ryanmcafee/homelab/pull/278

### 2026-09-13 - verify prod: pass Applications whose chart renders no resources
- **Status**: Open (PR #277)
- **Description**: First end-to-end `task verify:prod` after PR #276 (ACL grant) and enabling HTTPS certificates on the tailnet: 56 pass, 10 fail. Nine `*-config` Applications carry a stale Failed operation from 2026-09-13 01:25 UTC (revision 95c459d, PV iSCSI portal rendered empty before the gitops-bootstrap re-apply; live PVs untouched, now Synced at 699acf3, a re-sync clears it). The tenth, `traefik-internal-dependencies`, is a comment-only placeholder chart that ArgoCD never syncs; `evaluateArgoApp` now passes Synced + Healthy + zero resources instead of reporting "never synced".
- **URL**: https://github.com/ryanmcafee/homelab/pull/277

### 2026-09-13 - PR #276: Tailscale ACL grant for the read-only API server proxy (runbook step 2)
- **Status**: Open (PR #276; `tailscale-acl.yml` applies on merge behind the production environment)
- **Description**: `task prod:kubeconfig` failed because the 1Password items from `docs/runbooks/readonly-access.md` steps 3-4 (`k8s-agent-readonly`, `argocd-agent-token`) had never been created; both now exist and `task prod:kubeconfig` / `task prod:diff` work. `task verify:prod` still failed with `no such host` because the policy had no grant to `tag:k8s-operator` (step 2); this PR adds `autogroup:admin -> tag:k8s-operator tcp:443`. Also refreshed the stale `argocd.<DOMAIN>` admin password in 1Password from `argocd-initial-admin-secret`.
- **URL**: https://github.com/ryanmcafee/homelab/pull/276

### 2026-09-13 - Issue #261 Sections C + D: previews, read-only prod, upgrade gate, restore drill, scaffolder, agent contract
- **Status**: Open (PR #273, single PR for items 16-22, closes #261)
- **Description**: Label-gated per-PR previews on the homelab cluster (ApplicationSet PR generator, `preview-<N>` namespaces, AppProject `previews`); sticky Kind report with `argocd app diff` vs main on every PR; read-only production access for agents (`agent-readonly` RBAC, Tailscale API server proxy, ArgoCD `agent` account, `homelab verify prod`) and gated ArgoCD GitHub deploy notifications; `homelab verify upgrade` + `upgrade.yml` (upstream manifest diff, CRD revalidation, Renovate automerge gate, optional regeneration bot); weekly CloudNativePG restore drill in Kind (Barman Cloud Plugin + versitygw); `homelab scaffold app`; committed PostToolUse level-0 hook, PR-body claim checked by `pr-contract.yml`, gitops-test skill without prod-mutating tiers. ADR-013, ADR-014.
- **URL**: https://github.com/ryanmcafee/homelab/issues/261

### 2026-09-13 - Issue #261 Section B / PR #270: Kind + ArgoCD loop (levels 1-2)
- **Status**: Merged (cca7600)
- **Description**: `task localdev:up` builds Kind (Cilium, registry pull-through caches, fakes), installs ArgoCD from `versions.yaml` with the shared health Lua, and syncs every Application from the working tree with `argocd app sync --local` tier by tier; automated sync is off in localdev (`ARGOCD_AUTOMATED_SYNC`), `MEDIA_PROVIDER`/`CERT_ISSUER` keys make the render Kind-safe. `task verify LEVEL=1|2` adds `dryrun/localdev/<chart>`, `argocd/<app>` and `e2e/<test>` checks; PostSync smoke hooks; chainsaw e2e in `tests/e2e/`; `task test:health` fixtures; `tilt-ci.yml` rewritten with a required `kind-argocd` job. ADR-012. Items 9-15 of #261.
- **URL**: https://github.com/ryanmcafee/homelab/pull/270 (issue https://github.com/ryanmcafee/homelab/issues/261)

### 2026-09-12 - Issue #263: localdev parent values generated from the config system
- **Status**: Completed (PR pending)
- **Description**: `charts/{addons,applications}/values-localdev.yaml` are now generated by `homelab config export --set localdev` (`task config:export:localdev`) and committed; platform differences become capability keys in `platform.schema.yaml` (CNI, load balancer, external-dns, storage, secrets), Kind sizing keyed on `.Set`. Level 0 adds `render/localdev/_committed-values`; 10 localdev-only `hostname-domain` exemptions removed; localdev domain fixed to `homelab.local`. ADR-011.
- **URL**: https://github.com/ryanmcafee/homelab/issues/263

### 2026-09-12 - PR #265: Child-chart values-homelab.yaml PII moved to the config system (#262)
- **Status**: Completed
- **Description**: Parent Applications now pass derived values (domain, hostnames, iSCSI portal, Traefik static IP, ACME e-mail, DuckDNS subdomain) to child charts via `helm.valuesObject`; ~20 child `values-homelab.yaml` files stripped to non-PII settings; bootstrap ArgoCD hostname derived from a Terraform-injected `global.domain`; level 0 inherits parent `valuesObject` per child; PII guard widened to `charts/**/values-homelab.yaml` with Helm-key shape rules; 9 `hostname-domain` exemptions removed. ADR-010.
- **URL**: https://github.com/ryanmcafee/homelab/issues/262

### 2026-09-12 - PR #264: Level-0 static verification (#261 Section A)
- **Status**: Open
- **Description**: `task verify` renders every chart for localdev + homelab.yaml.example, runs helm lint, kubeconform (vendored CRD schemas, no -skip), pluto, a GitOps graph linter, golden snapshots and conftest policies; JSON summary, < 5 s. CI workflow verify.yml, pre-commit hook, runbook, ADR-009. Follow-ups #262, #263.
- **URL**: https://github.com/ryanmcafee/homelab/pull/264

### 2025-01-27 - PR #7: Automate TrueNAS Provisioning
- **Status**: Merged
- **Description**: Automated TrueNAS provisioning workflows
- **URL**: https://github.com/ryanmcafee/homelab/pull/7

### 2025-01-27 - Fix: Remove duplicate cloudflare-api-token
- **Status**: Completed
- **Description**: Fixed duplicate OnePasswordItem in traefik addon
- **Commit**: 6f48647

### 2025-01-27 - Config: Update gitops tracking to main branch
- **Status**: Completed
- **Description**: Changed ArgoCD tracking revision back to main
- **Commit**: bcf05ad

### 2025-01-27 - Fix: ArgoCD HTTP backend scheme
- **Status**: Completed
- **Description**: Added HTTP backend scheme and disabled oauth2-proxy for debug
- **Commit**: 95da241

## Pending/In Progress

- **2026-09-21** - PR #316: Paperclip `adapters.apiKeys.anthropic.enabled` / `adapters.apiKeys.openai.enabled` (both default false) replace the operator's all-or-nothing `apiKeysSecretRef`, so `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are wired independently and neither reaches the pod by default; subscription tokens stay wired through `adapters.extraSecretEnv` — https://github.com/ryanmcafee/homelab/pull/316
- **2026-09-13** - Issue #260: Paperclip via paperclip-operator + CloudNativePG (4 Applications) — PR #280 open, level 2 runs in CI (`kind-argocd`); 2026-09-14: the same PR moves the Kind loop to the PR head (`localdev:argocd --revision` / `LOCALDEV_REVISION`, `localdev:report --base`, CI checks out the head SHA; ADR-012 amendment) — https://github.com/ryanmcafee/homelab/pull/280
- **2026-09-13** - PR #275: `prod/argocd/domain` check + docs for the ArgoCD Ingress rendering `argocd.example.com` (root `gitops` Application never received `global.domain` after #265). Blocked on the human `task tf:apply:component COMPONENT=gitops-bootstrap` — https://github.com/ryanmcafee/homelab/pull/275

## Tips

- Keep descriptions brief (1-2 lines max)
- Always include issue/PR URL for easy reference
- Update status if work gets blocked or resumed
- Don't duplicate issue details - link to source of truth
- Clean out very old entries periodically (3+ months)

### 2026-09-25 - Clean-machine toolchain bootstrap (issue #331)

- PR: https://github.com/ryanmcafee/homelab/pull/353; branch: `fix/mcaa-28-clean-toolchain`.
- Added Python/pipx/Node runtime pins, preserved mise install diagnostics, and added a cold-container CI gate with the local `task toolchain:check` entrypoint (committed HEAD).
- Reproducibility: explicit backend runtimes and checksum-pinned mise. Fail fast, fail loud: missing runtime and installer stderr regressions. Least-privilege CI: read-only contents, no persisted checkout credentials, no credentials/cache/Docker socket passed into the test container.
- Local install and tier-detection checks passed; first cold-container CI run passed in 117 s. CI exposed subset installs missing the newly pinned runtime selection; all five pipx workflow consumers now select `python pipx` explicitly. Architecture/security review and final-head CI/QA remain required before merge.
