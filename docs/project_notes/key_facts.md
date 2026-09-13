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
- 2 Control Plane nodes (HA)
- 3 Worker nodes (1 with GPU)
- Talos Linux on all nodes
- Proxmox VE virtualization

**Storage:**
- Provider: Democratic-CSI with NFS and iSCSI
- Backend: TrueNAS RAIDZ3 (~220 TB raw) + SSD mirror pool
- Storage Classes:
  - `democratic-csi-nfs` (default) - NFS on HDD pool
  - `democratic-csi-ssd` - NFS on SSD pool
  - `democratic-csi-iscsi` - iSCSI block storage on SSD pool (for SQLite workloads)

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

`homelab verify gitops` enforces the conventions this table describes
(`gitops/<env>/waves`, `gitops/<env>/crd-order`); read the rendered
`tests/snapshots/<env>/*.yaml` for the exact wave on any one object rather than
trusting a prose table.

## Important Taskfile Commands

| Command | Description |
|---------|-------------|
| `task localdev:up` | Start Kind + Tilt local development |
| `task localdev:down` | Destroy local environment |
| `task verify` | Level-0 static verification (render, schema, gitops graph, snapshots, policy) — JSON |
| `task verify:text` | Same checks, human-readable |
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
| Kubernetes | Kind | Talos Linux |
| Storage | local-path-provisioner | Democratic-CSI NFS |
| Load Balancer | disabled/NodePort | Cilium LB IPAM + BGP |
| Secrets | Fake/disabled | 1Password + SOPS |
| GPU | None | NVIDIA (see CLAUDE.local.md) |

## Important URLs (Production)

**Management:**
- ArgoCD: `https://argocd.{domain}`
- Grafana: `https://grafana.{domain}`

**Applications:**
- Plex: `https://plex.{domain}`
- Sonarr: `https://sonarr.{domain}`
- Radarr: `https://radarr.{domain}`
- Home Assistant: `https://homeassistant.{domain}`

(Replace `{domain}` with actual domain from CLAUDE.local.md)

## 1Password Vault Paths

| Purpose | Path |
|---------|------|
| SOPS encryption key | `op://homelab/sops-age-key/private_key` |
| TrueNAS API key | `op://homelab/truenas-api-key/credential` |
| Cloudflare DNS token | `op://homelab/cloudflare-api-token/credential` |
| Google OAuth | `op://homelab/google-oauth-client-id/credential` |
| UniFi credentials | `op://homelab/unifi-admin/credential` |

## Tips

- Keep entries current (update when things change)
- Remove deprecated information after migration is complete
- Include both production and development details
- Add URLs to make navigation easier
- Mark deprecated items clearly with dates
