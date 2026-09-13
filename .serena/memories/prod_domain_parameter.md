# Production base domain reaches ArgoCD only through Terraform

The homelab base domain never lives in git. `terragrunt/modules/gitops-bootstrap`
(`templates/bootstrap-app.yaml.tpl`) injects it into the root `gitops` Application as
`spec.source.helm.parameters[global.domain]`; `charts/gitops/templates/bootstrap.yaml`
derives the ArgoCD ingress hostname / external-dns annotation / extraTls /
`notifications.argocdUrl` from it and hands them to `bootstrap` via `helm.valuesObject`
(bootstrap installs the CMP, so it cannot render through it). Level 0 mirrors the
parameter with `--set global.domain=<DOMAIN>` (`internal/verify/render.go`).

Gotcha (2026-09-13, PR #274): editing the module does nothing until a human runs
`task tf:apply:component COMPONENT=gitops-bootstrap`. Without the parameter the
committed placeholder `example.com` wins and ArgoCD self-heals its own Ingress to
`argocd.example.com`. `homelab verify prod` check `prod/argocd/domain`
(`internal/verify/prod.go`, `prodDomainCheck`) reads the same Applications list and
fails when the parameter is missing / the placeholder, or when any Application's
`helm.values`, `helm.valuesObject` or `helm.parameters` contains `example.com`.
Agents never apply Terraform against homelab; report and hand the command to the human.
