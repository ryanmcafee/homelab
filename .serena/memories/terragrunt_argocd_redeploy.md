# Redeploying ArgoCD via Terragrunt

## Command
```bash
cd terragrunt/environments/homelab/gitops-bootstrap && terragrunt apply --non-interactive -auto-approve
```

## Details
- **Module path**: `terragrunt/environments/homelab/gitops-bootstrap`
- **Terraform module**: `terragrunt/modules/gitops-bootstrap`
- **Dependencies**: `talos-cluster-config` (for kubeconfig/certs), `truenas`
- **Timeout**: Allow up to 10 minutes (600s) — Helm install can be slow

## Key Outputs
- `argocd_server_url` — e.g. `https://argocd.ryanmcafee.com`
- `argocd_admin_password` — sensitive
- `bootstrap_app_name` — `gitops` (App-of-Apps root)
- `argocd_namespace` — `argocd`

## Notes
- The SOPS age key is fetched live from 1Password via `op read`
- CMP image version is read from `configuration/versions.yaml`
- ArgoCD version is pinned in the terragrunt.hcl `inputs` block (`argocd_version`)
- If no changes are detected, Terraform reports "No changes" — use `terraform taint` on the `helm_release.argocd` resource to force a full redeploy if needed
- For a quick task-based approach: `task tf:apply:component COMPONENT=gitops-bootstrap`
