# Code Style and Conventions

## General
- Semantic commit messages: `feat:`, `fix:`, `docs:`, `chore:`, `style:`, `refactor:`, `test:`
- Run pre-commit hooks before committing
- Format code before committing
- Never commit secrets (.env, credentials, API keys)

## Go
- Go 1.19 with cobra CLI framework
- Table-driven tests standard
- Target 95%+ test coverage
- Integration testing with Pact and TestContainers

## TypeScript
- Deno runtime only (no Node.js)
- Always include `--help` flag in scripts
- Use `--dry-run` for non-destructive preview
- Log with colors: cyan=INFO, green=OK, red=ERROR
- Exit 0 on success, 1 on failure
- Vitest testing framework
- No Bash or Python scripting allowed

## Helm Charts
- ArgoCD sync wave ordering is critical (Wave -2 to Wave 7+)
- Use ServerSideApply for sync conflicts
- Custom health checks for Ingress resources

## Terraform/Terragrunt
- Modules in `terragrunt/modules/`
- Environments in `terragrunt/environments/` (homelab, localdev)
- DRY configurations with Terragrunt

## YAML
- yamllint enforced (excluding chart templates)
- check-yaml with `--allow-multiple-documents`

## Documentation
- README files: Maximum 50 lines
- No excessive emojis
- Essential sections only: Purpose, Quick Start, Key Commands
