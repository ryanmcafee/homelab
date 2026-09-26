# Policy-as-code (conftest / Rego)

Rego policies enforced over every rendered ArgoCD Application, workload, Secret,
route and hostname object in the GitOps repo. Evaluated by `internal/verify.Policy`
(level 0, `policy/<env>` checks) and by this directory's own test suite.

## Layout

| Path | Purpose |
|------|---------|
| `lib.rego` | Shared helpers: `data.domain`, the `data.gateway_*` names, inline Application values, exemption annotations, object id. |
| `application.rego` | `app-finalizer`, `app-sync-wave`, `app-ssa`, `app-automated`. |
| `applicationset.rego` | `appset-finalizer`, `appset-ssa`, `appset-project`, `appset-automated` (the `spec.template` of an `ApplicationSet`). |
| `workload.rego` | `image-latest`, `container-resources`, `cronjob-ttl`. |
| `httproute.rego` | `httproute-parent`, `httproute-target`, `no-ingress`. |
| `secret.rego` | `inline-secret`. |
| `hostname.rego` | `hostname-domain`, plus the domain-missing safety net. |
| `*_test.rego` | Rego unit tests (`conftest verify -p tests/policy`). |
| `negative/<rule-id>.yaml` | One fixture per rule that must trigger it (`# expect: <rule-id>` header). |
| `positive/*.yaml` | Fixtures that must produce zero failures. |

## Rules

| Rule id | Applies to | Requires |
|---------|-----------|----------|
| `app-finalizer` | `Application` | `metadata.finalizers` contains `resources-finalizer.argocd.argoproj.io`. |
| `app-sync-wave` | `Application` | `argocd.argoproj.io/sync-wave` annotation, numeric. Note: Kubernetes annotation values are always strings — a rendered manifest with an unquoted numeric sync-wave (`sync-wave: 2` instead of `sync-wave: "2"`) is itself malformed, but if it reaches the policy anyway the rule still fails it (`object.get` only matches a *string* annotation value; a bare YAML integer doesn't satisfy `regex.match` and the rule fires). |
| `app-ssa` | `Application` | `spec.syncPolicy.syncOptions` contains `ServerSideApply=true`. |
| `app-automated` | `Application` | `spec.syncPolicy.automated.prune == true` and `.selfHeal == true`. |
| `appset-finalizer` | `ApplicationSet` | `spec.template.metadata.finalizers` contains `resources-finalizer.argocd.argoproj.io`, so deleting a generated Application (e.g. a closed PR's preview) cascades. |
| `appset-ssa` | `ApplicationSet` | `spec.template.spec.syncPolicy.syncOptions` contains `ServerSideApply=true`. |
| `appset-project` | `ApplicationSet` | `spec.template.spec.project` is set and is not `default` (an externally fed generator must land in a restricted AppProject). |
| `appset-automated` | `ApplicationSet` | `spec.template.spec.syncPolicy.automated.prune == true` and `.selfHeal == true`; off when `argocd_automated_sync: false`, like `app-automated`. |
| `image-latest` | `Deployment`/`StatefulSet`/`DaemonSet`/`Job`/`CronJob`/`Pod` containers, and `image.tag` parsed out of an `Application`'s inline `spec.source.helm.values` | No container image ending in `:latest` or without a tag. A tag is only recognized in the *last* `/`-separated path segment (`registry.local:5000/app` is untagged; `registry.local:5000/app:1.2.3` is pinned), or a `@digest` reference anywhere in the string. |
| `container-resources` | same workload kinds | Every container sets `resources.requests`/`resources.limits` for both `cpu` and `memory`. |
| `cronjob-ttl` | `CronJob` | `spec.jobTemplate.spec.ttlSecondsAfterFinished` is a number. `KubeJobFailed` fires for as long as a failed Job object exists, and `failedJobsHistoryLimit` only trims a failed Job when a newer failure replaces it, so without a TTL one transient failure alerts forever. |
| `httproute-parent` | `HTTPRoute` `parentRefs`, and any `parentRefs` list in an `Application`'s inline helm values | Every parent is the `https` listener (`sectionName: https`) of `data.gateway_internal` or `data.gateway_external` in `data.gateway_namespace` (written into `_data.yaml` from `GATEWAY_*`). The `http` listener only redirects, so it accepts only redirect routes (no `backendRefs`). The Istio comparison gateways (`istio-internal`/`istio-external` in `istio-ingress`) accept only the route `echo`. Inline `parentRefs` must name their namespace. |
| `httproute-target` | `HTTPRoute` annotations, and `annotations` under an `httpRoute`/`gatewayApi` key in an `Application`'s inline helm values | No `external-dns.alpha.kubernetes.io/target`. The `gateway-httproute` source ignores it on a route and takes targets from the Gateway (`dnsTarget` in `charts/envoy-gateway-config`). |
| `no-ingress` | `networking.k8s.io` `Ingress`, and any `ingress...enabled: true` in an `Application`'s inline helm values (outside a `networkPolicy` key) | Absent. Envoy Gateway does not implement Ingress, so an Ingress applies cleanly and is never served; use an HTTPRoute (the chart's native route support). |
| `inline-secret` | `Secret` | `data`/`stringData` keys are a subset of `name, url, type, enableOCI, project, insecure` (the ArgoCD repository-secret shape). Anything else is treated as inline secret material that should live in 1Password/SOPS instead. |
| `hostname-domain` | `HTTPRoute` `hostnames`, `Gateway` listener `hostname`, cert-manager `Certificate` `dnsNames`, external-dns `DNSEndpoint` `dnsName`, **and** any hostname embedded in an `Application`'s inline `spec.source.helm.values`/`valuesObject` (a value under a `host`/`hostname`/`hosts[]`/`hostnames[]`/`dnsNames[]`/`commonName`/`externalHostname` key, or the host of an http(s) `url`, anywhere in the parsed tree) | Is `data.domain` itself or ends with `.` + `data.domain` (the environment's base domain). |

