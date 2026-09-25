# Bug Log

Track bugs encountered during homelab infrastructure development along with their solutions. This helps avoid solving the same problems twice and preserves institutional knowledge.

## Format

Each entry should include:
- Date (YYYY-MM-DD)
- Brief description of the bug/issue
- Solution or fix applied
- Any prevention notes (optional)

## Entries

### 2026-09-25 - netflowreceiver emits no receiver self-metrics, alert could never clear
- **Issue**: `HomelabUniFiTelemetrySilent` fired for `netflow` without end although ClickHouse `otel.otel_logs` held thousands of flow records (`ScopeName = otelcol/netflowreceiver`); the flows also had an empty ServiceName and the gateway logged OTTL "silently ignored a nil value" warnings
- **Root Cause**: The alert read `otelcol_receiver_accepted_log_records{receiver=~"syslog.*|netflow"}`, but the contrib `netflowreceiver` (v0.160.0) does not use the receiver obsreport helper, so Prometheus had no series with `receiver="netflow"` and the `absent()` branch stayed true. `transform/service-name` set `service.name` from `k8s.container.name`, which flows do not carry
- **Solution**: The gateway logs pipeline also exports to a `count/unifi` connector; `metrics/unifi` (transform, `delta_to_cumulative`, `prometheus/unifi` on 8889, scraped by the gateway PodMonitor) exposes `homelab_unifi_telemetry_records_total{source}`, and the alert fires per source on a zero 30m rate or an absent series. `transform/service-name` sets ServiceName `unifi-netflow` for scope `otelcol/netflowreceiver` and only copies `k8s.container.name` when it exists. The `logging` e2e suite checks the syslog count
- **Prevention**: Before alerting on `otelcol_receiver_*` for a receiver, confirm Prometheus has a series for it; count records with the count connector when a receiver has no self-metrics. The count connector emits deltas stamped with record times, which the Prometheus exporter does not add up, so restamp them and run `delta_to_cumulative` first

### 2026-09-23 - Paperclip agents failed with TLS/connection errors calling https://paperclip.<domain>
- **Issue**: From `paperclip-0`, every request to the public URL (and any host on the traefik-internal LB IP) reset or timed out during the TLS handshake after 10 s (`curl: (35) Recv failure: Connection reset by peer`, node `ECONNRESET`); agents reported this as TLS/signing failures. The same URLs worked from non-paperclip pods and the internet worked from the pod
- **Root Cause**: Cilium evaluates egress policy after the LoadBalancer DNAT, so a connection to the traefik-internal LB IP on 443 is checked as `traefik-internal:8443`. The operator's NetworkPolicy allows egress only on 53, 443, 4317/4318 and 5432, so Hubble showed `Policy denied DROPPED` on the SYN; ztunnel logged `deadline has elapsed`
- **Solution**: `charts/paperclip/templates/networkpolicy-ingress-controller.yaml` allows egress to the Traefik pods on their container ports 8000/8443 (`security.networkPolicy.ingressController`)
- **Prevention**: When a policy allows a Service port, allow the backend container port too; debug with `hubble observe --ip <pod-ip>` from the node's cilium agent

### 2026-09-23 - BGP sessions established but advertised 0 routes; worker sessions never came up
- **Issue**: Read-only check of production: the three control-plane sessions to the UniFi gateway were Established with 0 prefixes sent, and the gateway's three worker neighbors could never establish (no speaker ran on the workers). LoadBalancer IPs were reachable only through the worker L2 (ARP) announcements, without ECMP
- **Root Cause**: `CiliumBGPPeerConfig unifi-gateway-peer` had no `spec.families[].advertisements` selector and `CiliumBGPAdvertisement loadbalancer-ips` had no labels; in the Cilium v2 BGP API nothing is advertised unless a family selects an advertisement. Separately, `CiliumBGPClusterConfig homelab-bgp` ran speakers on the control planes while the gateway also listed the workers, and the FRR template had no `maximum-paths`
- **Solution**: Peer config negotiates `ipv4/unicast` with `advertisements.matchLabels: {advertise: loadbalancer-ips}`, the advertisement carries that label; speakers moved to the workers (control-plane `DoesNotExist`); `unifi-gateway` peers with `worker_nodes` only and renders `maximum-paths` (ADR-023)
- **Prevention**: After any BGP change check `vtysh -c "show ip bgp summary"` for PfxRcd > 0, not just Established; the level-0 render proves only that the CRs are valid, not that they select anything

### 2026-09-23 - Traefik syncs denied: chart ships Gateway API v1.4 CRDs, Gateway API v1.6 VAP forbids them
- **Issue**: In the PR #321 Kind loop `traefik-internal` and `traefik-external` ended Failed after three retries on `backendtlspolicies`, `referencegrants`, `grpcroutes`, `httproutes` (gateway.networking.k8s.io): "Installing CRDs with version before v1.5.0 is prohibited by default"
- **Root Cause**: The traefik chart 39.0.9 carries `crds/gateway-standard-install.yaml` (bundle v1.4.0) and ArgoCD applies a chart's `crds/` directory. The new `gateway-api-crds` Application (v1.6.2, for Istio waypoints) installs the ValidatingAdmissionPolicy `safe-upgrades.gateway.networking.k8s.io`, which denies any Gateway API CRD older than v1.5. The same would have failed every production Traefik sync
- **Solution**: New `traefik-crds` Application (chart `traefik-crds` 1.14.1, released with traefik 39.0.9, identical traefik.io CRDs; Gateway API, Hub and Knative off) at addons wave 4; both Traefik Applications set `helm.skipCrds: true`; `tests/gitops/crd-providers.yaml` names `traefik-crds` for traefik.io; Renovate groups `traefik` and `traefik-crds`. Gateway API CRDs come only from `gateway-api-crds`. Cilium (`gatewayAPI.enabled: false`) and Istio base ship no Gateway API CRDs
- **Transition (production)**: checked read-only on 2026-09-23 through `homelab-readonly`: the live traefik.io, hub.traefik.io and gateway.networking.k8s.io CRDs carry no `argocd.argoproj.io/tracking-id` annotation (the tracking method is the ArgoCD 3 default, annotation), so `traefik-internal`/`traefik-external` do not own them and cannot prune them when they stop rendering them. `traefik-crds` (wave 4) syncs and becomes Healthy before the Traefik Applications (wave 6) are updated, and then owns the traefik.io CRDs. The hub.traefik.io CRDs stay in the cluster unowned (unused; delete by hand if wanted); the Gateway API CRDs move from v1.4 to v1.6 through `gateway-api-crds` (an upgrade, which the policy allows)
- **Prevention**: A chart's `crds/` directory is applied by ArgoCD unless `skipCrds` is set; when two Applications could install the same CRD group, give the group one owner in `crd-providers.yaml` and skip it everywhere else

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
- **Issue**: Traefik dashboard at traefik.<DOMAIN> showing self-signed certificate despite cert-manager Certificate existing
- **Root Cause**: ArgoCD `ignoreDifferences` rule on IngressRoute `.spec` was preventing TLS configuration from being applied
- **Solution**: Removed the ignoreDifferences rule for traefik-dashboard IngressRoute, allowing helm chart TLS settings to sync
- **Prevention**: Avoid blanket ignoreDifferences on `.spec` - use specific field paths instead

### 2026-01-28 - Traefik dashboard 404 at /dashboard without trailing slash
- **Issue**: https://traefik.<DOMAIN>/dashboard returns 404, but /dashboard/ works
- **Root Cause**: Traefik's internal dashboard API requires a trailing slash on the path
- **Solution**: Added `dashboard-redirect-slash` Middleware and IngressRoute to redirect `/dashboard` to `/dashboard/`
- **Prevention**: Expected Traefik behavior - dashboard paths need trailing slash or redirect middleware

### 2026-01-28 - ArgoCD returning 500/Bad Gateway errors
- **Issue**: https://argocd.<DOMAIN> returning "Bad Gateway" error, unable to access ArgoCD web UI
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
- **Root Cause**: PRs #83-86 fixed k8s CSI-provisioned NFS shares to use `mapall=apps:users`, but direct media NFS shares (movies, tv, downloads, books, etc.) were still using `mapall=<NFS_MAPALL_USER>:users`. Dataset ownership was `<NFS_MAPALL_USER>`, not `apps` (UID 568). The `truenas-nfs-mapall.ts` script only targeted k8s paths by default.
- **Solution**:
  1. Extended `truenas-nfs-mapall.ts` to include media datasets in `--fix-permissions` when `--all` is used
  2. Ran `truenas-nfs-mapall.ts --all --fix-permissions` to update all 7 media NFS shares to `mapall=apps:users` and set all 11 datasets to `uid=568 gid=100 mode=770`
  3. Updated Ansible defaults: `truenas_media_nfs_mapall_user` and `truenas_dataset_owner_user` changed from `<NFS_MAPALL_USER>` to `apps`
  4. Fixed Ansible `set_dataset_permissions.yml` traverse flag from `false` to `true`
- **Prevention**: Use a single permission model (apps:users 568:100) for all NFS shares. Always run with `--all` when fixing permissions. See ADR-006.
- **Update (2026-02-09)**: ADR-006 partially reversed per ADR-007 — media datasets moved back to `<NFS_MAPALL_USER>:users`, k8s datasets remain `apps:users`. Script now supports split k8s/media model with `--media-mapall-user` and `--media-perm-user` flags.

### 2026-02-09 - Plex SQLite database locking errors on NFS
- **Issue**: Plex stores SQLite databases on NFS-backed PVC (`democratic-csi-ssd`). SQLite relies on POSIX file locking (`fcntl()`) which is unreliable over NFS, causing `Sqlite3: Sleeping for 200ms to retry busy DB` errors and restart loops
- **Root Cause**: NFS does not reliably support POSIX file locking required by SQLite. This is a fundamental protocol limitation, not a configuration issue
- **Solution**: Added iSCSI block storage via democratic-csi (`democratic-csi-iscsi` storage class). iSCSI provides a proper block device with reliable file locking. Migrated Plex config PVC from NFS to iSCSI
- **Prevention**: Use iSCSI (block storage) instead of NFS for any application that relies on SQLite or POSIX file locking

