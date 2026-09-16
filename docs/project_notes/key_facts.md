# Key Facts

Project configuration, important details, and reference information for the homelab. For sensitive values (passwords, API keys), see CLAUDE.local.md or 1Password.

## SECURITY WARNING: What NOT to Store Here

**NEVER store passwords, API keys, or sensitive credentials in this file.** This file is committed to version control.

**Where secrets are stored:**
- 1Password vault: `homelab`
- SOPS-encrypted files: `charts/secrets/`
- Environment-specific: `CLAUDE.local.md` (not committed)

## Network Configuration

See `CLAUDE.local.md` for IP addresses and hostnames.

**Key Ranges:**
- Control Plane VIP: Single IP for API server access
- LoadBalancer Pool: Range for Cilium LB IPAM
- Traefik Static IP: Fixed IP at end of LB pool

**BGP Configuration:**
- Kubernetes ASN: 64512 (Cilium)
- Router ASN: 64513 (UniFi)
- Purpose: Cilium advertises LoadBalancer IPs to UniFi router

## Kubernetes Cluster

**Architecture:**
- 3 Control Plane nodes (HA, etcd quorum)
- 3 Worker nodes (1 with GPU)
- Talos Linux on all nodes
- Proxmox VE virtualization

**Control plane storage (ADR-016):**
- Control-plane system disks live on the dedicated single-device ZFS pool `cp-storage` (NVMe), never on `vm-storage`
- etcd keeps its write-ahead log on the Talos EPHEMERAL partition of that disk; sharing a device with worker I/O stalls fsync and takes the API down
- `vm-storage` (ZFS mirror, 2x QLC SSD) holds the worker and TrueNAS VM disks
- etcd tuned for virtualised disks: `heartbeat-interval=250`, `election-timeout=2500`; metrics on `<cp-ip>:2381`, scraped as job `kube-etcd`
- Migration, verification and diagnosis: `docs/runbooks/control-plane-storage.md`

**Storage:**
- Provider: Democratic-CSI with NFS and iSCSI
- Backend: TrueNAS RAIDZ3 (~220 TB raw) + SSD mirror pool
- Storage Classes:
  - `democratic-csi-nfs` (default) - NFS on HDD pool
  - `democratic-csi-ssd` - NFS on SSD pool (`STORAGE_CLASS_SSD`; files appear owned by the mapall user, unusable for PostgreSQL)
  - `democratic-csi-iscsi` - iSCSI block storage on SSD pool (`STORAGE_CLASS_ISCSI_SSD`; SQLite and PostgreSQL workloads, e.g. `paperclip-postgres`)

## ArgoCD Sync Wave Order

ArgoCD orders waves only *within* one Application, so the app-of-apps parent
wave dominates: every object in `addons` syncs after every object in
`bootstrap`, whatever child wave it carries. Source of truth:
`charts/gitops/values.yaml` (defaults, used by localdev) and
`charts/gitops/values-homelab.yaml` (homelab overrides).

Parent Applications (rendered by `charts/gitops`):

| Parent Application | homelab wave | localdev wave |
|---|---:|---:|
| `bootstrap` | 0 | 0 |
| `addons` | 1 | 2 |
| `applications` | 10 | 3 |

Child waves inside each parent (`argocd.argoproj.io/sync-wave` on the objects
that parent renders):

| Parent | Child wave range | Notable ordering |
|---|---|---|
| `bootstrap` | -3 .. 1 | -3 namespace + secret-transformer RBAC, -2 SOPS secrets, -1 credentials-transformer Job and 1Password operator, 0 homelab-environment-config, 1 ArgoCD itself |
| `addons` | -1 .. 10 | 0 cert-manager, 1 its ClusterIssuer, 3 external-dns config, 4 external-dns, 5-8 Traefik |
| `applications` | 10 .. 15 | each `*-config` chart before the workload that consumes it |
| `applications` (Paperclip, `paperclip.yaml`) | 10 .. 14 | 10 Namespaces `paperclip-operator` + `paperclip`, 11 `paperclip-operator` (OCI chart, ServerSideApply), 12 `paperclip-dependencies` (OnePasswordItems), 13 `paperclip-database` (CloudNativePG `Cluster` `paperclip-postgres`), 14 `paperclip` (`Instance` + smoke Job) |

