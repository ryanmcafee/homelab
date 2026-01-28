# Bug Log

Track bugs encountered during homelab infrastructure development along with their solutions. This helps avoid solving the same problems twice and preserves institutional knowledge.

## Format

Each entry should include:
- Date (YYYY-MM-DD)
- Brief description of the bug/issue
- Solution or fix applied
- Any prevention notes (optional)

## Entries

### 2025-01-27 - Duplicate cloudflare-api-token OnePasswordItem in traefik
- **Issue**: Traefik addon had duplicate OnePasswordItem definition for cloudflare-api-token
- **Root Cause**: Copy-paste error when adding external-dns alongside traefik
- **Solution**: Removed duplicate OnePasswordItem from traefik template
- **Prevention**: Review templates for duplicate resource definitions before committing

### Known Common Errors (from CLAUDE.md)

These are documented errors with known solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| "OnePasswordItem not found" | 1Password Operator not ready | Check sync wave ordering (wave -2 for SOPS secrets, wave 0 for 1Password Operator) |
| "Unable to find valid certification path" | TrueNAS TLS not trusted | Democratic-CSI uses allowInsecure |
| "dry run failed" | Server-side apply conflicts | Add ServerSideApply=true to syncOptions |
| Ingress "Progressing" forever | No LoadBalancer IP | Custom health check marks Ingress Healthy |

## Tips

- Keep descriptions under 2-3 lines
- Focus on the lesson learned, not just the fix
- Include enough context for future reference
- Clean out very old entries periodically (6+ months)
