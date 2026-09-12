# Policy-as-code (conftest / Rego)

Rego policies enforced over every rendered ArgoCD Application, workload, Secret,
and hostname object in the GitOps repo. Evaluated by `internal/verify.Policy`
(level 0, `policy/<env>` checks) and by this directory's own test suite.

## Layout

| Path | Purpose |
|------|---------|
| `lib.rego` | Shared helpers: `data.domain`, exemption annotations, object id. |
| `application.rego` | `app-finalizer`, `app-sync-wave`, `app-ssa`, `app-automated`. |
| `workload.rego` | `image-latest`, `container-resources`. |
| `secret.rego` | `inline-secret`. |
| `hostname.rego` | `hostname-domain`. |
| `*_test.rego` | Rego unit tests (`conftest verify -p tests/policy`). |
| `negative/<rule-id>.yaml` | One fixture per rule that must trigger it (`# expect: <rule-id>` header). |
| `positive/*.yaml` | Fixtures that must produce zero failures. |

## Rules

| Rule id | Applies to | Requires |
|---------|-----------|----------|
| `app-finalizer` | `Application` | `metadata.finalizers` contains `resources-finalizer.argocd.argoproj.io`. |
| `app-sync-wave` | `Application` | `argocd.argoproj.io/sync-wave` annotation, numeric. |
| `app-ssa` | `Application` | `spec.syncPolicy.syncOptions` contains `ServerSideApply=true`. |
| `app-automated` | `Application` | `spec.syncPolicy.automated.prune == true` and `.selfHeal == true`. |
| `image-latest` | `Deployment`/`StatefulSet`/`DaemonSet`/`Job`/`CronJob`/`Pod` containers, and `image.tag` parsed out of an `Application`'s inline `spec.source.helm.values` | No container image ending in `:latest` or without a tag. |
| `container-resources` | same workload kinds | Every container sets `resources.requests`/`resources.limits` for both `cpu` and `memory`. |
| `inline-secret` | `Secret` | `data`/`stringData` keys are a subset of `name, url, type, enableOCI, project, insecure` (the ArgoCD repository-secret shape). Anything else is treated as inline secret material that should live in 1Password/SOPS instead. |
| `hostname-domain` | `Ingress` hosts, Traefik `IngressRoute` `Host()` matches, cert-manager `Certificate` `dnsNames`, external-dns `DNSEndpoint` `dnsName` | Ends with `.` + `data.domain` (the environment's base domain). |

Deny messages are formatted `[<rule-id>] <Kind>/<namespace>/<name>: <why>`.

## Exemptions

An object can be exempted from specific rules with a paired annotation:

```yaml
metadata:
  annotations:
    homelab.ryanmcafee.com/policy-exempt: "app-automated"
    homelab.ryanmcafee.com/policy-exempt-reason: "Cilium CNI is installed by Talos inline manifests; this Application is visibility-only."
```

Multiple rule ids are comma-separated. An exempt annotation without a reason
grants **no** exemption — `lib.exempt_rules` requires both.

Current exemptions in the rendered repo:

- `charts/addons/templates/cilium.yaml` — Cilium's visibility-only Application
  is exempt from `app-automated` (Talos manages the CNI directly; ArgoCD must
  not prune or self-heal it).
- `charts/applications/templates/plex.yaml` — Plex is exempt from
  `image-latest` (upstream `plexinc/pms-docker` publishes no numbered image
  tags; `:latest` tracking is the documented, intentional deployment model).
- `charts/applications/templates/homeassistant.yaml` — Home Assistant is
  exempt from `image-latest` (the `lscr.io/linuxserver/homeassistant` image is
  intentionally tracked at `:latest` for automatic updates in this homelab).

## Running

```bash
# Rego unit tests
conftest verify -p tests/policy

# Fixture suite (negative + positive), with a results table
deno run --allow-read --allow-run --allow-env scripts/policy-test.ts

# Ad-hoc, against one rendered file
conftest test -p tests/policy --data tests/policy/negative/_data.yaml -o json <file.yaml>
```

`--data` accepts a single file; conftest flattens its top-level keys directly
under `data` (a file named `_data.yaml` containing `domain: example.com`
exposes `data.domain`, not `data._data.domain`). `conftest test` only
evaluates the `main` namespace unless `--all-namespaces` is passed; both the
fixture runner and `internal/verify.Policy` always pass it.