### 2026-02-14 - LoadBalancer VIPs unreachable when L2 lease on control-plane node
- **Issue**: Plex, traefik-external, and other services with L2 leases on control-plane nodes were unreachable from outside the cluster. `<TRAEFIK_STATIC_IP>` returned connection refused/timeout while an address in the LB pool (on worker node) worked fine
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

### 2026-09-12 - Child values-homelab.yaml carried PII; .gitignore note claimed they were PII-free
- **Issue**: ~20 committed `charts/*/values-homelab.yaml` (traefik-*-config, cert-manager-cluster-issuer, the 12 iSCSI `*-config` charts, duckdns, bootstrap) contained the production domain, hostnames, TrueNAS iSCSI portal IP, Traefik static IP, ACME e-mail and DuckDNS subdomain. The `.gitignore` comment asserted these files "carry only 1Password item paths / namespaces — no PII", and level 0 needed 9 `hostname-domain` policy exemptions to pass
- **Root Cause**: Child Applications render with plain `helm.valueFiles`, never through the CMP, so the 2026-02-11 PII removal only sanitized the parent charts. The PII guard scanned only `configuration/`, so the leak was invisible to pre-commit and CI
- **Solution**: Parent Applications pass derived values to children via `helm.valuesObject` (ADR-010); child `values-homelab.yaml` reduced to non-derived settings; bootstrap hostname derived from a Terraform-injected `global.domain`; `.gitignore` note rewritten; exemptions removed
- **Prevention**: `homelab config guard` default scope is now `configuration/**` + `charts/**/values-homelab.yaml`, with shape rules for Helm-style keys (`host`, `portal`, `staticIP`, `email`, `dnsZones` items), so a real hostname, routable IP or mailbox in any child values file fails pre-commit and CI. Never add a `configuration/`-derived value to a child `values-homelab.yaml`; add it to the parent's export template and `valuesObject` instead
- **PR**: #265 (GitHub issue #262)

### 2026-09-12 - Tilt CI (Direct Mode) flaking on `main` with cert-manager "apply command timed out after 30s"
- **Issue**: Push-to-main Tilt CI runs 34724814567 and 34730721014 failed at `cert-manager │ ERROR: Build Failed: apply command timed out after 30s`, with identical code passing minutes earlier on the PR branch
- **Root Cause**: `helm_resource` apply commands are bounded by Tilt's `k8s_upsert_timeout_secs` (default 30s). The cert-manager `helm upgrade --install` (repo index fetch + `installCRDs=true`) measures 18-28s on GitHub-hosted runners in passing runs, so it races the default and loses under runner load. Traefik installs in ~8-15s and never trips it
- **Solution**: `update_settings(k8s_upsert_timeout_secs=120)` in `localdev/Tiltfile`; `tilt ci --timeout 10m` still bounds a genuinely hung apply
- **Prevention**: When a Tilt-driven install gets slower (new CRDs, bigger charts), check `Step 1 - N.NNs (Deploying)` in the Tilt CI log against the upsert timeout before blaming the chart
- **PR**: #268

