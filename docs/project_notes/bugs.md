# Bug Log

Track bugs encountered during homelab infrastructure development along with their solutions. This helps avoid solving the same problems twice and preserves institutional knowledge.

## Format

Each entry should include:
- Date (YYYY-MM-DD)
- Brief description of the bug/issue
- Solution or fix applied
- Any prevention notes (optional)

## Entries

### 2025-01-27 - Ingresses returning 401/503 with oauth2-proxy middleware
- **Issue**: Multiple ingresses (Traefik, Grafana, Sonarr, Radarr, Prowlarr, Home Assistant) returning 401 authorization or 503 errors
- **Root Cause**: OAuth2-proxy middleware configuration issue (investigation pending)
- **Solution**: Disabled oauth2-proxy middleware annotations on all affected ingresses
- **Prevention**: Test oauth2-proxy separately before enabling on production ingresses
- **Commit**: 18eacc9

### 2026-01-28 - external-dns-unifi not creating DNS records for DNSEndpoint CRDs
- **Issue**: DNSEndpoint resources (e.g., traefik-dashboard) not creating internal DNS records in UniFi
- **Root Cause**: external-dns-unifi was configured with `--source=ingress` and `--source=service` but missing `--source=crd`. The `--annotation-filter` doesn't apply to CRD sources (they define DNS in spec, not annotations)
- **Solution**: Split into two instances: `external-dns-unifi-crd` (CRD source only) and `external-dns-unifi-ingress` (ingress/service with annotation filter). Each has separate txt-owner-id to avoid conflicts
- **Prevention**: For split-horizon DNS, use dedicated external-dns instances per source type when annotation filtering is needed

### 2026-01-28 - external-dns-unifi-crd missing RBAC for DNSEndpoint access
- **Issue**: external-dns-unifi-crd pod in CrashLoopBackOff with "dnsendpoints.externaldns.k8s.io is forbidden" error
- **Root Cause**: external-dns helm chart doesn't generate RBAC rules for `externaldns.k8s.io` API group even when `sources: [crd]` is configured
- **Solution**: Added manual ClusterRole and ClusterRoleBinding for `externaldns.k8s.io` API group permissions
- **Prevention**: When using CRD source with external-dns, verify RBAC includes `externaldns.k8s.io` API group

### 2026-01-28 - Traefik dashboard using self-signed certificate instead of Let's Encrypt
- **Issue**: Traefik dashboard at traefik.ryanmcafee.com showing self-signed certificate despite cert-manager Certificate existing
- **Root Cause**: ArgoCD `ignoreDifferences` rule on IngressRoute `.spec` was preventing TLS configuration from being applied
- **Solution**: Removed the ignoreDifferences rule for traefik-dashboard IngressRoute, allowing helm chart TLS settings to sync
- **Prevention**: Avoid blanket ignoreDifferences on `.spec` - use specific field paths instead

### 2026-01-28 - Traefik dashboard 404 at /dashboard without trailing slash
- **Issue**: https://traefik.ryanmcafee.com/dashboard returns 404, but /dashboard/ works
- **Root Cause**: Traefik's internal dashboard API requires a trailing slash on the path
- **Solution**: Added `dashboard-redirect-slash` Middleware and IngressRoute to redirect `/dashboard` to `/dashboard/`
- **Prevention**: Expected Traefik behavior - dashboard paths need trailing slash or redirect middleware

### 2026-01-28 - ArgoCD returning 500/Bad Gateway errors
- **Issue**: https://argocd.ryanmcafee.com returning "Bad Gateway" error, unable to access ArgoCD web UI
- **Root Cause**: TLS termination mismatch - Traefik ingress had `serversscheme: http` annotation but ingress backend port was 443. The argo-cd helm chart uses port 80 when `configs.params.server.insecure: "true"` but defaults to 443 otherwise
- **Solution**: Added `configs.params.server.insecure: "true"` to ArgoCD values, which tells helm chart to use HTTP port 80 for ingress backend
- **Prevention**: When using TLS termination at ingress (Traefik), always set `server.insecure: true` in ArgoCD config. Use Puppeteer browser validation, not just curl, to verify ingress accessibility
- **PR**: #23

### 2025-01-27 - Duplicate cloudflare-api-token OnePasswordItem in traefik
- **Issue**: Traefik addon had duplicate OnePasswordItem definition for cloudflare-api-token
- **Root Cause**: Copy-paste error when adding external-dns alongside traefik
- **Solution**: Removed duplicate OnePasswordItem from traefik template
- **Prevention**: Review templates for duplicate resource definitions before committing

### 2026-02-09 - NFS permission denied on media direct mounts (downloads, movies, tv, etc.)
- **Issue**: NZBGet (and potentially other media apps) couldn't write to `/mnt/storage/downloads` via direct NFS mount
- **Root Cause**: PRs #83-86 fixed k8s CSI-provisioned NFS shares to use `mapall=apps:users`, but direct media NFS shares (movies, tv, downloads, books, etc.) were still using `mapall=rmcafee:users`. Dataset ownership was `rmcafee`, not `apps` (UID 568). The `truenas-nfs-mapall.ts` script only targeted k8s paths by default.
- **Solution**:
  1. Extended `truenas-nfs-mapall.ts` to include media datasets in `--fix-permissions` when `--all` is used
  2. Ran `truenas-nfs-mapall.ts --all --fix-permissions` to update all 7 media NFS shares to `mapall=apps:users` and set all 11 datasets to `uid=568 gid=100 mode=770`
  3. Updated Ansible defaults: `truenas_media_nfs_mapall_user` and `truenas_dataset_owner_user` changed from `rmcafee` to `apps`
  4. Fixed Ansible `set_dataset_permissions.yml` traverse flag from `false` to `true`
