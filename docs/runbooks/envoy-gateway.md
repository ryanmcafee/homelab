# Envoy Gateway: cutover, debugging, new routes

Envoy Gateway is the cluster's ingress (ADR-034). Two Gateways in `envoy-gateway-system`:
`envoy-internal` (LAN + tailnet) and `envoy-external` (Internet). Design and request paths:
[networking.md](../networking.md#ingress-envoy-gateway).

## Cutover from the previous ingress

### Before merging

1. Read the addresses the old ingress Services hold today; they become the Gateway addresses:

   ```bash
   kubectl get svc -A -o wide | rg LoadBalancer
   ```

2. In `configuration/environments/homelab.yaml` add
   `GATEWAY_EXTERNAL_STATIC_IP` (the old external ingress address, the value of the old `*_STATIC_IP` key for it) and
   `GATEWAY_INTERNAL_STATIC_IP` (the old internal ingress address). Keep the old keys until the
   cutover is done: `main` still renders from the same document until the merge, and a
   rollback needs them.
3. Validate both renders: `task config:validate` on this branch and on `main`.
4. Upload the same file to the 1Password document `homelab-environment-config` (vault `homelab`),
   which the CMP reads:

   ```bash
   op document edit homelab-environment-config configuration/environments/homelab.yaml \
     --vault homelab --file-name homelab.yaml
   ```

   Wait for the operator to refresh Secret `argocd/homelab-environment-config` (or delete the
   Secret to force it), then check that `task prod:diff -- addons` renders.

### What happens on sync

| Step | Expected |
|------|----------|
| `addons` syncs | `gateway-api-crds` (wave 1), `envoy-gateway-crds` (4), `envoy-gateway` (5), `envoy-gateway-config` (6, both Gateways + wildcard certificate), `istio-gateways` (7) are created; the old ingress Applications are pruned with their Services |
| Addresses move | Cilium LB IPAM gives `envoy-external` / `envoy-internal` the pinned addresses once the old Services release them. Until then the Envoy Service stays `<pending>`; UniFi DNS records and the WAN port forwards keep pointing at the same addresses, so nothing outside the cluster changes |
| Certificate | cert-manager issues `gateway-wildcard-tls` (DNS-01, a minute or two); the `https` listeners report `ResolvedRefs` False until the Secret exists |
| Addons-tier routes | Grafana, Argo Workflows, Kiali, Hubble, the OTel collector and ArgoCD (bootstrap) answer through `envoy-internal` |
| `applications` syncs | App Ingresses are pruned and their HTTPRoutes created; between the two syncs those hosts answer 404 from Envoy |
| external-dns | Switches to the `gateway-httproute` source with the same owner IDs, so records are adopted, not recreated |

### Checks after the sync

```bash
kubectl -n envoy-gateway-system get gateway,svc,pods          # PROGRAMMED True, EXTERNAL-IP = pinned addresses
kubectl get httproute -A                                        # one route per host
kubectl get httproute -A -o json | jq -r '.items[] | select([.status.parents[]?.conditions[]? | select(.type=="Accepted" and .status!="True")] | length > 0) | "\(.metadata.namespace)/\(.metadata.name)"'
curl -sI https://plex.<DOMAIN>                                  # from outside: 200/302 through the port forward
curl -sI https://grafana.<DOMAIN>                               # from the LAN or tailnet
task verify:prod
```

Once stable, delete the keys the schema no longer declares from `homelab.yaml` and the
1Password document.

### Rollback

Revert the PR. The old ingress Applications come back through `addons`, the Envoy Services are
pruned and the addresses move back. The old keys must still be in the 1Password document
(step 2 above).

## Day-2 debugging

| Symptom | Look at |
|---------|---------|
| Gateway not `Programmed` | `kubectl -n envoy-gateway-system describe gateway envoy-internal`; Service `<pending>` means the address is taken (`kubectl get svc -A -o wide \| rg <ip>`) |
| Route not served (404) | `kubectl -n <ns> get httproute <name> -o yaml`: `status.parents[].conditions` must show `Accepted` and `ResolvedRefs` True; `sectionName: https` and the hostname under `*.<DOMAIN>` |
| 503 / `no healthy upstream` | backend Service name/port in `backendRefs`, endpoints (`kubectl -n <ns> get endpointslices`), NetworkPolicies allowing `envoy-gateway-system` |
| TLS error | `kubectl -n envoy-gateway-system get certificate gateway-wildcard-tls`, `kubectl describe certificaterequest -n envoy-gateway-system` |
| Controller errors | `kubectl -n envoy-gateway-system logs deploy/envoy-gateway` |

Proxy pods carry `gateway.envoyproxy.io/owning-gateway-name=<gateway>`:

```bash
POD=$(kubectl -n envoy-gateway-system get pod -l gateway.envoyproxy.io/owning-gateway-name=envoy-internal -o name | head -1)
kubectl -n envoy-gateway-system logs $POD -c envoy --tail=50        # JSON access log
kubectl -n envoy-gateway-system port-forward $POD 19000:19000       # Envoy admin
curl -s localhost:19000/clusters | rg -i sonarr                     # upstream health
curl -s localhost:19000/config_dump | jq '.configs | length'
```

`egctl` (Envoy Gateway CLI, same version as `charts.envoy-gateway`) shows the translated
configuration: `egctl config envoy-proxy route -n envoy-gateway-system ${POD#pod/}`.

Access log in ClickHouse (fields from `charts/envoy-gateway-config/templates/envoyproxy.yaml`;
more queries in [logging.md](../logging.md)):

```sql
SELECT Timestamp,
       JSONExtractString(Body, 'gateway') AS gateway,
       JSONExtractString(Body, 'path') AS path,
       JSONExtractInt(Body, 'response_code') AS status,
       JSONExtractString(Body, 'response_flags') AS flags,
       JSONExtractInt(Body, 'duration_ms') AS ms
FROM otel.otel_logs
WHERE ResourceAttributes['k8s.namespace.name'] = 'envoy-gateway-system'
  AND JSONExtractString(Body, 'authority') LIKE 'paperclip.%'
  AND (status >= 500 OR ms > 1000)
ORDER BY Timestamp DESC LIMIT 200;
```

`response_flags` names the Envoy-side reason (`UF` upstream connect failure, `UT` upstream
timeout, `NR` no route, `DC` downstream disconnect).

## Add a route for a new app

1. Use the upstream chart's route support if it has one; otherwise add an `HTTPRoute` template.
   `task scaffold -- app <name>` generates either shape.
2. Attach it to one Gateway's `https` listener, with the hostname from a `<APP>_HOSTNAME` schema key:

   ```yaml
   annotations:
     external-dns.alpha.kubernetes.io/hostname: {{ .Values.APP_HOSTNAME.Value }}
   parentRefs:
     - group: gateway.networking.k8s.io
       kind: Gateway
       name: {{ .Values.GATEWAY_INTERNAL.Value }}   # GATEWAY_EXTERNAL for Internet-facing apps
       namespace: {{ .Values.GATEWAY_NAMESPACE.Value }}
       sectionName: https
   hostnames:
     - {{ .Values.APP_HOSTNAME.Value }}
   ```

   External routes also set `external-dns.alpha.kubernetes.io/target: <EXTERNAL_DNS_DEFAULT_TARGET>`.
3. No TLS block, cert-manager annotation or Certificate: the wildcard covers `*.<DOMAIN>`.
4. `task verify:text`, then `task docs:check -- --fix` to add the host to the route inventory in
   networking.md.