`homelab verify gitops` enforces the conventions this table describes
(`gitops/<env>/waves`, `gitops/<env>/crd-order`); read the rendered
`tests/snapshots/<env>/*.yaml` for the exact wave on any one object rather than
trusting a prose table.

## Important Taskfile Commands

| Command | Description |
|---------|-------------|
| `task localdev:up` | Kind (Cilium, registry caches, fakes) + ArgoCD + every Application synced from the working tree |
| `task localdev:warm` | Same, but only bootstrap + addons synced (operators and CRDs up) |
| `task localdev:sync` | Re-sync the working tree (`-- --only a,b`, `-- --warm`, `-- --dry-run`) |
| `task localdev:wait` / `localdev:diagnose` | Block until every Application is Healthy / dump conditions, events, pod logs |
| `task localdev:ci` | Non-interactive full loop: kind, argocd, sync, wait, e2e (what CI runs) |
| `task localdev:down` | Delete the Kind cluster (`-- --purge-cache` also removes the registry caches) |
| `task verify` | Level-0 static verification (render, schema, gitops graph, snapshots, policy) — JSON |
| `task verify:text` | Same checks, human-readable |
| `task verify LEVEL=1` / `LEVEL=2` | + server-side dry run on Kind / + ArgoCD Application health + chainsaw e2e |
| `task test:e2e` | chainsaw suite in `tests/e2e/` against the running Kind loop |
| `task test:health` | ArgoCD health Lua fixtures in `tests/health/` (no cluster) |
| `task test:snapshot -- --update` | Regenerate golden snapshots after an intended render change |
| `task test:policy` | conftest unit tests + negative fixtures |
| `task schemas:vendor` | Re-vendor CRD schemas after an operator bump |
| `task chart:lint` | Lint all Helm charts |
| `task chart:template:addons` | Debug addons rendering |
| `task talos:recreate:node NODE=X` | Recreate Talos node |
| `task gpu:verify` | Verify GPU support |
| `task sops:setup` | Full SOPS setup |
| `task render` | Render Cilium, CSR approver, Spegel |
| `task docs:embedme` | Update embedded code snippets |

## Environments

| Feature | localdev | homelab |
|---------|----------|---------|
| Kubernetes | Kind, 1 control-plane + 2 workers | Talos Linux |
| CNI | Cilium (installed by `scripts/localdev-kind.ts`, adopted by the `cilium` Application) | Cilium + BGP |
| Storage | local-path + `democratic-csi-*` StorageClass aliases (fakes) | Democratic-CSI NFS/iSCSI |
| Media | `emptyDir` (`MEDIA_PROVIDER=ephemeral`) | TrueNAS NFS |
| Load Balancer | disabled/NodePort | Cilium LB IPAM + BGP |
| TLS | self-signed `letsencrypt` ClusterIssuer (`CERT_ISSUER=selfsigned`) | Let's Encrypt DNS-01 |
| Secrets | seeded fakes (`localdev/fakes/secrets.yaml`) | 1Password + SOPS |
| ArgoCD sync | manual, `argocd app sync --local` (`ARGOCD_AUTOMATED_SYNC=false`) | automated (prune + selfHeal) |
| GPU | None | NVIDIA (see CLAUDE.local.md) |

## Localdev (Kind + ArgoCD loop)

