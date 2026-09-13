# Localdev parent values are generated from the config system (issue #263, ADR-011)

`charts/addons/values-localdev.yaml` and `charts/applications/values-localdev.yaml` are GENERATED and COMMITTED. Never
hand-edit them. Source: `configuration/environments/localdev.yaml` (values) + `configuration/templates/helm-addons.tmpl` /
`helm-apps.tmpl` (shape). Regenerate: `task config:export:localdev` (= `homelab config export --set localdev --format
helm-addons|helm-apps`). They stay ordinary Helm values files, so ArgoCD plain-Helm mode in localdev, Tilt and
`argocd app sync --local` are unchanged; localdev has no PII so committing them is fine.

- Export output paths are set-aware: `--set homelab` -> gitignored `charts/*/values-homelab.generated.yaml` (PII, rendered
  by the CMP at sync time); any other set -> committed `charts/*/values-<set>.yaml`.
- Level 0 check `render/localdev/_committed-values` re-exports both templates for localdev and fails with a unified diff
  when the committed files differ. Fix: `task config:export:localdev` and commit. The pre-commit `config-export` hook
  (`scripts/config-export-hook.ts`) also regenerates them whenever `configuration/**` changes.
- Localdev domain is `homelab.local` (from `localdev.yaml`); the old hand-written file wrongly said `homelab.test`.

Capability keys (`configuration/schema/platform.schema.yaml`; defaults = homelab, overridden in `localdev.yaml`):
- `CNI_PROVIDER` (cilium|kindnet): gates cilium + cilium-lb-ipam.
- `LOAD_BALANCER_ENABLED` (true|false): Service type LoadBalancer vs NodePort for Traefik, Plex, Mosquitto; gates Cilium
  LB-IPAM / port-forwarding annotations and unifi-port-forward.
- `EXTERNAL_DNS_ENABLED`: gates external-dns, external-dns-unifi, duckdns.
- `STORAGE_PROVIDER` (democratic-csi|local-path): gates the four democratic-csi Applications vs local-path-provisioner;
  localdev also sets `STORAGE_CLASS_NFS/ISCSI/SSD: local-path`.
- `SECRETS_PROVIDER` (onepassword|none): gates 1password-operator, tailscale-operator, renovate, Traefik OIDC
  middleware/secret volumes; `none` gives Grafana a fixed dev admin password.

Kind sizing (single replica, no autoscaling, small resources, 1d Prometheus retention, alertmanager/node-exporter off,
cloudnative-pg and argo-workflows off) is keyed on the set name inside the templates: `{{ if eq .Set "localdev" }}`. It
describes the Kind host, not a platform capability, so it is the only thing allowed to branch on `.Set`.

Adding platform-dependent behaviour: put it in the template behind a capability key (add the key to
`platform.schema.yaml`, default = homelab, override in `localdev.yaml`), regenerate, commit values + snapshots
(`task test:snapshot -- --update`). Never add a `homelab.ryanmcafee.com/policy-exempt` for `hostname-domain` citing
#263 — the 10 localdev-only exemptions were removed because the generated file derives hostnames from `DOMAIN`.
