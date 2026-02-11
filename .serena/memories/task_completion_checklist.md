# Task Completion Checklist

When completing a task, ensure:

## Before Committing
1. Run `task chart:lint` if Helm charts were modified
2. Run `task tf:fmt` if Terraform/Terragrunt files were modified
3. Run `pre-commit run --all-files` to catch formatting/validation issues
4. Run `task docs:embedme` if CLAUDE.md or AGENTS.md were modified
5. Verify YAML files pass yamllint (excluded for Helm templates)

## Code Quality
- Go code follows existing patterns in `cmd/` and `internal/`
- TypeScript scripts use Deno runtime with explicit permissions
- Helm templates follow the existing ArgoCD Application pattern
- No hardcoded secrets or credentials
- No legacy CLI tools used (grep, find, cat, ls)

## Git Commit
- Use semantic commit messages: `feat:`, `fix:`, `docs:`, `chore:`, `style:`
- Never skip pre-commit hooks (no `--no-verify`)
- Create PRs via `gh pr create`

## If Modifying Charts
- Verify both `values.yaml` and `values-homelab.yaml` are consistent
- Check sync wave ordering is correct
- Test with `task chart:template:addons` or `task chart:template:apps`

## If Modifying Terraform
- Run `task tf:plan:component COMPONENT=X` to verify
- Check rendered manifests are up to date (`task render:status`)
