# Applications

Every ArgoCD Application the homelab runs, with the chart it comes from, the version
`configuration/versions.yaml` pins, the Gateway its route attaches to (if any), and how it is
verified: a chainsaw suite under `tests/e2e/<name>/` and a PostSync smoke Job `smoke-<name>`
(`charts/*/templates/_smoke.tpl`) that only lets a sync reach `Succeeded` once the endpoint
answers.

The two tables are generated from `tests/snapshots/homelab/{addons,applications}.yaml` by
`task docs:check -- --fix` (`scripts/docs-check.ts`); `task docs:check` fails when they
drift. Do not edit them by hand.

- **Source** is the upstream chart name for chart-sourced Applications and the git path for
  the child charts in this repository (`charts/<name>-config`, `-dependencies`, ...), which
  receive their derived values from the parent Application's `helm.valuesObject` (ADR-010).
- **Version** is the chart version rendered in the homelab snapshot, which the CMP takes from
  `configuration/versions.yaml` `charts.<name>`; `git` means the child chart tracks the same
  revision as its parent.
- **Route** names the Gateway the route attaches to (`envoy-external` or `envoy-internal`, see
  [networking.md](./networking.md)) and the host without its domain.
- **chainsaw e2e** and **Smoke Job** list the suite and Job names, or `—`.

## Addons

Infrastructure Applications rendered by `charts/addons` (parent Application `addons`,
sync wave 1 in homelab). Waves inside the chart run from -1 (namespaces, repositories) to 11.

<!-- docs-check:begin addons-table -->
| Application | Source | Version | Route | chainsaw e2e | Smoke Job |
| --- | --- | --- | --- | --- | --- |
| `agent-readonly` | `charts/agent-readonly` | git | — | agent-readonly | — |
| `argo-workflows` | `argo-workflows` | 1.0.18 | envoy-internal: workflows | — | — |
| `blackbox-exporter` | `prometheus-blackbox-exporter` | 11.18.0 | — | — | — |
| `cert-manager` | `cert-manager` | v1.20.3 | — | cert-manager | — |
| `cert-manager-cluster-issuer` | `charts/cert-manager-cluster-issuer` | git | — | — | — |
| `cert-manager-config` | `charts/cert-manager-config` | git | — | — | — |
| `cilium` | `cilium` | 1.19.5 | — | cilium-netpol | — |
| `cilium-config` | `charts/cilium-config` | git | envoy-internal: hubble | — | — |
| `clickhouse` | `charts/clickhouse` | git | — | — | smoke-clickhouse |
| `clickhouse-dependencies` | `charts/clickhouse-dependencies` | git | — | — | — |
| `clickhouse-operator` | `altinity-clickhouse-operator` | 0.27.3 | — | — | — |
| `cloudnative-pg` | `cloudnative-pg` | 0.28.3 | — | cloudnative-pg | — |
| `cnpg-barman-cloud` | `plugin-barman-cloud` | 0.8.0 | — | — | — |
| `democratic-csi` | `democratic-csi` | 0.15.1 | — | — | — |
| `democratic-csi-config` | `charts/democratic-csi-config` | git | — | — | — |
| `democratic-csi-iscsi` | `democratic-csi` | 0.15.1 | — | — | — |
| `democratic-csi-iscsi-hdd` | `democratic-csi` | 0.15.1 | — | — | — |
| `democratic-csi-ssd` | `democratic-csi` | 0.15.1 | — | — | — |
| `envoy-gateway` | `gateway-helm` | v1.9.1 | — | envoy-gateway | — |
| `envoy-gateway-config` | `charts/envoy-gateway-config` | git | — | envoy-gateway | — |
| `envoy-gateway-crds` | `gateway-crds-helm` | v1.9.1 | — | — | — |
| `external-dns-cloudflare` | `external-dns` | 1.21.1 | — | — | — |
| `external-dns-cloudflare-crd` | `external-dns` | 1.21.1 | — | — | — |
| `external-dns-config` | `charts/external-dns-config` | git | — | — | — |
| `external-dns-unifi-crd` | `external-dns` | 1.21.1 | — | — | — |
| `external-dns-unifi-ingress` | `external-dns` | 1.21.1 | — | — | — |
| `gateway-api-crds` | `config/crd/standard` | git | — | — | — |
| `github-pr-exporter` | `prometheus-json-exporter` | 0.20.1 | — | — | — |
| `grafana-config` | `charts/grafana-config` | git | — | — | — |
| `intel-device-plugins-operator` | `intel-device-plugins-operator` | 0.36.0 | — | — | — |
| `intel-gpu-device-plugin` | `intel-device-plugins-gpu` | 0.36.0 | — | — | — |
| `istio-base` | `base` | 1.31.1 | — | — | — |
| `istio-cni` | `cni` | 1.31.1 | — | — | — |
| `istio-config` | `charts/istio-config` | git | envoy-internal: servicemesh | — | — |
| `istio-gateways` | `charts/istio-gateways` | git | — | istio-gateways | — |
| `istiod` | `istiod` | 1.31.1 | — | — | — |
| `kiali` | `kiali-server` | 2.32.0 | — | — | smoke-kiali |
| `kube-prometheus-stack` | `kube-prometheus-stack` | 87.21.0 | envoy-internal: alertmanager, grafana | grafana | smoke-grafana, smoke-prometheus |
| `kubelet-csr-approver` | `kubelet-csr-approver` | 1.2.14 | — | — | — |
| `metrics-server` | `metrics-server` | 3.14.0 | — | — | — |
| `node-feature-discovery` | `node-feature-discovery` | 0.18.3 | — | — | — |
| `otel-collector-agent` | `opentelemetry-collector` | 0.173.1 | — | — | — |
| `otel-collector-cluster` | `opentelemetry-collector` | 0.173.1 | — | — | — |
| `otel-collector-gateway` | `opentelemetry-collector` | 0.173.1 | envoy-internal: otel, otlp | — | — |
| `port-forwarding-controller` | `port-forwarding` | 1.1.1 | — | — | — |
| `port-forwarding-controller-config` | `charts/port-forwarding-controller-config` | git | — | — | — |
| `prometheus-config` | `charts/prometheus-config` | git | — | — | — |
| `spegel` | `spegel` | 0.6.0 | — | — | — |
| `tailscale-config` | `charts/tailscale-config` | git | — | — | — |
| `tailscale-operator` | `tailscale-operator` | 1.98.4 | — | — | — |
| `ztunnel` | `ztunnel` | 1.31.1 | — | — | — |
<!-- docs-check:end addons-table -->

