# Dual Traefik Ingress Controller Design

**Date:** 2026-02-13
**Status:** Approved

## Summary

Deploy two independent Traefik ingress controllers — one external-facing (Plex) and one internal-facing (all other apps). Each gets its own LoadBalancer IP, IngressClass, ArgoCD applications, and dashboard.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| IngressClass names | `external`, `internal` | Short, clear, descriptive |
| Internal LB IP | Dynamic (Cilium IPAM) | Simpler; no port forwarding needed |
| External LB IP | Static `172.16.100.200` | Unchanged from current setup |
| OIDC placement | External only | Plex has own auth; internal apps don't need OIDC |
| OIDC annotations on internal apps | Removed | Internal Traefik won't have OIDC plugin |
| Port forwarding | External only | Only Plex needs external access |
| DNS records | Both instances | Both get external-dns records via annotations |
| Dashboards | Both instances | `traefik.ryanmcafee.com` (external), `traefik-internal.ryanmcafee.com` (internal) |
| Template approach | Separate files | Matches project patterns, independent and readable |

## ArgoCD Application Structure

### External (renamed from existing)

| Old Name | New Name | Sync Wave | Purpose |
|----------|----------|-----------|---------|
| `traefik-dependencies` | `traefik-external-dependencies` | 5 | 1Password secrets (OIDC, Cloudflare) |
| `traefik` | `traefik-external` | 6 | External Traefik Helm release |
| — | OIDC Redis (inline) | 7 | Redis for OIDC session storage |
| `traefik-config` | `traefik-external-config` | 8 | Dashboard, OIDC middleware, DNS records |

### Internal (new)

| Name | Sync Wave | Purpose |
|------|-----------|---------|
| `traefik-internal-dependencies` | 5 | Secrets (minimal, may be empty initially) |
| `traefik-internal` | 6 | Internal Traefik Helm release |
| `traefik-internal-config` | 8 | Dashboard IngressRoute + DNS records |

Both instances deploy into the `traefik` namespace.

## Helm Values Structure

### External Traefik (`traefikExternal.*`)

- IngressClass: `external`
- LoadBalancer: static IP `172.16.100.200`
- Port forwarding: enabled (`port-forwarding.ryanmcafee.com/enable: "true"`)
- OIDC plugin: traefikoidc v0.8.21
- OIDC Redis: deployed (wave 7)
- Dashboard: `traefik.ryanmcafee.com`
- Replicas: 2-5 (autoscaling)

### Internal Traefik (`traefikInternal.*`)

- IngressClass: `internal`
- LoadBalancer: dynamic IP (Cilium IPAM pool)
- Port forwarding: disabled
- OIDC: not installed
- Dashboard: `traefik-internal.ryanmcafee.com`
- Replicas: 2-5 (autoscaling)

## Application Ingress Mapping

| Application | IngressClass | OIDC Middleware |
|-------------|-------------|-----------------|
| Plex | `external` | None (Plex has own auth) |
| Sonarr | `internal` | Removed |
| Radarr | `internal` | Removed |
| Prowlarr | `internal` | Removed |
| NZBGet | `internal` | Removed |
| Tautulli | `internal` | Removed |
| LazyLibrarian | `internal` | Removed |
| Home Assistant | `internal` | Removed |
| ArgoCD server | `internal` | — |
| Grafana | `internal` | — |
| External dashboard | `external` | — |
| Internal dashboard | `internal` | — |

## File Changes

### Templates (charts/addons/templates/)

- **Delete:** `traefik.yaml`
- **New:** `traefik-external.yaml` — external Traefik ArgoCD apps + OIDC Redis
- **New:** `traefik-internal.yaml` — internal Traefik ArgoCD apps (no OIDC)

### Helper Charts

- **Rename:** `charts/traefik-dependencies/` → `charts/traefik-external-dependencies/`
- **Rename:** `charts/traefik-config/` → `charts/traefik-external-config/`
- **New:** `charts/traefik-internal-dependencies/` (minimal)
- **New:** `charts/traefik-internal-config/` (dashboard + DNS only)

### Values Files (charts/addons/)

- `values.yaml`: Replace `traefik:` → `traefikExternal:`, add `traefikInternal:`
- `values-homelab.yaml` / `values-homelab.generated.yaml`: Same split
- `values-localdev.yaml`: Same split (both NodePort in localdev)

### Application Values (charts/applications/)

- `values.yaml`: `ingressClassName: traefik` → `internal` (all apps), `external` (Plex only)
- `values-homelab.generated.yaml`: Same + remove OIDC middleware annotations from internal apps

### ArgoCD Values (charts/addons/)

- ArgoCD server ingress: `ingressClassName: traefik` → `internal`

### No Changes Needed

- Cilium LB IPAM pool (already covers dynamic allocation)
- BGP configuration
- External-DNS (works on both ingress classes)
- Cert-manager