### 2026-09-12 - Hand-written localdev values carried dead keys and a mismatched domain
- **Issue**: `charts/{addons,applications}/values-localdev.yaml` set `global.domain: homelab.test` while `configuration/environments/localdev.yaml` and `charts/gitops/values-localdev.yaml` said `homelab.local`, so Ingress hostnames never matched the gitops chart. Most override keys (kube-prometheus-stack `prometheusSpec`, traefik `ports.*.nodePort`/`globalArguments`, `cert-manager.selfSigned`, app-level `resources`/`service` for TrueCharts apps, `persistence.media`) were never read by the chart templates, so the intended Kind trims were no-ops, and Prometheus/Grafana asked for the `democratic-csi-nfs` storage class that does not exist in Kind. Chart versions lagged `versions.yaml` and stale blocks (qbittorrent, jellyfin, 1password-operator) lingered
- **Root Cause**: The file was maintained by hand next to the templates it duplicated; nothing compared it with `configuration/` or with what the Application templates actually consume
- **Solution**: Generate both files from `configuration/templates/helm-{addons,apps}.tmpl` with `homelab config export --set localdev` (`task config:export:localdev`) and commit them; environment differences became capability keys in `platform.schema.yaml` (ADR-011, issue #263)
- **Prevention**: Level-0 check `render/localdev/_committed-values` fails with a diff when the committed files differ from the export; the pre-commit `config-export` hook regenerates them on any `configuration/**` change. Never hand-edit `values-localdev.yaml`

### 2026-09-13 - Tilt `--mode=argocd` flag was silently ignored
- **Issue**: `tilt up -- --mode=argocd` (documented in the Tiltfile, `docs/local-development.md` and the Taskfile) always started direct mode; only `TILT_MODE=argocd` in the environment switched modes
- **Root Cause**: `localdev/Tiltfile` read `os.getenv("TILT_MODE", "direct")` and never called `config.define_string`/`config.parse()`, so Tiltfile arguments were dropped
- **Solution**: `config.define_string("mode")` + `config.parse()`, with `TILT_MODE` as the fallback and a `fail()` on unknown values (issue #261 Section B)
- **Prevention**: `task localdev:tilt:argocd` is the documented entry point; `kind-direct` and `kind-argocd` in `tilt-ci.yml` exercise both paths

### 2026-09-13 - ArgoCD mode root Application pointed at `file://../charts` and a hostPath that was never mounted
- **Issue**: In ArgoCD mode nothing ever synced: the root Application had `repoURL: file://../charts`, and the ArgoCD values mounted a repo-server hostPath `/charts` that no Kind node provided (`kind-config.yaml` had no `extraMounts`), so the repo server could not even resolve the path. The CI job hid this with `continue-on-error: true`
- **Root Cause**: ArgoCD fetches git and Helm repositories over the network; a relative `file://` URL is not a repository, and a hostPath inside a Kind node only exists if Kind mounts it from the host
- **Solution**: The root Application (`localdev/argocd/gitops-app.yaml`) points at GitHub `main`; every Application is synced from the working tree with `argocd app sync --local` by `scripts/localdev-argocd.ts sync`; the hostPath volume, `file://` repository entry and `argocd-values-ci.yaml` are gone; the CI job is required (ADR-012)
- **Prevention**: `task verify LEVEL=2` and the `kind-argocd` job fail on any Application that is not Healthy/Succeeded

### 2026-09-13 - NodePort 30080 claimed by both ArgoCD and Traefik
- **Issue**: Kind maps container port 30080 to host 8080 for the ArgoCD UI, but the direct-mode Tiltfile Traefik and the old hand-written addons values also asked for NodePort 30080; running Traefik and ArgoCD in one cluster would have failed the second Service with "provided port is already allocated"
- **Root Cause**: One NodePort range shared by two components with no single place listing the reservations
- **Solution**: ArgoCD keeps 30080 (`localdev/values/argocd-values.yaml`); the Traefik Applications get dynamic NodePorts in localdev; mosquitto is pinned to 31883/31901 and spegel to 30021. Direct-mode Tilt Traefik keeps 30080 because ArgoCD is absent in that mode
- **Prevention**: The reserved ports are listed in `docs/project_notes/key_facts.md` "Localdev"; regenerate the localdev values and check `nodePort` before pinning a new one

### 2026-09-13 - Localdev Applications referenced PVCs and NFS servers that do not exist in Kind
- **Issue**: Plex rendered `configExistingClaim: <PLEX_CONFIG_PVC>` and every TrueCharts app rendered `persistence.config.existingClaim: <APP>_CONFIG_PVC` regardless of environment, so in Kind the pods waited forever on PVCs nothing creates; media and download mounts were `nfs: server: <TRUENAS_HOSTNAME>` (127.0.0.1 in localdev) and failed to mount
- **Root Cause**: `helm-apps.tmpl` assumed democratic-csi and a TrueNAS NFS export everywhere; storage and media were not capability keys
- **Solution**: When `STORAGE_PROVIDER` is not `democratic-csi` the templates render a dynamic claim (`storageClassName`/`storageClass: <STORAGE_CLASS_ISCSI>` + `size: 1Gi`); a new `MEDIA_PROVIDER` key (`nfs`|`ephemeral`) renders the media/download volumes as `emptyDir` in localdev; `localdev/fakes/storageclasses.yaml` aliases the `democratic-csi-*` classes to local-path for anything that still names them
- **Prevention**: Level 2 (`argocd/<app>`, `e2e/<app>`) fails when a pod stays Pending; new storage references go behind a capability key

### 2026-09-13 - Mosquitto NodePort Service rendered without an explicit nodePort
- **Issue**: With `LOAD_BALANCER_ENABLED=false` mosquitto's Services became `type: NodePort` but carried no `nodePort`, which the TrueCharts common library rejects, so the Application never synced in Kind
- **Root Cause**: The template only flipped `type`; TrueCharts requires a fixed port for NodePort Services
- **Solution**: `helm-apps.tmpl` sets `nodePort: 31883` (MQTT) and `31901` (WebSocket) when the load balancer is off
- **Prevention**: `tests/e2e/mosquitto` connects to the Service; the ports are reserved in `key_facts.md`

### 2026-09-13 - Dead `argocd:` block in `helm-apps.tmpl`
- **Issue**: `helm-apps.tmpl` emitted a large `argocd:` values block (chart, CMP sidecar, server config) that no template in `charts/applications` reads; it only made the generated `values-localdev.yaml` longer and suggested ArgoCD was configured there
- **Root Cause**: Left over from before the bootstrap chart took over ArgoCD (ADR on the CMP, 2026-02-11)
- **Solution**: Removed; ArgoCD is configured by `charts/bootstrap/templates/argocd.yaml` (homelab) and `localdev/values/argocd-values.yaml` (Kind)
- **Prevention**: `internal/config/contract_test.go` only checks keys, not consumers; when adding a values block, name the template that reads it in a comment

### 2026-09-13 - Root Tiltfile pointed at a `plan.md` that does not exist
- **Issue**: The welcome message listed `Plan: plan.md`; the file was never committed
- **Solution**: Replaced with `docs/local-development.md`
- **Prevention**: Prefer links to files under `docs/`; `rg --files` before adding a path to a banner

### 2026-09-13 - `charts/gitops/values-localdev.yaml` tracked `HEAD` while the root Application tracked `main`
- **Issue**: Child Applications rendered by the gitops chart carried `targetRevision: HEAD`, the root Application `main`, so a plain `argocd app sync` on a child could resolve a different revision than its parent, and the three hard-coded `syncPolicy.automated` blocks in the file would have reverted any `--local` sync
- **Root Cause**: The localdev overrides predated the local-sync design and were never compared with the root Application
- **Solution**: `global.targetRevision: main`, `global.automatedSync: false`, the automated blocks removed (ARGOCD_AUTOMATED_SYNC, ADR-012)
- **Prevention**: `localdev/argocd/gitops-app.yaml` and the values file both state the revision in a comment; the `app-automated` policy is skipped only when `_data.yaml` says `argocd_automated_sync: false`

### 2026-09-13 - Kind + Cilium on Docker Desktop (macOS): host port mappings never complete a TCP handshake
- **Issue**: With Cilium as the Kind CNI, none of the `extraPortMappings` in `localdev/kind-config.yaml` (30080→8080 for ArgoCD, 80→9080, 443→9443) worked from macOS: `curl localhost:8080` hung, the ArgoCD CLI login timed out, yet in-cluster traffic and `kubectl port-forward` were fine
- **Root Cause**: Docker Desktop's port forwarder emits packets with bad TCP checksums. With kindnet the kernel path skipped validation, so it went unnoticed; Cilium's BPF endpoint delivery hands the packet to the pod, which validates it and drops every SYN (`TcpInCsumErrors` in the pod netns grows by 3 per SYN; verified with `conntrack` and `cilium monitor`)
- **Solution**: `scripts/localdev-argocd.ts` owns a `kubectl port-forward` to `argocd-server` (default `127.0.0.1:18080`, `--local-port` to change) instead of the NodePort; for humans `task localdev:ui` port-forwards the ArgoCD UI to http://localhost:8080 and `task localdev:traefik` port-forwards Traefik internal to 9080/9443. The NodePort and the Kind mappings stay for Linux Docker, where they work
- **Prevention**: Never rely on Kind host port mappings from macOS; e2e and smoke checks run in-cluster, and every host-side access goes through `kubectl port-forward`

### 2026-09-13 - `tilt-ci.yml` pinned its own Kind node image and let the ArgoCD job fail silently
- **Issue**: The workflow created Kind with `kindest/node:v1.32.0` and `kubectl v1.32.0` (versions.yaml said v1.36.1), installed the latest `argocd` and `tilt` unpinned, and marked the ArgoCD-mode job `continue-on-error: true`, so nothing it did could fail a pull request
- **Root Cause**: Tool versions hard-coded in the workflow with no Renovate markers and no link to `configuration/versions.yaml`
- **Solution**: Rewritten: `env:` pins with `# renovate:` markers mirroring `versions.yaml`, the cluster comes from `task localdev:kind` (node image from `images.kind-node`), and `kind-argocd` is required with a 45-minute timeout
- **Prevention**: Every pinned tool in a workflow carries a Renovate marker; `docs/runbooks/verification.md` "Tooling" lists the files that must agree

### 2026-09-13 - gitops-test skill still carried prod-mutating commands and the production domain
- **Issue**: After ADR-009 "retired" Tiers 3–4, `.claude/skills/gitops-test/SKILL.md` still contained complete `kubectl apply` / `kubectl patch application ... targetRevision` / `argocd app sync --force` recipes against the live cluster (marked human-only), plus a webhook section naming the production ArgoCD hostname
- **Root Cause**: The skill was annotated rather than rewritten; an agent following a code block does not read the banner above it
- **Solution**: Rewritten around the verification contract (level-0 hook, Kind levels 1–2, PR claim, read-only production via `homelab-readonly`); every apply/patch/sync/repoint command and the domain removed (issue #261 item 22, ADR-014)
- **Prevention**: `pr-contract.yml` and the hook make the contract executable; agents read production only through the read-only context

### 2026-09-13 - `localdev:sync --warm` / `--only` could hang forever on a fresh cluster
- **Issue**: On a fresh Kind cluster `task drill:restore` (and `task localdev:warm`) sometimes never finished: the sync loop ended, and the final pass waited indefinitely on `addons`, whose operation stayed Running
- **Root Cause**: `syncLoop` in `scripts/localdev-argocd.ts` ended as soon as nothing was active and `nextTier` found no unsynced Application. A parent still holding a sync wave open (e.g. traefik's wave 7) creates its later-wave children only after that wave is Healthy, so they appeared after the loop had already stopped and nobody synced them. A full sync hid it because applications-tier work kept the loop busy
- **Solution**: Before ending, the loop checks `parentsAwaitingWaves` (parents whose operation is Running) and keeps polling until their next children appear or the operations settle, bounded by the sync timeout (issue #261, found by the restore drill)
- **Prevention**: Unit test for `parentsAwaitingWaves`; the weekly `restore-drill.yml` runs `sync --warm` on a fresh runner every week

### 2026-09-13 - `task test:e2e` ran chainsaw against the current kube context
- **Issue**: `test:e2e` invoked `chainsaw test` without `--kube-context`, so a workstation whose current context was production would have created test namespaces, Jobs and a CNPG Cluster there — against ADR-009, which every other localdev script honours by pinning `kind-homelab-localdev`
- **Solution**: `--kube-context kind-homelab-localdev` on `test:e2e` and `test:drill` (level 2's `homelab verify all --level 2` already passed it)
- **Prevention**: Every task that mutates a cluster names the Kind context explicitly

### 2026-09-13 - Chart versions in production silently diverged from `configuration/versions.yaml`
- **Issue**: `versions.yaml` is documented as the single source of truth and Renovate bumps it, but four homelab Applications rendered other versions: `renovate` 46.49.0 (versions.yaml 46.106.12), `argocd` (argo-cd) 9.4.7 (9.5.17), `onepassword-operator` (connect) 1.16.0 (onepassword-connect 2.4.1) and `port-forwarding-controller` 1.1.1 (`unifi-port-forward: "1.1.x"`). The Kind loop installs ArgoCD from `versions.yaml`, so CI tested a different ArgoCD than production runs, and Renovate's "bumps" of those keys never reached the cluster
- **Root Cause**: `helm-apps.tmpl` never emitted the renovate chart version, so the `charts/applications/values.yaml` placeholder shipped; `charts/bootstrap` is rendered with plain Helm (Terraform root Application), not the CMP, so `versions.yaml` cannot reach its pins at all; nothing compared rendered versions with `versions.yaml`
- **Solution**: New level-0 check `versions/<env>`: every chart-sourced Application must render a version present in `versions.yaml`, unless listed with a reason in `tests/gitops/version-drift.yaml`. The renovate template now emits its version (production Renovate moves to 46.106.12 on merge) and the port-forward pin is exact. The two bootstrap drifts are registered, not aligned: aligning them upgrades production ArgoCD and 1Password Connect (a major version) and is the owner's decision
- **Prevention**: The check fails on any new silent drift and on stale registry entries

### 2026-09-13 - Renovate automerge rules would let GitHub merge before CI ran
- **Issue**: The patch rule and the GitHub Actions rule in `.github/renovate.json5` set `platformAutomerge: true`, while the `main` ruleset requires no status checks: had repository auto-merge ever been enabled, GitHub would have merged those PRs the moment they were mergeable, before any workflow finished. Latent only because the repository has `allow_auto_merge: false`. The patch rule's `matchCurrentVersion: '!/^0/'` also let `v0.x` versions through
- **Root Cause**: Platform automerge delegates the "checks passed" decision to branch protection, which has no required checks here
- **Solution**: `platformAutomerge: false` everywhere, so Renovate merges itself only when every status is green (including the Kind loop and the new `upgrade/automerge-gate`); `matchCurrentVersion: '!/^v?0\\./'` (issue #261 item 19, ADR-014)
- **Prevention**: Any new automerge rule keeps `platformAutomerge: false` until the ruleset lists required checks

### 2026-09-13 - CMP shared one `/tmp/generated-values.yaml` across concurrent renders and rendered base values after a failed export
- **Issue**: `cmp/plugin.yaml` wrote every `config export` to the fixed path `/tmp/generated-values.yaml` while the plugin declares `allowConcurrency: true`, so two Applications generating at once (addons and applications on every refresh) could render with each other's values; and without `set -e` a failed `homelab config export` still ran `helm template` with only the chart's base values
- **Root Cause**: The generate script predates concurrent generation and treated the export as best effort
- **Solution**: `set -eu`, a per-render `mktemp` file removed by a `trap`, and a non-zero exit when the export fails (issue #261 item 16, the same change that forwards the preview parameters)
- **Prevention**: `sh -n`/`dash -n` plus a fake-binary run of the script; the CMP parity test (`task test:cmp-parity`) exercises the image

### 2026-09-13 - ADR-011 still said CloudNativePG is off in Kind
- **Issue**: ADR-011's Kind sizing list said "cloudnative-pg and argo-workflows off" after ADR-012 turned cloudnative-pg on in Kind for the CNPG e2e test
- **Solution**: Annotated ADR-011 with the later decisions (ADR-012, ADR-014) instead of rewriting history
- **Prevention**: When a later ADR reverses part of an earlier one, add a pointer to the earlier entry in the same PR

### Known Common Errors (from CLAUDE.md)

These are documented errors with known solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| "OnePasswordItem not found" | 1Password Operator not ready | Check sync wave ordering (wave -2 for SOPS secrets, wave 0 for 1Password Operator) |
| "Unable to find valid certification path" | TrueNAS TLS not trusted | Democratic-CSI uses allowInsecure |
| "dry run failed" | Server-side apply conflicts | Add ServerSideApply=true to syncOptions |
| Ingress "Progressing" forever | No LoadBalancer IP | Custom health check marks Ingress Healthy |

### 2026-09-13 - TrueCharts apps unschedulable on Apple Silicon Kind (`kubernetes.io/arch: amd64`)
- **Issue**: flaresolverr (and every TrueCharts app) stayed Pending in Kind on an arm64 Mac: "2 node(s) didn't match Pod's node affinity/selector"
- **Root Cause**: the TrueCharts common library defaults `podOptions.nodeSelector` to `kubernetes.io/arch: amd64`; Kind nodes run the host architecture and the images are multi-arch
- **Solution**: `helm-apps.tmpl` renders `workload.main.podSpec.nodeSelector.kubernetes.io/arch: null` under the Kind sizing branch (helm deletes the key on merge); homelab output is unchanged
- **Prevention**: `task localdev:up` on an arm64 machine is the check; CI runners are amd64 and never hit it

### 2026-09-13 - Kind's bundled local-path-provisioner collided with the chart-managed one
- **Issue**: the `local-path-provisioner` addon Application failed to sync in Kind: `Deployment.apps "local-path-provisioner" is invalid: spec.selector ... field is immutable`
- **Root Cause**: every Kind cluster ships rancher local-path-provisioner in `local-path-storage` with the same Deployment name as the containeroo chart, and the selector differs
- **Solution**: `scripts/localdev-kind.ts up` deletes Kind's bundled Deployment, `standard` StorageClass and its RBAC after the nodes are Ready; the addon then owns the provisioner (Namespace and ConfigMap are adopted by server-side apply)
- **Prevention**: anything Kind pre-installs that a chart also installs must be removed by `localdev-kind.ts`, not fought over by ArgoCD

### 2026-09-13 - PostSync smoke hook failed on an app whose root redirects
- **Issue**: `smoke-lazylibrarian` failed with HTTP 303 (`/` → `/home` → `/authors`)
- **Solution**: the `homelab.smokeJob` curl follows up to 5 redirects; the expected codes apply to the final response
- **Prevention**: e2e Jobs (`tests/e2e`) already used `-L`; the two helper copies must stay byte-identical

### 2026-09-13 - Terragrunt Plan workflow was green while checking nothing
- **Issue**: `.github/workflows/terragrunt-plan.yml` passed on every PR although its plan step failed immediately (`Terraform has no command named "run"`): it downloaded terragrunt 0.55.1 but used the 1.x `run --all` syntax, and `continue-on-error: true` hid the exit code. Terraform was pinned to 1.7.5 while versions.yaml said 1.15+.
- **Root Cause**: the workflow was never updated when terragrunt moved to 1.x; a real `plan` also cannot run on GitHub-hosted runners (Proxmox/TrueNAS/UniFi on the LAN, credentials in 1Password, rendered manifests gitignored, and the repo has no `PROXMOX_*` secrets), so nobody noticed the swallowed error.
- **Solution**: the workflow now runs `terragrunt hcl fmt --check` and `terragrunt run --all validate` for both environments with pins mirroring versions.yaml/mise.toml (Renovate markers), stubs the workstation-only inputs (`terragrunt/files/*-rendered.yaml`, SSH key) so `file()` resolves, and has no `continue-on-error`. Plans stay `task tf:plan` (ADR-009). `terragrunt-apply.yml` got the same pins and CLI fix.
- **Prevention**: never `continue-on-error` a verification step; a job that cannot fail is not a check.

### 2026-09-13 - Terragrunt units could not be validated without applied state
- **Issue**: `terragrunt run --all validate` failed with `There is no variable named "dependency"` / "detected no outputs" in `localdev/gitops-bootstrap`, `homelab/truenas`, `homelab/talos-cluster` (zfs_pool) and `homelab/gitops-bootstrap` (truenas).
- **Root Cause**: those `dependency` blocks had no `mock_outputs`, so Terragrunt required real outputs even for `validate`.
- **Solution**: validate-only `mock_outputs` (`mock_outputs_allowed_terraform_commands = ["validate"]`) on each; plan/apply still need the real outputs.
- **Also**: `homelab/gitops-bootstrap` shelled out to `op read` at parse time (`run_cmd`), which needs a signed-in 1Password CLI; it now reads `SOPS_AGE_KEY` (injected by `op run --env-file .env.op` in every `task tf:*`), so validate runs without `op` and CI holds no vault credentials. `mise.toml` also stopped aborting when `~/.op/op_service_account_token` is missing, so `mise-action` can install the pinned tools on runners.
- **Prevention**: every `dependency` block gets validate mocks; the Terragrunt Plan workflow now catches omissions.

### 2026-09-13 - kind-cluster module used a block for `containerd_config_patches`
- **Issue**: `terraform validate` of `terragrunt/modules/kind-cluster` failed with `Unsupported block type` on the `dynamic "containerd_config_patches"` block.
- **Root Cause**: the tehcyx/kind provider exposes `kind_config.containerd_config_patches` as a `list(string)` attribute, not a nested block; the module had never been validated in CI.
- **Solution**: `containerd_config_patches = var.containerd_config_patches`.

### 2026-09-13 - Production ArgoCD Ingress rendered `argocd.example.com` after PR #265
- **Issue**: `ingress.networking.k8s.io/argocd-server` in homelab switched to host `argocd.example.com` (the external-dns annotation, `extraTls` and `notifications.argocdUrl` too), so `argocd.<DOMAIN>` stopped resolving to ArgoCD
- **Root Cause**: PR #265 moved the ArgoCD hostname out of `charts/bootstrap/values-homelab.yaml`: the gitops chart now derives it from `global.domain`, which only `terragrunt/modules/gitops-bootstrap` injects into the root `gitops` Application as a helm parameter (`templates/bootstrap-app.yaml.tpl`). That module was never re-applied, the live root Application had no `helm.parameters`, the committed placeholder `example.com` won, and ArgoCD self-healed its own Ingress to it. Nothing in the repo or CI can see the root Application, so nothing failed
- **Solution**: Human step, once: `task tf:plan:component COMPONENT=gitops-bootstrap`, review that the only change is the `global.domain` parameter on the root Application, then `task tf:apply:component COMPONENT=gitops-bootstrap`; ArgoCD re-renders bootstrap → argocd and the Ingress returns to `argocd.<DOMAIN>`. `homelab verify prod` gained `prod/argocd/domain`: fails when the root Application lacks `global.domain`, when it is the placeholder, or when any Application's Helm inputs (`values`, `valuesObject`, `parameters`) still contain `example.com`, naming the Applications. It fired on the live cluster with exactly this diagnosis (PR #275)
- **Prevention**: A change to `terragrunt/modules/gitops-bootstrap` (module, `bootstrap-app.yaml.tpl`, inputs) is not live until the component is applied; say so in the PR and run `task verify:prod` after the apply. Observed alongside: nine `*-config` Applications carried a stale `Failed` operation from 95c459d (children synced with `iscsi.portal: ""` before their parents handed down the portal; the API server rejected the immutable PV change), all Synced/Healthy since — a sync clears it

## Tips

- Keep descriptions under 2-3 lines
- Focus on the lesson learned, not just the fix
- Include enough context for future reference
- Clean out very old entries periodically (6+ months)

### 2026-09-13 - `homelab verify prod` failed a placeholder Application as "never synced"
- **Issue**: `task verify:prod` reported `prod/argocd/traefik-internal-dependencies` as FAIL with "no sync operation recorded (the Application has never been synced)" although the Application was Synced and Healthy
- **Root Cause**: `charts/traefik-internal-dependencies` renders only a comment in homelab (placeholder for the dependencies -> main -> config pattern), so ArgoCD has nothing to apply and never records an operation; `evaluateArgoApp` treated an empty `operationState` as never-synced regardless of whether the Application has resources
- **Solution**: `evaluateArgoApp` (internal/verify/cluster.go) passes an Application that is Synced, Healthy, has zero `status.resources` and no operation, with `detail` ending in `(no resources: nothing to sync)`; the never-synced finding stays for Applications that do have resources (table test `TestEvaluateArgoAppWithoutResources`, both prod and Kind rules)
- **Prevention**: Any new placeholder child chart behaves the same way; the check now documents this in `docs/runbooks/verification.md`

### 2026-09-13 - PII guard failed on `main` for the public repository URL and a GitHub Pages Helm repo
- **Issue**: `homelab config guard --set homelab` (pre-commit "PII Guard" and `--ci`) reported `charts/gitops/values-homelab.yaml` (`repoUrl: https://github.com/<owner>/homelab.git`) and `configuration/versions.yaml` (`registryUrl=https://<owner>.github.io/port-forwarding-controller`), blocking every commit that touched `versions.yaml`
- **Root Cause**: The value detector hunts every literal from `homelab.yaml` on a PII-shaped key; the dynamic-DNS/username value equals the GitHub owner of this public repository, so the owner segment of its own repository URL matched at word boundaries
- **Solution**: `internal/config/guard.go` `isForgeOwnerAt`: an occurrence is not a match when it is exactly the owner segment of a code-forge URL (`github.com/<value>` followed by `/`, `.git` or the end of the token, or `<value>.github.io`; GitLab likewise). Only a dot-free value qualifies, and the search continues past the excused occurrence, so the same value anywhere else on the line is still reported
- **Prevention**: `TestLineMatchesPatternForgeOwner` and `TestRunGuardForgeOwnerURLsAreNotFindings` pin both sides; `config guard --ci` on a clean tree is the regression check

### 2026-09-13 - Kind loop could not sync a child chart that is new in the PR and renders nothing in localdev
- **Issue**: `task localdev:ci` on PR #280 failed at `localdev:sync`: `paperclip-dependencies` (scaffolded `deps-main-config` pattern, nothing to render without a secret store) went `operation Error (ComparisonError: ... charts/paperclip-dependencies: app path does not exist)` three times; the Application ended `Unknown`/`Healthy` with zero resources
- **Root Cause**: `argocd app manifests --local` rendered nothing, so the loop asked `argocd app manifests <app>` (Git at `main`), which exits 0 and prints nothing for a path that does not exist there; that read as "empty on both sides" and triggered the plain `argocd app sync`, which generates from Git where the chart is absent. Every new `*-dependencies` chart hits this until it is merged
- **Solution**: `scripts/localdev-argocd.ts` checks `git cat-file -e origin/<targetRevision>:<path>` (the SHA itself when the revision is one; ArgoCD's `app path does not exist` wording is the fallback when git cannot answer) and `emptyRenderDecision(local, git, pathInGit)` returns a fourth value `new-empty`: no sync is issued, the row is finished as `new-empty`, and `isNewEmptyApp` (Healthy, no operation, no resources, `ComparisonError` with that wording) makes `wait`, `diagnose` and `report` (no diff, `not on main`) treat it as complete. `evaluateArgoApp` passes the same shape under the Kind rules only (`newChartPasses`, `detail` ending `(new chart: nothing to sync until it exists on the target revision)`); `verify prod` keeps failing it (`TestEvaluateArgoAppNewChart`)
- **Prevention**: `emptyRenderDecision` table test covers all four decisions; a chart new on the branch that renders nothing in Kind is expected to show `new-empty` in the sync table, not an error

### 2026-09-13 - Kind loop started the applications subtree while addons was still creating its waves
- **Issue**: `task localdev:ci` on PR #280 failed at `localdev:sync`: `paperclip-database` went `operation Failed (no matches for kind Cluster in postgresql.cnpg.io/v1)` because `cloudnative-pg` (addons wave 10) had not been synced; `kube-prometheus-stack` and `node-feature-discovery` were only "discovered" later while the loop waited on an applications wave-13 tier
- **Root Cause**: ArgoCD holds a parent's operation Running per wave and creates the next wave's child Applications only once the current wave is Healthy. `nextTier` picks the lowest undone tier among the Applications that exist, so after addons' wave-6 children completed the lowest tier was `[0 › 3]` (applications) and the loop moved on while the `addons` parent `[0 › 2]` still held waves open; `parentsAwaitingWaves` was only consulted when no tier was left. In homelab ArgoCD itself never starts `applications` before `addons` is Healthy (gitops waves)
- **Solution**: `tierBlockedBy(tier, awaiting)` in `scripts/localdev-argocd.ts` names the lowest Running parent whose tier key is strictly lower than the next tier and not a prefix of it (a parent never blocks its own subtree; the root `gitops` `[0]` never blocks); the sync loop then logs `waiting for addons to finish its waves before tier [0 › 3]`, polls, and only starts the tier once no lower parent is Running (the sync timeout still applies)
- **Prevention**: `tierBlockedBy` / `isTierKeyPrefix` unit tests cover the addons-blocks-applications case, own-subtree, root, higher-key parent and multiple parents; a Kind run must show every addons wave (up to `cloudnative-pg`) synced before `tier [0 › 3]: applications`

### 2026-09-13 - `localdev:diagnose` printed only the `argocd` namespace and hid the resource that kept an Application Progressing
- **Issue**: On PR #280's CI run `applications`, `gitops` and `paperclip` were not Healthy; diagnose printed `paperclip`'s header and the `argocd` events only, nothing about namespace `paperclip`, where the operator StatefulSet's `FailedCreate ... violates PodSecurity "baseline"` event held the answer
- **Root Cause**: `cmdDiagnose` added an Application's destination namespace only while the namespace set was still empty, so after the first unhealthy app (destination `argocd`) no later app's namespace was diagnosed; `resources not Healthy:` skipped resources without a `health` field (ArgoCD reports none for the `paperclip.inc/Instance`), so the single resource keeping `paperclip` Progressing was never listed
- **Solution**: `scripts/localdev-argocd.ts` `diagnoseNamespaces` (every unhealthy Application's destination plus its not-Healthy resources' namespaces, de-duplicated, `argocd` last), `resourceLines` (every managed resource of a not-Healthy Application, `-` when health is missing) and `describeTargets` (not-Healthy resources in a non-core group other than `argoproj.io`); `diagnoseNamespace` now also prints `kubectl get statefulsets,deployments,jobs` and a `kubectl describe` tail of each such resource
- **Prevention**: Table tests for the three helpers pin the three-Application scenario; a Progressing Application must always show its resources and its own namespace in the diagnose output

### 2026-09-14 - Kind loop compared the PR against `main`; the `kind-preview` report called every Application "same as main"
- **Issue**: On PR #280 (https://github.com/ryanmcafee/homelab/pull/280) the `kind-preview` comment listed all 44 Applications, including `paperclip` and `paperclip-operator` which do not exist on `main`, as "same as main" with "0 not Synced with main"; new charts also needed the `new-empty` / `ComparisonError` special case in `sync`, `wait`, `report` and `verify --level 2`
- **Root Cause**: The root `gitops` Application declared `targetRevision: main` and every child inherited `main` from `charts/gitops/values-localdev.yaml` and the generated `charts/{addons,applications}/values-localdev.yaml`, so ArgoCD compared the Kind deploy (synced from the working tree with `--local`) against a revision that did not contain the PR. Right after a local sync ArgoCD reports `Synced` from the operation's own manifests until its next Git comparison, and the report keyed "vs main" on that sync status, so it ran before ArgoCD had re-compared against `main`
- **Solution**: The Applications track the PR head: `task localdev:argocd -- --revision <ref>` (env `LOCALDEV_REVISION`; default the upstream branch of HEAD, `main` with a warning when unpushed) rewrites the placeholder `main` in the root Application's `spec.source.targetRevision` and `spec.source.helm.valuesObject.global.targetRevision`, the `gitops` chart hands `global.targetRevision` to `addons`/`applications` through `helm.valuesObject`, and `tilt-ci.yml` checks out the PR head SHA and sets `LOCALDEV_REVISION` to it. The report no longer infers "vs main" from sync status: `task localdev:report -- --base <ref>` runs `argocd app diff <app> --revision <base>` for every git-path Application and shows sync status in its own column (ADR-012 amendment)
- **Prevention**: A chart new in a PR must show its real diff under "vs main" in the `kind-preview` comment, never "same as main"; `Synced` in Kind now means the working tree equals the pushed head, so an unexpected `OutOfSync` in CI is a real finding

### 2026-09-14 - `addons` permanently OutOfSync in Kind and homelab: `group: ""` in ignoreDifferences and ArgoCD's post-delete finalizers
- **Issue**: The `addons` parent reported `agent-readonly`, `cilium`, `node-feature-discovery` and `spegel` OutOfSync on every comparison, even right after a sync, so the Kind report's Sync column (and production's `addons` Application) never settled
- **Root Cause**: Two live-only differences on child `Application` objects. (1) `ignoreDifferences[].group: ""` for core kinds (`Secret`) in `charts/addons/templates/{cilium,agent-readonly}.yaml` and `charts/bootstrap/templates/argocd.yaml`: the Application CRD serialises `group` with `omitempty`, so the API server drops the empty string and the rendered spec never equals the live one. (2) ArgoCD appends `post-delete-finalizer.argocd.argoproj.io` and `post-delete-finalizer.argocd.argoproj.io/cleanup` to every Application whose chart ships a Helm `post-delete` hook (`node-feature-discovery`, `spegel`); those finalizers exist only in the cluster
- **Solution**: Core kinds list `kind:` without `group:`; `charts/gitops/values.yaml` gives the bootstrap/addons/applications Applications an `ignoreDifferences` entry (`group: argoproj.io`, `kind: Application`, `jqPathExpressions: ['.metadata.finalizers[]? | select(startswith("post-delete-finalizer.argocd.argoproj.io"))']`), and `values-homelab.yaml` no longer overrides it with `[]`
- **Prevention**: Never write `group: ""` in `ignoreDifferences` (omit `group` for core kinds); an Application that stays OutOfSync straight after a successful sync is a spec-normalisation bug, not drift, and `argocd app diff <app>` shows exactly which field the API server rewrote

### 2026-09-15 - Production `paperclip-database` never bootstrapped: PostgreSQL on an NFS class ("data directory has wrong ownership")
- **Issue**: After PR #280 merged, the `applications` sync stayed Running for hours waiting on `paperclip-database`; the CloudNativePG initdb Job failed 7 times with `FATAL: data directory "/var/lib/postgresql/data/pgdata" has wrong ownership`, and the `paperclip` Application (wave 14) was never created
- **Root Cause**: The Cluster used `STORAGE_CLASS_SSD`, whose schema description said "iSCSI SSD volumes" while its value `democratic-csi-ssd` is NFS on the SSD pool (`org.democratic-csi.nfs-ssd`, mapall `apps:users`). Every file on such a share appears owned by uid 568; PostgreSQL refuses a data directory not owned by its own uid 26. Kind uses local-path for every class, so level 2 could not catch it
- **Solution**: New key `STORAGE_CLASS_ISCSI_SSD` (default `democratic-csi-iscsi`, block/ext4 on the SSD pool; `local-path` in Kind) used by `charts/paperclip-database`; the `STORAGE_CLASS_SSD` description now says NFS. The Cluster was renamed `paperclip-db` -> `paperclip-postgres` (Secret `paperclip-postgres-app`) so ArgoCD prunes the failed Cluster (CNPG deletes its NFS PVC) and bootstraps the new one without anyone touching production
- **Prevention**: Databases and other uid-sensitive data go on `STORAGE_CLASS_ISCSI_SSD` / `STORAGE_CLASS_ISCSI`, never on an NFS class; a key's description must say which protocol backs it

### 2026-09-15 - Nine `*-config` Applications kept a Failed operation from 2026-09-13 although Synced and Healthy
- **Issue**: `flaresolverr|lazylibrarian|mosquitto|nzbget|plex|prowlarr|radarr|sonarr|tautulli-config` showed `Failed` as last operation (`PersistentVolume ... spec.persistentvolumesource is immutable after creation`, revision 95c459d) while `task prod:diff` reported no difference, so `task verify:prod` stayed red
- **Root Cause**: The failed operation predates PR #275 (which fixed the iSCSI portal reaching the child charts). Once Git matched the cluster ArgoCD had nothing to sync, and an automated sync only starts a new operation for an OutOfSync Application, so the stale result never cleared
- **Solution**: The `*-config` charts now label their PersistentVolume and PersistentVolumeClaim (`app.kubernetes.io/part-of`, `app.kubernetes.io/component: config-storage`): a real, harmless change that makes each Application OutOfSync once, so the automated sync runs a new operation that succeeds (the PV source is unchanged and `RespectIgnoreDifferences=true` keeps ignored fields out of the apply)
- **Prevention**: A stale Failed operation on a Synced Application clears only with a new operation; prefer a meaningful rendered change (labels, annotations) over a manual `argocd app sync` when agents cannot mutate production

### 2026-09-15 - Production `paperclip` server crash-looped: "secrets directory must be owned by the Paperclip process user" (data volume on NFS)
- **Issue**: Once `paperclip-postgres` was healthy the `paperclip` Instance pod restarted forever: `Decision signing secrets directory at /paperclip/instances/default/secrets must be owned by the Paperclip process user` (`decision-signing.ts assertOwnedByCurrentUser`)
- **Root Cause**: The Instance's `storage.persistence` used `STORAGE_CLASS_NFS` (`democratic-csi-nfs`, mapall `apps:users`): every file on the share appears owned by uid 568 while the server runs as uid 1000 and checks ownership before starting. Same class of failure as the database the same day; Kind's local-path preserves ownership, so level 2 cannot catch it
- **Solution**: The Instance persists on `STORAGE_CLASS_ISCSI_SSD` (`democratic-csi-iscsi`). A StatefulSet's `volumeClaimTemplates` are immutable, so in production the operator-managed StatefulSet and the PVC `paperclip-data` had to be deleted once (`kubectl -n paperclip delete statefulset paperclip pvc paperclip-data`); the operator recreated both on iSCSI
- **Prevention**: Any workload that checks file ownership (databases, Paperclip, most Node/Go servers writing secrets) goes on `STORAGE_CLASS_ISCSI_SSD` or `STORAGE_CLASS_ISCSI`; the NFS classes are for media and shared data only

### 2026-09-15 - Production `paperclip-bootstrap` Job pod stuck in ContainerCreating: Multi-Attach error on the iSCSI data volume
- **Issue**: After the Instance moved to iSCSI (#285) the operator's admin bootstrap Job pod stayed `ContainerCreating` on `talos-lz1-3u1` with `Multi-Attach error for volume ... Volume is already used by pod(s) paperclip-0` (the server ran on `talos-8uq-sf6`), so the admin account was never created
- **Root Cause**: `internal/resources/bootstrap.go` (operator 0.19.1) builds the Job pod with the StatefulSet's `buildVolumes`/`buildVolumeMounts`, so it mounts `/paperclip` although its script only uses `curl` and env vars; only `availability.nodeSelector`/`tolerations` are copied to the Job, not affinity. On NFS every node could mount the share; a `ReadWriteOnce` iSCSI volume attaches to one node
- **Solution**: `charts/paperclip` renders `spec.availability.nodeSelector` (homelab: `paperclip.homelab/pin: "true"` on one labelled node; Kind: none), which the operator applies to both the server and the Job. An init container cannot replace the Job: it needs the running server's sign-up API. Upstream should drop the volume from the Job or add pod affinity
- **Prevention**: Any operator-created helper pod that shares a `ReadWriteOnce` volume with the workload needs the same node; check helper Jobs before moving a workload from NFS to block storage

### 2026-09-15 - Admin bootstrap Job fails with `EMAIL_PASSWORD_SIGN_UP_DISABLED` when `auth.disableSignUp` is true
- **Issue**: With the node pin in place the bootstrap Job finally ran and failed: `Sign-up returned HTTP 400 ... {"code":"EMAIL_PASSWORD_SIGN_UP_DISABLED"}`, then `Invalid email or password` on the sign-in fallback, so no admin exists and nobody can log in
- **Root Cause**: The operator's Job (0.19.1) registers the admin through `POST /api/auth/sign-up/email`; `spec.auth.disableSignUp: true` maps to `PAPERCLIP_AUTH_DISABLE_SIGN_UP`, which Better Auth applies to every sign-up including the first (`server/src/auth/better-auth.ts`, no first-user exception). The operator README nevertheless recommends combining the two ("provision the only account")
- **Solution**: Bootstrap with sign-up enabled, then disable it: PR sets `auth.disableSignUp: false`, the Job registers the admin and the operator records `status.bootstrap`; a follow-up PR sets it back to `true` (the Job short-circuits on an already-bootstrapped instance). The instance is private (internal Traefik only) during the window. Reported upstream so the operator can gate the env var on bootstrap completion
- **Prevention**: For a new Instance with `adminUser`, deploy with `disableSignUp: false` first and flip it after `status.bootstrap` appears; do not trust the operator README on this combination until the upstream fix lands

### 2026-09-15 - Sporadic Kubernetes API loss: etcd WAL fsync stalled by worker I/O on the shared ZFS pool
- **Issue**: `kubectl` against `https://<CP_VIP>:6443` failed for tens of seconds at a time, sporadically, for months. On 2026-09-15 the API returned 1283 5xx in one hour (04:21-04:41Z), kube-controller-manager, kube-scheduler and cilium-operator lost their leader leases and restarted (23-29 restarts each over 157 days), and the Talos layer-2 VIP was dropped and re-elected twice (11 s and 36 s with no VIP at all). Nothing in the cluster looked broken afterwards, which is why it went undiagnosed
- **Root Cause**: The three control-plane VM system disks lived on the Proxmox ZFS mirror `vm-storage` (2x Crucial CT1000P310SSD8, QLC) together with every worker system disk. etcd stores its write-ahead log on the Talos EPHEMERAL partition of that disk. A single worker image unpack saturated the pool: on 04:17-04:22Z worker-2 wrote 6459 MB and on 04:32-04:37Z worker-1 wrote 6503 MB unpacking `ghcr.io/paperclipai/paperclip:2026.831.1` (1.6 GB compressed; Talos keeps unpacked layers for Spegel, roughly doubling the bytes). etcd `slow fdatasync` went from ~1 ms to 2.5 s, 32.97 s, 47.08 s and 48.11 s on all three members at once; raft heartbeats were missed, ReadIndex timed out, and every 5 s Lease PUT/GET through KubePrism (127.0.0.1:7445) hit its deadline. Leader-election loss, kubelet `Failed to ensure lease exists` and the VIP move are all downstream of that one fsync. Chronic even at baseline: `leader failed to send out heartbeat on time; leader is overloaded likely from slow disk` a few times an hour, and the control-plane VM cgroups showed `io.pressure full avg300 = 0.25-0.30` against 0.00 for an idle worker
- **Solution**: Control-plane system disks moved to a dedicated single-device ZFS pool `cp-storage` on the previously unused Samsung 990 PRO NVMe (new `terragrunt/environments/homelab/proxmox-zfs-pool-cp`; `control_plane_datastore_id` on the `talos-cluster` module), so etcd's fsync path never shares a device with worker I/O. etcd tuned for virtualised disks (`cluster.etcd.extraArgs`: `heartbeat-interval=250`, `election-timeout=2500`) and told to publish metrics (`listen-metrics-urls=http://0.0.0.0:2381`); kube-prometheus-stack now scrapes `kubeEtcd` on the three control-plane IPs and ships alerts for API 5xx, disk write latency and a missing etcd scrape. `scripts/apiserver-stress.ts` (`task apiserver:probe` / `task apiserver:stress`) probes the VIP and each control plane side by side so a VIP failover is never again mistaken for an API outage. ADR-016, `docs/runbooks/control-plane-storage.md`
- **Prevention**: Never let etcd share a physical device with bulk workload I/O, however fast the device looks; consumer QLC SSDs in a mirror collapse under a multi-GB sequential write while a single etcd fsync is waiting. A Kubernetes API that "disappears" with healthy pods afterwards is a storage-latency symptom: check `talosctl logs etcd` for `slow fdatasync` before suspecting the network, Cilium or the API server. etcd was not scraped at all, so none of this was visible in Grafana for months - a control-plane component with no metrics is an outage you will diagnose twice

### 2026-09-16 - Control-plane migration stalled on a gate that could never pass (VM name vs Kubernetes node name)
- **Issue**: During the live `cp-storage` migration, `task cp:migrate -- --yes` moved cp-1's disk successfully and then reported `cp-1: not settled yet` every 15 s, heading for a 10-minute timeout that would have aborted the run with two nodes still unmigrated. Every condition it claimed to be waiting on was demonstrably true: three healthy etcd members at a matching RAFT INDEX, `/readyz` ok, the VIP held, the disk on `cp-storage`, and all six nodes `Ready`
- **Root Cause**: `postGates` looked the node up with `isNodeReady(state.kubeNodes, node.name)`, where `node.name` is the **Proxmox VM name** (`cp-1`). Kubernetes knows that node by its **Talos hostname** (`talos-og0-md2`), so the lookup returned `absent` and the gate was unsatisfiable. The unit test missed it because the fixture invented node names (`cp-1`, `cp-2`) that matched the VM names — the test encoded the same wrong assumption as the code
- **Solution**: `kubectlNodesArgv` now passes `-o wide`, `KubeNodeRow` carries `internalIP`, and `findKubeNode`/`isNodeReady` match on the node's internal IP — the only reliable join between a Proxmox VM and its Kubernetes node. The fixture uses real Talos hostnames with an INTERNAL-IP column and asserts that looking up `cp-1` returns false, so the regression cannot return silently
- **Prevention**: A test fixture must carry the shape of real output, not a convenient invention; when a fixture's identifiers are suspiciously tidy, suspect it. A gate that "never settles" while every underlying condition is true is a gate bug, not a slow cluster — read the gate's own detail string before waiting out the timeout

### 2026-09-16 - Talos applies `cluster.etcd.extraArgs` without restarting etcd, so the tuning stays inert
- **Issue**: After `talos_machine_configuration_apply` landed `heartbeat-interval=250`, `election-timeout=2500` and `listen-metrics-urls` on cp-1, `talosctl get machineconfig` showed the new `extraArgs` but etcd was still running with the old values: the metrics port answered nothing and `talosctl services etcd` showed no state change for 1135 hours
- **Root Cause**: The provider's default apply mode (`auto`) writes the machine config without restarting etcd for an `extraArgs`-only change. `talosctl service etcd restart` cannot fill the gap either: it is refused with `service "etcd" doesn't support restart operation via API`, because etcd is owned by the machine-config controller, not the service API
- **Solution**: Reboot each control plane after its apply, one at a time (`talosctl -n <ip> reboot`), and verify against the running process rather than the config: `talosctl logs etcd | grep election-timeout` and a 200 from `<ip>:2381/metrics`. Each node returned within 40 s and `/readyz` never stopped returning `ok`, because the VIP moves to a surviving member
- **Prevention**: Never treat "the machine config contains X" as "X is in effect" for a Talos static-pod component; check the running process or its metrics endpoint. The runbook now says so explicitly

### 2026-09-16 - etcd was configured for scraping but never scraped: ArgoCD drops the Endpoints object the chart relies on
- **Issue**: After PR #288 the `kubeEtcd` scrape was configured, ArgoCD reported the Application Synced and Healthy, etcd really was serving metrics (`curl <cp-ip>:2381/metrics` returned 200 on all three nodes) — and Prometheus still had **zero** etcd targets: `up{job="kube-etcd"}` was empty. Every individual piece looked correct, which is why it was reported as working
- **Root Cause**: kube-prometheus-stack reaches an *external* etcd by rendering a selector-less `Service` plus a hand-built `Endpoints` object from `kubeEtcd.endpoints` (`templates/exporters/kube-etcd/{service,endpoints}.yaml`; the Service only gets a pod selector when `endpoints` is empty). ArgoCD's `resource.exclusions` in `argocd-cm` exclude `Endpoints` and `EndpointSlice` cluster-wide "to reduce the number of watched events", so that object is rendered and then never applied — the Service stays empty forever and the ServiceMonitor discovers nothing. ArgoCD's own resource list for the Application shows ConfigMap, Service, PrometheusRule and ServiceMonitor but no Endpoints. The `Endpoints` object present in the cluster was an unrelated April-dated orphan with no `subsets`. Talos compounds it: etcd runs as a host service with no Kubernetes pod, so the selector form cannot work either
- **Solution**: The addresses become a static scrape config (`prometheus.prometheusSpec.additionalScrapeConfigs`, job `kube-etcd`), which needs no Endpoints object. `kubeEtcd.enabled` stays **true** because the chart gates its etcd alert rules on it (`rules-1.14/etcd.yaml` requires `.Values.kubeEtcd.enabled`); only the unusable `service` and `serviceMonitor` are turned off. The job name must contain "etcd" because those rules match `job=~".*etcd.*"`
- **Prevention**: "Application Synced" does not mean every rendered object was applied — an excluded kind is skipped silently. When a scrape has no targets, check ArgoCD's per-resource list (`.status.resources`) against what the chart renders, not just the sync status. Never conclude a scrape works because the exporter answers; check `up{job=...}` on the Prometheus side. `EtcdMetricsAbsent` exists for exactly this and would have fired in 15 minutes

### 2026-09-20 - `KubeJobFailed` fired for 17 days after one transient CronJob failure
- **Issue**: `KubeJobFailed` for `renovate-29807280` and three `duckdns-updater-298075xx` Jobs, all from 2026-09-03, while every run since had succeeded
- **Root Cause**: Neither CronJob set `ttlSecondsAfterFinished`. `failedJobsHistoryLimit` only trims a failed Job when a newer failed Job replaces it, so a single transient failure (Renovate: `Authentication failure`) leaves a failed Job, and the alert, forever
- **Solution**: `ttlSecondsAfterFinished` on both (DuckDNS 1 h, Renovate 6 h via the upstream chart's `cronjob.ttlSecondsAfterFinished`). Jobs created before the change carry no TTL: delete them once (`kubectl -n renovate delete job renovate-29807280`, `kubectl -n duckdns delete job duckdns-updater-29807510 duckdns-updater-29807515 duckdns-updater-29807520`)
- **Prevention**: conftest rule `cronjob-ttl` fails level 0 for a CronJob without the TTL

### 2026-09-20 - `KubeProxyDown`, `KubeControllerManagerDown` and `KubeSchedulerDown` fired permanently on Talos
- **Issue**: Three critical control-plane alerts firing although the cluster was healthy
- **Root Cause**: Two separate causes. Cilium replaces kube-proxy (`kubeProxyReplacement: true`), so the chart's `kube-proxy` scrape Service had no endpoints and `absent(up{job="kube-proxy"})` was always true. Talos starts kube-controller-manager and kube-scheduler with `--bind-address=127.0.0.1`, so the scrape of `<control-plane IP>:10257` / `:10259` was refused
- **Solution**: `kubeProxy.enabled` now follows the same template variable as Cilium's `kubeProxyReplacement` (off in homelab, on in Kind). `cluster.controllerManager.extraArgs` / `cluster.scheduler.extraArgs` `bind-address: 0.0.0.0` in `terragrunt/environments/homelab/talos-cluster/terragrunt.hcl`; needs `task tf:apply:component COMPONENT=talos-cluster` by a human (static pods restart, no reboot)
- **Prevention**: When a platform removes or hides a component the monitoring chart scrapes by default, disable or re-point that scrape in the same change

### 2026-09-20 - IngressRoutes without an ingress class were loaded by no Traefik
- **Issue**: The nightly `ingress-verification` CronWorkflow failed on `auth.<DOMAIN>`: TLS handshake got `TRAEFIK DEFAULT CERT` although `auth-tls` was Ready. The `/dashboard` redirect routes of both Traefiks were dead the same way
- **Root Cause**: Both Traefik instances run with `--providers.kubernetescrd.ingressClass=<external|internal>`. `auth-oidc`, `traefik-dashboard-redirect` and `traefik-internal-dashboard-redirect` had no `kubernetes.io/ingress.class` annotation, so neither instance loaded them. They applied cleanly and ArgoCD showed them Healthy
- **Solution**: Annotated all three
- **Prevention**: conftest rule `ingressroute-class` requires the annotation on every rendered IngressRoute. The CronWorkflow that surfaced it was removed in the same PR (no longer needed)

### 2026-09-20 - `ingress-verification` checked a host of a disabled Application
- **Issue**: The same CronWorkflow failed every night on `homeassistant.<DOMAIN>`
- **Root Cause**: The URL list in `configuration/templates/helm-addons.tmpl` was static while Home Assistant is `enabled: false` in `helm-apps.tmpl`; nothing compared the list with what is served
- **Solution**: The workflow was no longer needed: removed `charts/argo-workflows-config` (CronWorkflow, ServiceAccount, ClusterRole), its Application and the `ingressVerification` values
- **Prevention**: A static list of things to probe drifts from what is deployed; derive such a list from the rendered manifests or do not keep one

### 2026-09-20 - Both Traefik HPAs read `cpu: <unknown>`: no metrics-server in homelab
- **Issue**: `FailedGetResourceMetric` events every 15 s on `traefik-external` and `traefik-internal`; neither HPA could ever scale, and `kubectl top` did not work
- **Root Cause**: Autoscaling was enabled for both Traefiks but nothing served `metrics.k8s.io`
- **Solution**: `metrics-server` addon (wave 2, `kube-system`, two replicas with a PodDisruptionBudget). Talos kubelets serve cluster-CA certificates with IP SANs (checked with `openssl s_client`), so verification stays on; Kind's self-signed kubelets get `--kubelet-insecure-tls` through the platform key `KUBELET_SERVING_CERT`
- **Prevention**: Enabling an HPA on a Resource metric requires metrics-server in the same environment

### 2026-09-20 - The read-only agent could not read what Alertmanager was firing
- **Issue**: Alert triage had to be reconstructed from cluster state: `services/proxy`, `pods/exec` and `pods/portforward` were all forbidden, and neither Alertmanager nor Prometheus has an Ingress
- **Solution**: `homelab-agent-readonly` grants `get`/`create` on `pods/exec` and `pods/portforward`. API objects stay read-only; exec is a deliberate exception (a shell can read what its container mounts), documented in `docs/runbooks/readonly-access.md`

### 2026-09-20 - `kubectl auth can-i create pods/exec` tested a pod named "exec", not the subresource
- **Issue**: After granting `pods/exec` to `agent-readonly`, the Kind e2e still reported `create pods/exec`: no. Before the grant, the same production check had answered `get pods/exec`: yes while a real exec was Forbidden
- **Root Cause**: `can-i` parses `pods/exec` as TYPE/NAME. The old `check no ... create pods/exec` assertion passed because the account cannot create pods, so it never proved anything about exec; `get pods/log` passed the same vacuous way
- **Solution**: `tests/e2e/agent-readonly` uses `--subresource=exec|portforward|log|attach`
- **Prevention**: Test subresource permissions with `kubectl auth can-i <verb> pods --subresource=<name>`

### 2026-09-20 - CPUThrottlingHigh x16 on democratic-csi: a 200m limit, not real CPU demand
- **Issue**: 16 `CPUThrottlingHigh` alerts (severity info, so never paged) on every `csi-driver` container since June, 70-87 % of periods throttled
- **Root Cause**: The containers idle at ~12m and run in only ~220 of the 3000 CFS periods in five minutes, but each burst wants more than the 20 ms a 200m limit allows per 100 ms period. Throttling was a quota artefact, not saturation. The 28-149 restarts on the same pods were a red herring: every sidecar died within the same minute on 2026-09-15, the API outage already fixed in PR #288
- **Solution**: CPU limit 200m -> 1000m on `controller.driver` and `node.driver` for all four democratic-csi variants. Requests stay 50m, so scheduling and node capacity are unchanged; a limit only caps a burst
- **Prevention**: Read `container_cpu_cfs_periods_total` before believing a throttling alert. A container throttled at near-zero usage needs a bigger limit, not more CPU

### 2026-09-03 - Cluster DNS failed for 8.5 h behind a single upstream, with no alert
- **Issue**: 66,051 SERVFAIL answers (a quarter of all DNS) between 05:40 and 15:30 UTC. external-dns crash-looped, Renovate failed seven times, three DuckDNS updates failed. Discovered 17 days later while triaging something else
- **Root Cause**: The nodes resolve through one upstream, the gateway (`machine.network.nameservers`). It stopped answering, CoreDNS logged 62,059 broken-upstream events and had nowhere to forward. Both replicas were hit equally
- **Solution**: Cannot be fixed by adding a public resolver: `*.<domain>` is split-horizon and Talos host DNS spreads queries rather than strictly preferring the first upstream, so internal names would resolve to public addresses while the gateway is healthy. Added detection instead: `HomelabClusterDNSUpstreamDown` (cause) and `HomelabClusterDNSFailing` (symptom), both critical. Backtested: both fire at 2026-09-03 10:00 UTC, neither fires in the last 7 days
- **Prevention**: `TargetDown` does not cover a component that stays up and answers wrongly. Alert on the answer, not just the scrape. Options for real redundancy are in `docs/runbooks/cluster-dns.md`

### 2026-09-20 - Raising the CSI CPU limit only got throttling from 87 % to 29 %: the alert has no floor
- **Issue**: After the limit went 200m -> 1000m (PR #314) the `CPUThrottlingHigh` alerts dropped from 16 to 4-5 but settled at a 29 % median, still over the 25 % threshold. The prediction that they would clear was wrong
- **Root Cause**: Not the limit. The containers run in ~26-35 of the 3000 CFS periods in five minutes and spread ~54ms of CPU across 7 threads per burst, so a burst can exceed any finite quota. The chart's rule divides throttled periods by active periods with no floor under the denominator, so ~10 throttled samples out of ~30 reads as 30 %. At that sample count the ratio is not a measurement
- **Solution**: `defaultRules.disabled.CPUThrottlingHigh` plus a tuned copy in `additionalPrometheusRulesMap` carrying the chart's expression verbatim and `and ... > 300` on the deduplicated denominator (a 10 % duty cycle). Verified against live Prometheus: 0 results with the floor, the same 11 pods with the floor lowered to 10, so the floor is the only thing that changes. Every container doing real work is far above it (Prometheus 2250, Grafana 1934, Spegel ~1180/pod)
- **Prevention**: A ratio alert needs a floor under its denominator. Before shipping one, ask what the denominator is when the subject is idle

### 2026-09-20 - Values added to charts/addons/values.yaml do nothing unless the Application template emits them
- **Issue**: `defaultRules.disabled.CPUThrottlingHigh: true` was in the values and in the generated export, and the rendered chart still carried the chart's own rule
- **Root Cause**: `charts/addons/templates/*.yaml` build `spec.source.helm.values` field by field; nothing passes a values file through. A key with no matching line in the Application template is simply not in the rendered Application
- **Solution**: Added the `defaultRules:` block to `charts/addons/templates/kube-prometheus-stack.yaml`, the same way `kubeProxy` is emitted
- **Prevention**: Level 0 renders the Application, not the upstream chart's output, so it cannot catch this. Confirm a values change with `helm template <upstream chart> -f <the values from the snapshot>` and grep for what should have changed

### 2026-09-23 - HomelabTraefikDown fired critical for both ingresses while Traefik was healthy
- **Issue**: After PR #321 rolled out, `HomelabTraefikDown` fired critical for `traefik-internal` and `traefik-external`. All four Traefik pods were Running and every scrape target was `up`
- **Root Cause**: The rule matched `job="traefik-internal"`, assuming job = release name. The Traefik chart's ServiceMonitor has no `jobLabel`, so Prometheus uses the metrics Service name: `traefik-internal-metrics` and `traefik-external-metrics`. The `absent()` branches were always true
- **Solution**: The rule now matches the `-metrics` job names. Verified against live Prometheus: 0 results
- **Prevention**: Evaluate every new alert expression against live Prometheus before merging (`task prod:kubeconfig`, port-forward `svc/kube-prometheus-stack-prometheus`); an `absent()` on a wrong label always fires

### 2026-09-23 - LAN VLAN 10 broadcasts reached every Talos node (HomelabHubbleDropsHigh VLAN_FILTERED)
- **Issue**: `HomelabHubbleDropsHigh` at ~23 packets/s, reason `VLAN_FILTERED`, no source or destination identity. Each frame was dropped on all six nodes: ARP, SSDP, IGMP, UniFi discovery (UDP 10001), UDP 6667 broadcasts, all from 172.16.10.0/24 (the LAN, VLAN 10)
- **Root Cause**: The Talos VM NICs (`net0`, no `tag`, no `trunks`) sit on the VLAN-aware `vmbr0`. For such a port Proxmox runs `bridge vlan add vid 2-4094` (`PVE/Network.pm`), so every tap is a trunk of all VLANs. `nic1` carries VLAN 10 tagged for the TrueNAS VM (`net1`, tag 10), so every LAN broadcast was delivered, tagged, into every Kubernetes node, where Cilium dropped it. The cluster VLAN was not isolated from the LAN at layer 2
- **Solution**: `trunks = "1"` on the Talos VM `network_device`: the tap joins only the bridge native VLAN, which is how the switch delivers VLAN 100. The TrueNAS VM net0 (untagged) had the same 2-4094 trunk and gets the same fix; its net1 keeps tag 10 The alert was left unchanged, since a leak like this is what it should catch
- **Prevention**: On a VLAN-aware Proxmox bridge an untagged VM NIC is a trunk of every VLAN. Give every VM NIC a `tag` or an explicit `trunks`, and check with `bridge vlan show` on the host

### 2026-09-23 - KubeCPUOvercommit after the observability rollout
- **Issue**: `KubeCPUOvercommit`: pod CPU requests 0.18 CPU over what the cluster can hold with its largest node down
- **Root Cause**: The PR #321 DaemonSets (istio-cni, ztunnel, OTel agents) landed on top of four Traefik pods requesting 500m each while using 1-2m
- **Solution**: Traefik CPU requests 500m -> 100m (limit stays 1000m; the HPA target is relative to the request), which frees 1.6 CPU
- **Prevention**: Size requests from `container_cpu_usage_seconds_total`, not from defaults

### 2026-09-23 - Log-pipeline alerts matched otelcol_*_total names the collector does not expose
- **Issue**: `HomelabLogsNotArriving` fired while the agents read ~70 container log lines/s; `HomelabLogExportFailing`, `HomelabTraceExportFailing` and `HomelabTelemetryRefused` could never fire, and `HomelabUniFiTelemetrySilent` stayed quiet although no UniFi syslog or NetFlow record had ever arrived
- **Root Cause**: The rules (PR #321, taken from the opentelemetry-collector chart) used `otelcol_receiver_accepted_log_records_total` and friends. The deployed collector exports its own metrics without the `_total` suffix (`otelcol_receiver_accepted_log_records`, `otelcol_exporter_send_failed_spans`, ...), so rates were empty and `absent()` always true. The UniFi rule compared a rate to 0, which returns nothing when the receiver has never produced a series
- **Solution**: Every otelcol name in `homelab-logging` without `_total`; `HomelabUniFiTelemetrySilent` also fires on `absent()` of the syslog and netflow series. Verified against live Prometheus: LogsNotArriving, the export, refused and queue rules return nothing; UniFiTelemetrySilent returns syslog and netflow, because the gateway has received neither since it started (a real gap: the UniFi export is not configured yet)
- **Prevention**: Check a rule's metric names with `/api/v1/label/__name__/values` on the live Prometheus, and give every rate-based "silent" alert an `absent()` branch

### 2026-09-24 - UniFi NetFlow apply failed with api.err.NetflowNetworkIdsRequired
- **Issue**: The first `task tf:apply:component COMPONENT=unifi-gateway` (PR #338) created `unifi_setting.syslog` but `terraform_data.netflow` failed: `PUT .../set/setting/netflow` returned HTTP 400 `api.err.NetflowNetworkIdsRequired`
- **Root Cause**: The controller refuses to enable NetFlow without `network_ids`, the networks to monitor. The live setting had none, and the script only merged enabled, server, port and version. The script's dry run cannot catch it, since only the controller validates the write
- **Solution**: `scripts/unifi-setting.ts apply --all-networks` sets `network_ids` to every enabled `corporate` and `guest` network from `rest/networkconf` (sorted, so re-runs stay idempotent); the unit passes the flag
- **Prevention**: When a setting is enabled for the first time through the raw API, check which fields the UI sends alongside the toggle

### 2026-09-25 - github-pr-exporter stayed OutOfSync after every sync
- **Issue**: Application `github-pr-exporter` synced successfully but both ServiceMonitors (`github-pr-exporter-unreviewed`, `-review-requested`) stayed OutOfSync
- **Root Cause**: The `query` relabeling (`additionalRelabels`) had no `action`; the ServiceMonitor CRD defaults it to `replace`, so the live object always carried a field Git did not
- **Solution**: Set `action: replace` explicitly in `charts/addons/templates/github-pr-exporter.yaml`
- **Prevention**: Write every relabeling with an explicit `action`; CRD defaults show up as permanent drift under ServerSideApply

### 2026-09-25 - Paperclip agent runs failed with ENOSPC on a full paperclip-data volume
- **Issue**: `KubePersistentVolumeFillingUp` (paperclip-data 0% free), `PaperclipAgentFailureRateHigh` (100% of runs failed) and `PaperclipRecoveryRateBreached`; the server logged `ENOSPC: no space left on device` writing `workspace-operation-logs`
- **Root Cause**: The 10Gi iSCSI volume held agent workspaces (3.2G) plus tool caches in the home directory (mise 2.5G, npm 2.5G, go-build 0.6G). paperclip-operator 0.19.1 only creates the PVC (`reconcilePVC`) and never resizes it, so raising `spec.storage.persistence.size` alone changes nothing
- **Solution**: Homelab size is 200Gi (`configuration/templates/helm-apps.tmpl`), and `charts/paperclip/templates/pvc.yaml` renders `paperclip-data` so ArgoCD (ServerSideApply) expands it in place; `democratic-csi-iscsi` allows expansion. `Prune=false,Delete=false` keep the data if the template goes away
- **Prevention**: For operator-owned PVCs, check whether the operator reconciles size before relying on its CR field
