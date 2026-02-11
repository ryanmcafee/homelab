# Code Style and Conventions

## Go Code
- Module: `github.com/ryanmcafee/homelab`
- Go version: 1.19
- CLI framework: Cobra (`spf13/cobra`)
- Package structure: `cmd/homelab/commands/` for CLI commands, `internal/` for shared packages
- Internal packages: `logger`, `config`, `template`, `utils`
- Utils pattern: `ExecCommand()` returns `CommandResult{Stdout, Stderr, Success, Code}`
- Color output: `fatih/color` for terminal colors
- Build: binary output to `./bin/homelab`

## TypeScript/Deno Scripts
- Runtime: Deno (NOT Node.js)
- Shebang: `#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env --allow-read`
- Always include `--help` flag and `--dry-run` option
- Log with colors: cyan=INFO, green=OK, red=ERROR
- Location: `scripts/` directory

## Helm Charts
- Standard ArgoCD Application template pattern used across all charts
- Helper templates in `_helpers.tpl`
- Values split: `values.yaml` (base) + `values-{env}.yaml` (environment overrides)
- Environments: `localdev`, `homelab`

## Terraform/Terragrunt
- Modules in `terragrunt/modules/`
- Environment configs in `terragrunt/environments/{env}/`
- DRY config via `terragrunt/environments/_env/`
- Secrets injected via `op run --env-file=.env.op`

## Git
- Semantic commit messages: `feat:`, `fix:`, `docs:`, `chore:`, `style:`
- Pre-commit hooks: helm lint, helm template, kubeconform, yamllint, terraform_fmt, trailing-whitespace, detect-private-key
- No legacy tools: never use grep, find, cat, ls

## General
- Taskfile for all task running (not Makefile)
- mise for tool version management
- 1Password for secrets (never hardcode)
- SOPS+age for encrypted secrets in git
