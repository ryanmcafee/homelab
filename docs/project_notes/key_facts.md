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

| Wave | Components |
|------|------------|
| -2 | SOPS secrets (1Password credentials) |
| -1 | Namespaces |
| 0 | 1Password Operator |
| 1-2 | CSR approver, Cilium LB IPAM, Democratic-CSI |
| 3-4 | cert-manager, external-dns |
| 5-6 | kube-prometheus-stack, Traefik |
| 7+ | Applications |

## Important Taskfile Commands

| Command | Description |
|---------|-------------|
| `task localdev:up` | Start Kind + Tilt local development |
| `task localdev:down` | Destroy local environment |
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
