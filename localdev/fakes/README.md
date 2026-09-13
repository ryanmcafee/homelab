# Localdev fakes

Cluster-side shims that let every localdev Application reach Synced/Healthy in
Kind without the services the homelab cluster has (issue #261 item 10). Applied
with `kubectl apply --server-side -f localdev/fakes/` by
`scripts/localdev-kind.ts fakes` (`task localdev:fakes`; `task localdev:kind`
runs it after Cilium is up).

## Files

| File | Provides |
|------|----------|
| `storageclasses.yaml` | `democratic-csi-{nfs,ssd,iscsi,iscsi-hdd}` StorageClasses backed by `rancher.io/local-path` |
| `secrets.yaml` | Namespaces (labels mirror `charts/applications/templates/namespaces.yaml`) and every Secret a localdev-enabled app references but nothing renders (`media/plex`) |
| `onepassworditem-crd.yaml` | The `onepassworditems.onepassword.com` CRD from the pinned connect chart, so a stray OnePasswordItem is accepted instead of breaking a sync |

Before the fakes, `up` also deletes the local-path-provisioner Kind bundles
into every cluster (Deployment, its RBAC, StorageClass `standard`) so the
`local-path-provisioner` addon Application owns it; the Deployment shares its
name but has an immutable selector, and the chart names its RBAC differently.
ConfigMap `local-path-config` and the namespace are adopted by server-side
apply. Direct-mode Tilt still installs its own provisioner.

## Why a seeded list

Platform differences are capability keys (ADR-011): localdev renders with
`SECRETS_PROVIDER=none`, so no OnePasswordItem exists and no operator runs.
The remaining gap is Secrets that homelab gets from 1Password. Seeding them by
name is the chosen shim: explicit, reviewable, and no fake operator to maintain.
TLS Secrets are never seeded; the self-signed ClusterIssuer creates them.

## Adding an entry

1. `rg -n "existingSecret|claimSecret|secretName" tests/snapshots/localdev/`
   (ignore `*-tls`) and add the Secret with a throwaway value to `secrets.yaml`.
2. If its namespace is new, add the Namespace with the chart's labels.
3. After a `charts.onepassword-connect` bump, regenerate the CRD:
   `helm show crds connect --repo https://1password.github.io/connect-helm-charts --version <v>`
   and keep the header comment.