- **Prevention**: Use a single permission model (apps:users 568:100) for all NFS shares. Always run with `--all` when fixing permissions. See ADR-006.
- **Update (2026-02-09)**: ADR-006 partially reversed per ADR-007 — media datasets moved back to `rmcafee:users`, k8s datasets remain `apps:users`. Script now supports split k8s/media model with `--media-mapall-user` and `--media-perm-user` flags.

### 2026-02-09 - Plex SQLite database locking errors on NFS
- **Issue**: Plex stores SQLite databases on NFS-backed PVC (`democratic-csi-ssd`). SQLite relies on POSIX file locking (`fcntl()`) which is unreliable over NFS, causing `Sqlite3: Sleeping for 200ms to retry busy DB` errors and restart loops
- **Root Cause**: NFS does not reliably support POSIX file locking required by SQLite. This is a fundamental protocol limitation, not a configuration issue
- **Solution**: Added iSCSI block storage via democratic-csi (`democratic-csi-iscsi` storage class). iSCSI provides a proper block device with reliable file locking. Migrated Plex config PVC from NFS to iSCSI
- **Prevention**: Use iSCSI (block storage) instead of NFS for any application that relies on SQLite or POSIX file locking

### 2026-02-14 - LoadBalancer VIPs unreachable when L2 lease on control-plane node
- **Issue**: Plex, traefik-external, and other services with L2 leases on control-plane nodes were unreachable from outside the cluster. `172.16.100.200` returned connection refused/timeout while `172.16.100.104` (on worker node) worked fine
- **Root Cause**: Proxmox VMs hosting control-plane nodes block gratuitous ARP for VIPs. Cilium L2 announcements from control-plane nodes never reach the external network, so clients can't resolve the VIP MAC address
- **Solution**: Added `nodeSelector` with `matchExpressions` (`node-role.kubernetes.io/control-plane` DoesNotExist) to `CiliumL2AnnouncementPolicy` to restrict L2 announcements to worker nodes only
- **Prevention**: Always exclude control-plane nodes from L2 announcement policies in Proxmox-hosted clusters. If services become unreachable, check which node holds the L2 lease (`kubectl get leases -n kube-system | rg cilium-l2announce`)
- **PR**: #138

### 2026-02-14 - ArgoCD ingress returning 404 due to stale OIDC middleware annotation
- **Issue**: ArgoCD web UI returned 404 error
- **Root Cause**: Stale `traefik.ingress.kubernetes.io/router.middlewares: traefik-oidc-auth@kubernetescrd` annotation on ArgoCD ingress. The `traefikoidc` plugin is only loaded on `traefik-external`, but ArgoCD uses `traefik-internal` (ingressClassName: internal) which can't process the middleware
- **Solution**: Removed the annotation from `terragrunt/modules/gitops-bootstrap/templates/argocd-values.yaml.tpl`
- **Prevention**: Only apply middleware annotations for plugins loaded on the corresponding Traefik instance
- **PR**: #137

### 2026-03-06 - ArgoCD repo-server CrashLoopBackOff after KSOPS v4.4.0 upgrade
- **Issue**: ArgoCD repo-server pods in CrashLoopBackOff with `exec: "/bin/sh": stat /bin/sh: no such file or directory`
- **Root Cause**: Renovate PR #168 bumped `viaductoss/ksops` from v4.3.2 to v4.4.0. The v4.4.0 image switched to distroless (`distroless/base`) which has no `/bin/sh` or `/bin/cp`. The init container used `/bin/sh -c` to copy ksops binaries, which fails on distroless
- **Solution**: Baked ksops binaries into the `homelab-cmp` image via multi-stage Docker build (`COPY --from=ksops`). Changed init container to use the CMP image with `/bin/cp` instead of the ksops image with `/bin/sh`. Bumped CMP image to 0.1.4
- **Prevention**: Added Renovate guardrail to disable auto-merge for `viaductoss/ksops` docker updates. Future ksops version bumps require manual testing. Consider that any dependency could switch to distroless at any time

### Known Common Errors (from CLAUDE.md)

These are documented errors with known solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| "OnePasswordItem not found" | 1Password Operator not ready | Check sync wave ordering (wave -2 for SOPS secrets, wave 0 for 1Password Operator) |
| "Unable to find valid certification path" | TrueNAS TLS not trusted | Democratic-CSI uses allowInsecure |
| "dry run failed" | Server-side apply conflicts | Add ServerSideApply=true to syncOptions |
| Ingress "Progressing" forever | No LoadBalancer IP | Custom health check marks Ingress Healthy |

## Tips

- Keep descriptions under 2-3 lines
- Focus on the lesson learned, not just the fix
- Include enough context for future reference
- Clean out very old entries periodically (6+ months)
