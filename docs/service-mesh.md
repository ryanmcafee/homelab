# Service mesh: Istio ambient + Kiali

Istio runs in ambient mode: no sidecars, a per-node `ztunnel` carries mTLS and L4 telemetry for
enrolled pods, and `istio-cni` redirects their traffic into it. **No namespace is enrolled by
default**; the mesh costs nothing to a workload until its namespace opts in. Kiali shows the
mesh graph at `https://servicemesh.<DOMAIN>` on the internal ingress. Decision record: ADR-020
in `docs/project_notes/decisions.md`.

| Application | Chart (`configuration/versions.yaml`) | Wave | Notes |
|---|---|---|---|
| `istio-base` | `base` (`charts.istio`) | 2 | CRDs, default validating webhook |
| `istiod` | `istiod` (`charts.istio`), `profile: ambient` | 3 | control plane |
| `istio-cni` | `cni` (`charts.istio`), `profile: ambient` | 3 | DaemonSet `istio-cni-node`, chained after Cilium in `/etc/cni/net.d` |
| `ztunnel` | `ztunnel` (`charts.istio`) | 4 | DaemonSet, one per node |
| `istio-config` | `charts/istio-config` | 5 | upstream ServiceMonitor (istiod) and PodMonitor (ztunnel, waypoints) |
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

Namespaces of the applications chart are enrolled through `configuration/`:

```yaml
# configuration/environments/homelab.yaml (and the homelab-environment-config document)
SERVICE_MESH_AMBIENT_NAMESPACES: "paperclip"
```

`charts/applications/templates/_mesh.tpl` then adds `istio.io/dataplane-mode: ambient` to that
Namespace (media, home-automation, paperclip-operator, paperclip). Pods are captured on their
next start; restart them to enroll running ones. hostNetwork pods are never captured. For a
namespace outside the applications chart, add the label to its Namespace manifest in Git.
Leave the mesh again by removing the name; the label disappears on the next sync.

L7 policy and telemetry need a waypoint in the namespace
(`istioctl waypoint apply -n <ns> --enroll-namespace` produces the Gateway to commit); the
`envoy-stats-monitor` PodMonitor already scrapes waypoints.

## Kiali

`https://servicemesh.<DOMAIN>` (`SERVICEMESH_HOSTNAME`, derived from `DOMAIN`), IngressClass
`internal`, certificate `kiali-tls` from the `letsencrypt` ClusterIssuer, record published by
external-dns. Login uses a Kubernetes token and shows what that token may read:

```bash
kubectl -n istio-system create token kiali --duration 8h
```

## Metrics, alerts, dashboards

- Scrapes: `istio-component-monitor` (istiod `http-monitoring`), `envoy-stats-monitor`
  (every `istio-proxy` container: ztunnel and waypoints) from `charts/istio-config`.
- Alerts `homelab-service-mesh`: `HomelabIstiodDown`, `HomelabMeshNodeAgentNotReady`,
  `HomelabIstioXdsRejects` ([runbooks/alerting.md](runbooks/alerting.md)).
- Grafana folder "Homelab": Istio Control Plane (7645), Mesh (7639), Service (7636), Workload
  (7630), Ztunnel (21306) from grafana.com, revisions pinned in
  `configuration/templates/helm-addons.tmpl`.