Notes:

- The homelab snapshot is rendered from `configuration/environments/homelab.yaml.example`,
  whose `GPU_VENDOR` is `intel` like production (`gpu_vendor = "intel"` in
  `terragrunt/environments/homelab/env.hcl`), so it lists `intel-device-plugins-operator` and
  `intel-gpu-device-plugin`. Setting `nvidia` swaps them for `nvidia-gpu-operator`
  (`charts/addons/templates/nvidia-gpu-operator.yaml`); the two vendors are mutually
  exclusive on the same sync wave, and the NVIDIA path has no level-0 coverage today.
- `local-path-provisioner` and `oauth2-proxy` have templates in `charts/addons` but render
  only where their capability keys enable them (`STORAGE_PROVIDER=local-path` in Kind; the
  OIDC lane, see networking.md).
- `cnpg-barman-cloud` is disabled by default; the restore drill (`task drill:restore`,
  `tests/drills/`) enables it in Kind against a throwaway `versitygw` S3 endpoint
  (`images.versitygw`).

## Applications

User workloads rendered by `charts/applications` (parent Application `applications`,
sync wave 10 in homelab; children occupy waves 10-15). Namespaces and OCI repositories come
from the same chart (`namespaces.yaml`, `oci-repositories.yaml`).

<!-- docs-check:begin applications-table -->
| Application | Source | Version | Route | chainsaw e2e | Smoke Job |
| --- | --- | --- | --- | --- | --- |
| `duckdns` | `charts/duckdns` | git | — | — | — |
| `duckdns-dependencies` | `charts/duckdns-dependencies` | git | — | — | — |
| `flaresolverr` | `flaresolverr` | 16.18.2 | — | flaresolverr | smoke-flaresolverr |
| `flaresolverr-config` | `charts/flaresolverr-config` | git | — | — | — |
| `lazylibrarian` | `lazylibrarian` | 21.18.2 | envoy-internal: lazylibrarian | lazylibrarian | smoke-lazylibrarian |
| `lazylibrarian-config` | `charts/lazylibrarian-config` | git | — | — | — |
| `mosquitto` | `mosquitto` | 17.17.2 | — | mosquitto | — |
| `mosquitto-config` | `charts/mosquitto-config` | git | — | — | — |
| `nzbget` | `nzbget` | 29.4.2 | envoy-internal: nzbget | nzbget | smoke-nzbget |
| `nzbget-config` | `charts/nzbget-config` | git | — | — | — |
| `paperclip` | `charts/paperclip` | git | envoy-internal: paperclip | paperclip | smoke-paperclip |
| `paperclip-database` | `charts/paperclip-database` | git | — | — | — |
| `paperclip-dependencies` | `charts/paperclip-dependencies` | git | — | — | — |
| `paperclip-operator` | `paperclip-operator` | 0.19.1 | — | — | — |
| `plex` | `plex-media-server` | 1.6.0 | envoy-external: plex | plex | smoke-plex |
| `plex-config` | `charts/plex-config` | git | — | — | — |
| `prowlarr` | `prowlarr` | 21.7.3 | envoy-internal: prowlarr | prowlarr | smoke-prowlarr |
| `prowlarr-config` | `charts/prowlarr-config` | git | — | — | — |
| `radarr` | `radarr` | 26.7.2 | envoy-internal: radarr | radarr | smoke-radarr |
| `radarr-config` | `charts/radarr-config` | git | — | — | — |
| `renovate` | `renovate` | 46.106.12 | — | — | — |
| `renovate-config` | `charts/renovate-config` | git | — | — | — |
| `sonarr` | `sonarr` | 25.6.3 | envoy-internal: sonarr | sonarr | smoke-sonarr |
| `sonarr-config` | `charts/sonarr-config` | git | — | — | — |
| `tautulli` | `tautulli` | 21.18.2 | envoy-internal: tautulli | tautulli | smoke-tautulli |
| `tautulli-config` | `charts/tautulli-config` | git | — | — | — |
<!-- docs-check:end applications-table -->