Deny messages are formatted `[<rule-id>] <Kind>/<namespace>/<name>: <why>`.

### `hostname-domain` fails safe when `data.domain` is missing

Every `hostname-domain` check is built from `domain_suffix := sprintf(".%s",
[lib.domain])`. If `data.domain` is absent (or blank, or `null`),
`lib.domain`/`domain_suffix` are undefined, which would otherwise make the
whole rule body undefined and let conftest silently report zero failures —
a fail-open bug. Two layers guard against it:

1. `internal/verify.Policy` reads `<renderDir>/<env>/_data.yaml` itself
   before invoking conftest and returns a failing `policy/<env>` check
   (`policy data missing domain`) without running conftest at all if
   `domain` is missing or empty.
2. `hostname.rego` carries its own `domain_missing` rule: for the four
   directly-checked kinds (`HTTPRoute`, `Gateway`, `Certificate`,
   `DNSEndpoint`) it denies once per matching document with
   `[hostname-domain] policy data missing domain` if `data.domain` is
   undefined, empty, or `null`. This is defense in depth for anyone running
   `conftest test` directly, bypassing layer 1.

## Exemptions

An object can be exempted from specific rules with a paired annotation:

```yaml
metadata:
  annotations:
    homelab.local/policy-exempt: "app-automated"
    homelab.local/policy-exempt-reason: "Cilium CNI is installed by Talos inline manifests; this Application is visibility-only."
```

Multiple rule ids are comma-separated. An exempt annotation without a reason
grants **no** exemption — `lib.exempt_rules` requires both (see
`tests/policy/negative/exempt-missing-reason.yaml`, which proves this: the
object carries `policy-exempt: app-finalizer` with no reason, and still
fails `app-finalizer`).

Current exemptions in the rendered repo:

- `charts/addons/templates/cilium.yaml` — Cilium's visibility-only Application
  is exempt from `app-automated` (Talos manages the CNI directly; ArgoCD must
  not prune or self-heal it) and from `app-finalizer` (deleting this
  Application must never cascade-delete the CNI Talos installed and manages).
  Unconditional (both envs).
- `charts/applications/templates/plex.yaml` — Plex is exempt from
  `image-latest` (upstream `plexinc/pms-docker` publishes no numbered image
  tags; `:latest` tracking is the documented, intentional deployment model).
  Unconditional (both envs).
- `charts/applications/templates/homeassistant.yaml` — Home Assistant is
  exempt from `image-latest` (the `lscr.io/linuxserver/homeassistant` image is
  intentionally tracked at `:latest` for automatic updates in this homelab).
  Unconditional (both envs); currently moot since `home-assistant.enabled` is
  `false` by default.

There is no per-environment `hostname-domain` exemption: localdev renders
`addons`/`applications` from the config-generated, committed
`charts/*/values-localdev.yaml` (`task config:export:localdev`, issue #263), so
its route hostnames derive from `DOMAIN` exactly as homelab's do.

## Running

```bash
# Rego unit tests
conftest verify -p tests/policy

# Fixture suite (negative + positive), with a results table
bun scripts/policy-test.ts

# Ad-hoc, against one rendered file — --all-namespaces is required (see below)
conftest test -p tests/policy --all-namespaces --data tests/policy/negative/_data.yaml -o json <file.yaml>
```

`--data` accepts a single file; conftest flattens its top-level keys directly
under `data` (a file named `_data.yaml` containing `domain: example.com`
exposes `data.domain`, not `data._data.domain`). `conftest test` only
evaluates the `main` namespace unless `--all-namespaces` is passed — every
rule here lives under `package homelab.<area>`, so omitting the flag makes
conftest silently report zero failures for everything; the fixture runner
and `internal/verify.Policy` always pass it.

`conftest test -o json` can also report Rego `warn` rules (distinct from
`deny`/failures) under a `warnings` key; `internal/verify.Policy` surfaces
these as findings prefixed `warn:` without failing the check.
