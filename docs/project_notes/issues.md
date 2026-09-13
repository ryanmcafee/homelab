# Issues/Work Log

Track work completed on the homelab project. Keep it simple - just enough to remember what was done. Full details live in GitHub Issues/PRs.

## Format

Each entry should include:
- Date (YYYY-MM-DD)
- Issue/PR reference
- Brief description (1-2 lines)
- URL to issue/PR (if available)
- Status (optional: completed, in-progress, blocked)

## Recent Work

### 2026-09-12 - PR #265: Child-chart values-homelab.yaml PII moved to the config system (#262)
- **Status**: Completed
- **Description**: Parent Applications now pass derived values (domain, hostnames, iSCSI portal, Traefik static IP, ACME e-mail, DuckDNS subdomain) to child charts via `helm.valuesObject`; ~20 child `values-homelab.yaml` files stripped to non-PII settings; bootstrap ArgoCD hostname derived from a Terraform-injected `global.domain`; level 0 inherits parent `valuesObject` per child; PII guard widened to `charts/**/values-homelab.yaml` with Helm-key shape rules; 9 `hostname-domain` exemptions removed. ADR-010.
- **URL**: https://github.com/ryanmcafee/homelab/issues/262

### 2026-09-12 - PR #264: Level-0 static verification (#261 Section A)
- **Status**: Open
- **Description**: `task verify` renders every chart for localdev + homelab.yaml.example, runs helm lint, kubeconform (vendored CRD schemas, no -skip), pluto, a GitOps graph linter, golden snapshots and conftest policies; JSON summary, < 5 s. CI workflow verify.yml, pre-commit hook, runbook, ADR-009. Follow-ups #262, #263.
- **URL**: https://github.com/ryanmcafee/homelab/pull/264

### 2025-01-27 - PR #7: Automate TrueNAS Provisioning
- **Status**: Merged
- **Description**: Automated TrueNAS provisioning workflows
- **URL**: https://github.com/ryanmcafee/homelab/pull/7

### 2025-01-27 - Fix: Remove duplicate cloudflare-api-token
- **Status**: Completed
- **Description**: Fixed duplicate OnePasswordItem in traefik addon
- **Commit**: 6f48647

### 2025-01-27 - Config: Update gitops tracking to main branch
- **Status**: Completed
- **Description**: Changed ArgoCD tracking revision back to main
- **Commit**: bcf05ad

### 2025-01-27 - Fix: ArgoCD HTTP backend scheme
- **Status**: Completed
- **Description**: Added HTTP backend scheme and disabled oauth2-proxy for debug
- **Commit**: 95da241

## Pending/In Progress

_(Add items here as work begins)_

## Tips

- Keep descriptions brief (1-2 lines max)
- Always include issue/PR URL for easy reference
- Update status if work gets blocked or resumed
- Don't duplicate issue details - link to source of truth
- Clean out very old entries periodically (3+ months)
