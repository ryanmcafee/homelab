# Child chart values come from the parent Application (issue #262)

Child `charts/*-config`, `*-dependencies`, `cert-manager-cluster-issuer`, `duckdns`, `bootstrap` render through plain
`helm.valueFiles` (values.yaml + values-<env>.yaml), never the CMP. Their committed `values-homelab.yaml` MUST be PII-free.

Anything derived from `configuration/` (DOMAIN, *_HOSTNAME, ISCSI_TARGET_PORTAL, TRAEFIK_STATIC_IP, ACME_EMAIL,
DUCKDNS_SUBDOMAIN, TRAEFIK_OIDC_ALLOWED_DOMAINS) reaches a child through the parent Application's
`spec.source.helm.valuesObject`, built from the parent's `.Values` (CMP-generated in homelab via
`configuration/templates/helm-addons.tmpl` / `helm-apps.tmpl`; `values-localdev.yaml` in localdev). ArgoCD precedence:
valueFiles < valuesObject.

- iSCSI charts: child `values.yaml` has `iscsi.portal: ""`; `templates/persistent-volume.yaml` merges it into each
  volume's `csi.volumeAttributes.portal`; parent passes `valuesObject.iscsi.portal` from `global.iscsi.portal`.
- traefik-*-config: parent `traefikExternal.config` / `traefikInternal.config` blocks are the child's values.
- cert-manager-cluster-issuer: from parent `cert-manager.letsencrypt/cloudflare/dnsZones`.
- argo-workflows-config: from parent `argo-workflows.ingressVerification`.
- bootstrap (installs the CMP, so cannot use it): `charts/gitops/templates/bootstrap.yaml` derives
  `argocd.<global.domain>`; Terraform root Application injects `global.domain` as `helm.parameters`
  (`terragrunt/modules/gitops-bootstrap/templates/bootstrap-app.yaml.tpl`).

Level 0 (`internal/verify/render.go`) mirrors this: renders gitops → other parents → children in waves, extracts each
child's `valuesObject` from the rendered parent Application into `<out>/<env>/_inherited/<chart>.yaml` and passes it as
the last `-f`; `gitops` in homelab gets `--set global.domain=<DOMAIN>`. Check name: `render/<env>/_inherit`.

PII guard scope: `configuration/**` + `charts/**/values-homelab.yaml`; shape detection also understands Helm-style keys
(host, hostname, portal, staticIP, email, domain, list items under dnsZones/allowedDomains/hosts).

Adding a new child chart: put derived values in the parent's export template + base values, pass them via `valuesObject`
in the parent template, keep the child's `values-homelab.yaml` PII-free. Never add a `homelab.ryanmcafee.com/policy-exempt`
for hostname-domain citing #262 — the mechanism above is the fix.
