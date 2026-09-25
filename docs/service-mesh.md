# Service mesh: Istio ambient + Kiali

Istio runs in ambient mode: no sidecars, a per-node `ztunnel` carries mTLS and L4 telemetry for
enrolled pods, and `istio-cni` redirects their traffic into it. Only the namespaces listed in
`SERVICE_MESH_AMBIENT_NAMESPACES` are enrolled; the default is `paperclip` (with a waypoint), so
the paperclip request path has L7 metrics and spans; every other workload is untouched. Kiali
shows the mesh graph at `https://servicemesh.<DOMAIN>` on the `envoy-internal` Gateway. Decision
records: ADR-020, ADR-021 in `docs/project_notes/decisions.md`.

Istio 1.31.1 (`charts.istio`, from `https://blob.istio.io/istio-release/charts`; the old
storage.googleapis.com repository ends at 1.30.5) supports Kubernetes 1.32-1.36: production runs
v1.32.0 and Kind v1.36.1. `tools.kubernetes` (v1.37.0, the upgrade target) is outside that range;
upgrading the cluster past 1.36 needs an Istio release that supports it first.

| Application | Chart (`configuration/versions.yaml`) | Wave | Notes |
|---|---|---|---|
| `gateway-api-crds` | kubernetes-sigs/gateway-api `config/crd/standard` (`charts.gateway-api`) | 1 | Gateway API CRDs (`charts/addons/templates/gateway-api-crds.yaml`), shared with Envoy Gateway and the Istio gateways; a waypoint is a Gateway |
| `istio-base` | `base` (`charts.istio`) | 2 | CRDs, default validating webhook (`validationFailurePolicy: Fail` in base and istiod, so istiod never flips it under server-side apply) |
| `istiod` | `istiod` (`charts.istio`), `profile: ambient` | 3 | control plane |
| `istio-cni` | `cni` (`charts.istio`), `profile: ambient` | 3 | DaemonSet `istio-cni-node`, chained after Cilium in `/etc/cni/net.d` |
| `ztunnel` | `ztunnel` (`charts.istio`) | 4 | DaemonSet, one per node |
| `istio-config` | `charts/istio-config` | 5 | upstream ServiceMonitor (istiod) and PodMonitor (waypoints), PodMonitors for ztunnel and istio-cni, Telemetry `mesh-default` (tracing), the Kiali HTTPRoute |
| `istio-gateways` | `charts/istio-gateways` | 7 | comparison Gateways `istio-internal` / `istio-external` and the `echo` backend ([below](#istio-gateways-for-comparison)) |
| `kiali` | `kiali-server` (`charts.kiali-server`) | 10 | Prometheus and Grafana of kube-prometheus-stack |

All four Istio charts share one version key, so Renovate bumps them together. Namespace
`istio-system` is PodSecurity `privileged` (istio-cni and ztunnel need host paths and
`NET_ADMIN`; Talos enforces `baseline` by default). The mesh is on wherever
`CNI_PROVIDER=cilium`, which includes the Kind loop.

## Cilium prerequisites (human step in homelab)

Istio's platform prerequisites for Cilium are set in the `cilium` block of
`configuration/templates/helm-addons.tmpl` and in `task cilium:render`:

| Cilium value | Why |
|---|---|
| `cni.exclusive: false` | Cilium otherwise deletes every other CNI config, including the chained `istio-cni` entry |
| `socketLB.hostNamespaceOnly: true` | with kube-proxy replacement, socket load balancing in pod namespaces rewrites the Service address before ztunnel's redirection sees it |
| `bpf.masquerade` left at its default `false` | Istio: BPF masquerading breaks kubelet health probes of ambient pods; keep iptables masquerading |

In homelab Talos installs Cilium from inline manifests and the `cilium` Application only adopts
the release. After merge that Application syncs the new `cilium-config` ConfigMap, but the
agents read it only at start and the Talos inline manifest still carries the old values. A
human therefore runs:

```bash
task render && task render:push   # re-render terragrunt/files/cilium-rendered.yaml, store it in 1Password
task tf:plan                      # review: only cilium-config changes
task tf:apply
kubectl -n kube-system rollout restart daemonset/cilium   # agents pick up the new config node by node
```

Until then `istio-cni` runs but Cilium may remove its chained config on the next agent restart;
nothing is enrolled, so no workload is affected. Kind picks the values up at
`task localdev:kind`.

**Default-deny NetworkPolicies.** Ambient SNATs kubelet health probes of enrolled pods to
`169.254.7.127`. A Cilium default-deny policy in an enrolled namespace must allow that address
or probes fail; none exists today. Istio's fix is a `CiliumClusterwideNetworkPolicy` allowing
ingress from `169.254.7.127/32` to every endpoint (`allow-ambient-hostprobes` in the Istio
platform prerequisites).

## Enroll a namespace

Namespaces of the applications chart are enrolled through `configuration/` (defaults in
`configuration/schema/kubernetes.schema.yaml`):

```yaml
# configuration/environments/<set>.yaml (and the homelab-environment-config document)
SERVICE_MESH_AMBIENT_NAMESPACES: "paperclip,media"   # "none" enrolls nothing
SERVICE_MESH_WAYPOINT_NAMESPACES: "paperclip"        # must also be enrolled
```

`charts/applications/templates/_mesh.tpl` labels each listed Namespace
`istio.io/dataplane-mode: ambient`; with a waypoint also `istio.io/use-waypoint: waypoint` and
`istio.io/ingress-use-waypoint: "true"` (traffic from outside the mesh, i.e. Envoy Gateway, goes
through the waypoint too), and `templates/waypoints.yaml` renders the Gateway `waypoint`
(class `istio-waypoint`, HBONE 15008). Pods are captured on their next start; hostNetwork pods
never are. For a namespace outside the applications chart, add the labels to its Namespace
manifest in Git.

**Paperclip.** Enrolled with a waypoint in every environment, Kind included (the paperclip and
service-mesh e2e tests go through it). Two adjustments:

- The operator's NetworkPolicy only knows the app port 3100; `charts/paperclip`
  `templates/networkpolicy-ambient.yaml` adds TCP 15008 (HBONE) in and out. NetworkPolicies are
  additive, so the operator's rules stay as they are.
- `paperclip-postgres` stays out of the mesh: the CNPG Cluster's `inheritedMetadata` labels its
  pods `istio.io/dataplane-mode: none` and its Services `istio.io/use-waypoint: none`. A ztunnel
  restart must never cut database connections, and the database needs no mTLS inside one
  namespace; the connection stays visible in Hubble (plaintext 5432).

## Kiali

`https://servicemesh.<DOMAIN>` (`SERVICEMESH_HOSTNAME`, derived from `DOMAIN`), an HTTPRoute on
the `https` listener of `envoy-internal` (TLS is the Gateway's wildcard certificate), record
published by external-dns. The route lives in `charts/istio-config`: the kiali-server chart only
renders an Ingress, which Envoy Gateway does not serve. Login uses a Kubernetes token and shows what that token may read:

```bash
kubectl -n istio-system create token kiali --duration 8h
```

## Istio gateways for comparison

`charts/istio-gateways` (Application `istio-gateways`, addons wave 7, namespace
`istio-ingress`) deploys Istio's Gateway API implementation next to Envoy Gateway, to compare
the two on the same traffic before choosing whether ingress should ever move into the mesh
(ADR-034). It takes no production traffic: no DNS record or port forward points at it.

| | Istio | Envoy Gateway |
|--|-------|---------------|
| GatewayClass | `istio-internal`, `istio-external` (controller `istio.io/gateway-controller`) | `envoy-internal`, `envoy-external` |
| Gateway, Deployment, Service | same names in `istio-ingress` (`gateway.istio.io/name-override`) | same names in `envoy-gateway-system` |
| Listeners | `http` 80 (301 redirect), `https` 443 `*.<DOMAIN>` | identical |
| Certificate | `gateway-wildcard-tls` from `envoy-gateway-system`, read through ReferenceGrant `istio-gateways-certificate` | owner of the Secret |
| Metrics | `envoy-stats-monitor` PodMonitor (`charts/istio-config`) | PodMonitor `<gateway>-proxy` |
| Routes | only `echo` | every application |

The `echo` Deployment (agnhost `netexec`) has one HTTPRoute with two parents,
`envoy-internal` and `istio-internal`, on `echo.<DOMAIN>`. DNS sends the name to Envoy; to
send the same request through Istio, pin the name to the Istio Service address:

```bash
ISTIO_IP=$(kubectl -n istio-ingress get svc istio-internal -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -s https://echo.<DOMAIN>/hostname                                        # envoy-internal
curl -s --resolve echo.<DOMAIN>:443:$ISTIO_IP https://echo.<DOMAIN>/hostname      # istio-internal
curl -s -o /dev/null -w '%{time_connect} %{time_appconnect} %{time_total}\n' \
  --resolve echo.<DOMAIN>:443:$ISTIO_IP https://echo.<DOMAIN>/hostname
```

Compare latency (the `-w` timings, or a load tool with `--resolve`), resource use
(`kubectl top pod -n istio-ingress` vs `-n envoy-gateway-system`) and the per-gateway metrics in
Grafana. Remove `charts/istio-gateways` and its Application once the comparison is done.

## Metrics, alerts, dashboards

- Scrapes (`charts/istio-config`): `istio-component-monitor` (istiod `http-monitoring`),
  `envoy-stats-monitor` (waypoints), `ztunnel` (port `ztunnel-stats` 15020) and `istio-cni`
  (port `metrics` 15014).
- Tracing: waypoint spans to the gateway collector at 10 % (docs/tracing.md); ztunnel is L4 only.
- Alerts `homelab-service-mesh`: `HomelabIstiodDown`, `HomelabMeshNodeAgentNotReady`,
  `HomelabIstioXdsRejects` ([runbooks/alerting.md](runbooks/alerting.md)).
- Grafana folder "Homelab": Istio Control Plane (7645), Mesh (7639), Service (7636), Workload
  (7630), Ztunnel (21306) from grafana.com, revisions pinned in
  `configuration/templates/helm-addons.tmpl`.
