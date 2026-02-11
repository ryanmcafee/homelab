# Task Completion Checklist

When completing a task, verify the following:

## Before Committing
1. Run `pre-commit run --all-files` to validate all hooks pass
2. For chart changes: `task chart:lint` and `task chart:template:addons` / `task chart:template:applications`
3. For Terraform changes: `terraform fmt` and `terragrunt fmt`
4. For Go changes: `go vet ./...` and `go test ./...`
5. Ensure no secrets are staged for commit

## Commit
- Use semantic commit messages: `feat:`, `fix:`, `docs:`, `chore:`, etc.
- Keep commit messages concise and focused on "why"

## After Chart Changes
- Invoke `/gitops-test` skill for validation (Tier 1-4)
- Verify ArgoCD sync wave ordering is correct
- Check for sync option requirements (ServerSideApply, etc.)

## After Terraform Changes
- Run `task render` if Cilium/CSR approver/Spegel configs changed
- Run `task render:push` to upload to 1Password
- Run `task tf:plan` to preview changes

## Documentation
- Run `task docs:embedme` if CLAUDE.md was modified
- Update `docs/project_notes/issues.md` for significant work
- Update `docs/project_notes/bugs.md` if a bug was fixed
- Update `docs/project_notes/decisions.md` for architectural decisions