| Fact | Value |
|------|-------|
| Kind cluster / kube context | `homelab-localdev` / `kind-homelab-localdev` (every script pins the context) |
| Node image | `kindest/node:<images.kind-node>` from `configuration/versions.yaml`, passed by the script, not in `localdev/kind-config.yaml` |
| Domain | `homelab.local` (`configuration/environments/localdev.yaml` `DOMAIN`) |
| ArgoCD | namespace `argocd`, root Application `gitops` (`localdev/argocd/gitops-app.yaml`; its placeholder `main` is replaced by the PR head at install), chart `charts.argocd`, values `localdev/values/argocd-values.yaml` |
| ArgoCD UI | http://localhost:8080, `admin` / `argocd-initial-admin-secret`. Linux: NodePort 30080 mapped by Kind. macOS: `task localdev:ui` (`kubectl port-forward` to `argocd-server`); the script logs the CLI in through its own port-forward on `127.0.0.1:18080` (`--local-port`) with `--plaintext --insecure --grpc-web` |
| Host ports | 8080 ArgoCD; 9080 / 9443 Traefik internal; 10350 Tilt. On Linux 8080/9080/9443 are the Kind `extraPortMappings` (30080, 80, 443). On macOS the mappings never complete a TCP handshake with Cilium (Docker Desktop bad TCP checksums, bugs.md 2026-09-13): use `task localdev:ui` and `task localdev:traefik` (port-forwards) |
| Reaching apps from the host | `task localdev:traefik` then `curl -sk -H 'Host: <app>.homelab.local' https://localhost:9443/...`; from a pod, the Traefik Service directly |
| NodePorts | 30080 ArgoCD; 31883 / 31901 mosquitto (MQTT / WebSocket); 30021 spegel (hostPort 30020); direct-mode Tilt Traefik 30080 / 30443 (no ArgoCD in that mode) |
| Registry caches | containers `kind-registry-<name>` for docker.io, ghcr.io, quay.io, registry.k8s.io, lscr.io on the `kind` network; blobs in `~/.cache/homelab-kind-registry` (`HOMELAB_KIND_CACHE_DIR`), restored in CI with `actions/cache` key `kind-registry-<hash>` |
| Fakes | `localdev/fakes/` (StorageClass aliases, Namespaces + Secrets, OnePasswordItem CRD), applied by `task localdev:kind` / `localdev:fakes` |
| Health Lua | `charts/bootstrap/files/health/<group>_<kind>.lua`, fixtures `tests/health/<group>_<kind>/*.yaml` |
| e2e | `tests/e2e/<name>/chainsaw-test.yaml`, config `tests/e2e/.chainsaw.yaml` (4 parallel, assert 10m) |
| Reaching apps | in-cluster through `traefik-internal.traefik.svc.cluster.local` (or `traefik-external`) port 443 with `Host: <app>.homelab.local`; from the host, port-forward the Traefik Service |
| CI | `.github/workflows/tilt-ci.yml`: `kind-argocd` (required, 45 min, artifact `verify-level2`), `kind-direct`, `yaml-lint` |
| Tracked revision | `task localdev:argocd -- --revision <ref>` / `LOCALDEV_REVISION`; default the upstream branch of HEAD, `main` (with a warning) when the branch is not pushed. Flows root → `addons`/`applications` via `helm.valuesObject.global.targetRevision` → every git-path child. CI sets it to the PR head SHA (same-repo PRs; `github.sha` on push) |
| Expected state | every Application `Synced` (tree equals the pushed head) after a local sync; `OutOfSync` = unpushed local changes or the `main` fallback; `Healthy` + `Succeeded` is the contract, sync status never decides |
| Report base | `task localdev:report -- --base <ref>` (default `main`, CI passes the PR base) diffs every git-path Application with `argocd app diff --revision <base>` |
| Restore drill | `tests/drills/cnpg-restore` (`task drill:restore`, weekly `restore-drill.yml`, failures open an issue labelled `restore-drill`); S3 fake `versity/versitygw` (`images.versitygw`), Barman Cloud Plugin addon `cnpg-barman-cloud` (`charts.plugin-barman-cloud`) in `cnpg-system` |
| `paperclip` | runs in Kind (operator, database, Instance; the `paperclip-dependencies` Application only renders with a secret store); Secrets `paperclip-auth` and `paperclip-api-keys` (placeholder `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) seeded by `localdev/fakes/secrets.yaml`, CNPG `Cluster` `paperclip-postgres` on `local-path` / 1Gi, `PAPERCLIP_ADMIN_EMAIL=admin@homelab.local`; e2e `tests/e2e/paperclip` |

## Verification contract (issue #261 Sections C/D)

| Fact | Value |
|------|-------|
| Agent hook | `.claude/settings.json` PostToolUse → `scripts/claude-verify-hook.ts` (level 0 after edits under `charts/`/`configuration/`; `HOMELAB_VERIFY_HOOK=off`) |
| PR claim | `task verify:claim` → `<!-- verify-level0 -->` block in the PR body; `pr-contract.yml` compares it with level 0 on the head (skips `renovate/*` and drafts) |
| Sticky PR comments | `snapshot-diff` (verify.yml), `kind-preview` (tilt-ci.yml), `upgrade-diff` (upgrade.yml), `verify-claim` (pr-contract.yml) |
| Automerge gate | commit status `upgrade/automerge-gate` on `renovate/*` heads: success only when no upstream manifest changed and CRs revalidate; Renovate `platformAutomerge: false` everywhere |
| Regeneration bot | optional; secrets `HOMELAB_BOT_APP_ID` / `HOMELAB_BOT_PRIVATE_KEY` (GitHub App, human step); commits as `homelab-regen-bot <homelab-regen-bot@users.noreply.github.com>` (Renovate `gitIgnoredAuthors`) |
| Previews | labels `preview` + `preview:<app>`; ApplicationSet `previews` + AppProject `previews` (charts/gitops, homelab only); namespace `preview-<N>` (ArgoCD `application.namespaces: preview-*`); Applications `<app>-pr<N>`; hosts `<app>-pr<N>.<domain>`; level-0 env `homelab-preview` |
| Read-only production | kube context `homelab-readonly` (`~/.kube/homelab-readonly.yaml`, 0600, `task prod:kubeconfig`), ServiceAccount `agent-access/agent-readonly` (token Secret `agent-readonly-token`) via the Tailscale API server proxy (`noauth`) at `https://tailscale-operator-homelab.<tailnet>.ts.net`; ArgoCD account `agent` (`role:readonly`, token passed in `ARGOCD_AUTH_TOKEN`); `homelab verify prod` refuses `kind-*` contexts |
| Read-only 1Password refs | `op://homelab/k8s-agent-readonly/credential` (ServiceAccount token), `op://homelab/argocd-agent-token/credential` (ArgoCD `agent` token), `vaults/homelab/items/argocd-notifications-github` (fields `github-appID`, `github-installationID`, `github-privateKey`) |
| Tailnet split DNS | `<DOMAIN> -> GATEWAY_IP` (the UniFi gateway inside the advertised LAN /24) set through the Tailscale API by `task tailscale:dns:apply` (`scripts/tailscale-dns.ts`, OAuth client `op://homelab/tailscale-dns-oauth` with the `dns` scope); ACL grant `autogroup:member -> <GATEWAY_IP>/32 udp:53,tcp:53`; `docs/runbooks/tailscale-dns.md` |
| Deploy notifications | ArgoCD GitHub notifier (commit status `argocd/<app>` + PR comment) for `bootstrap`/`addons`/`applications`; off until the GitHub App and `argocd-notifications-secret` 1Password item exist |

## Important URLs (Production)

**Management:**
- ArgoCD: `https://argocd.{domain}`
- Grafana: `https://grafana.{domain}`

**Applications:**
- Plex: `https://plex.{domain}`
- Sonarr: `https://sonarr.{domain}`
- Radarr: `https://radarr.{domain}`
- Home Assistant: `https://homeassistant.{domain}`
- Paperclip: `https://paperclip.{domain}`

(Replace `{domain}` with actual domain from CLAUDE.local.md)

## 1Password Vault Paths

| Purpose | Path |
|---------|------|
| SOPS encryption key | `op://homelab/sops-age-key/private_key` |
| TrueNAS API key | `op://homelab/truenas-api-key/credential` |
| Cloudflare DNS token | `op://homelab/cloudflare-api-token/credential` |
| Google OAuth | `op://homelab/google-oauth-client-id/credential` |
| UniFi credentials | `op://homelab/unifi-admin/credential` |
| Paperclip auth secret | `op://homelab/paperclip-auth/BETTER_AUTH_SECRET` |
| Paperclip admin password | `op://homelab/paperclip-auth/ADMIN_PASSWORD` |
| Paperclip node pin | one node labelled `paperclip.homelab/pin=true` (server + operator bootstrap Job share the RWO iSCSI volume; `docs/apps/paperclip.md` "Node pin") |
| Paperclip agent credentials | `op://homelab/paperclip-api-keys`: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (API billing; the operator injects them) and/or `CLAUDE_CODE_OAUTH_TOKEN` (Claude subscription token from `claude setup-token`; an API key wins for Claude). Codex reads `/paperclip/.codex/auth.json` (`codex login --with-api-key` or `--device-auth` in the pod), never the host env |

## Tips

- Keep entries current (update when things change)
- Remove deprecated information after migration is complete
- Include both production and development details
- Add URLs to make navigation easier
- Mark deprecated items clearly with dates