Notes:

- `homeassistant` has a template (`charts/applications/templates/homeassistant.yaml`) but is
  disabled in the homelab render, so it does not appear in the snapshot or the table.
- Paperclip is the operator-backed pattern with its own database (ADR-015,
  `docs/apps/paperclip.md`): `paperclip-operator` (OCI chart, CRDs) → `paperclip-dependencies`
  (OnePasswordItems) → `paperclip-database` (CloudNativePG `Cluster` on the iSCSI SSD class)
  → `paperclip` (the `Instance`).
- `mosquitto` has no HTTP endpoint, so it opts out of the smoke Job (`smoke.enabled: false`);
  its chainsaw suite does a TCP connect instead.
- The `*-config` and `*-dependencies` children carry no ingress and are covered by their
  parent's suite; they render nothing for the tables' last three columns by design.

## Coverage gaps

- `workflows` (`argo-workflows`) has an internal route but **no chainsaw suite and no smoke
  Job**. TODO: add `tests/e2e/argo-workflows/chainsaw-test.yaml` (assert the Application is
  Healthy, then curl `workflows.homelab.local` through `envoy-internal`) and a `smoke:` block
  in `configuration/templates/helm-addons.tmpl`.
- `renovate`, `duckdns`, `spegel`, `tailscale-operator`, `port-forwarding-controller`,
  `kubelet-csr-approver`, `node-feature-discovery`, the GPU operator and the `external-dns-*`
  Applications have no in-cluster HTTP endpoint and are verified only by ArgoCD health
  (`task verify LEVEL=2`, `argocd/<app>`).
- `democratic-csi*`: covered indirectly by every suite that binds a PVC; the Kind loop uses
  the `local-path` aliases (`localdev/fakes/storageclasses.yaml`), so the TrueNAS drivers are
  exercised only in production.

See [architecture.md#verification](./architecture.md#verification) for the levels and
[runbooks/verification.md](./runbooks/verification.md) for every check name.
