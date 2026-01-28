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
