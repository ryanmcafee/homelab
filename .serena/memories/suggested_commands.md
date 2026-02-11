# Suggested Commands

## Task Runner (Taskfile)

### Setup
- `task setup` - Full homelab setup (validates prereqs, runs bootstrap)
- `task validate` - Validate prerequisites are installed
- `task install-tools` - Install required CLI tools via mise

### Local Development
- `task localdev:up` - Start Kind + Tilt local development
- `task localdev:down` - Destroy local environment

### Helm Charts
- `task chart:lint` - Lint all Helm charts
- `task chart:template:addons` - Debug addons rendering
- `task chart:template:applications` - Debug applications rendering

### Terraform/Terragrunt
- `task tf:apply:component COMPONENT=X` - Apply single Terraform component
- `task tf:plan` - Plan Terraform changes (auto-syncs rendered files)

### Rendered Manifests (Cilium, CSR approver, Spegel)
- `task render` - Render inline manifests
- `task render:push` - Upload rendered files to 1Password
- `task render:pull` - Download rendered files from 1Password
- `task render:status` - Check status of rendered files
- `task render:sync` - Sync files between local and 1Password

### Talos
- `task talos:recreate:node NODE=X` - Recreate Talos node

### GPU
- `task gpu:verify` - Verify GPU support

### SOPS
- `task sops:setup` - Full SOPS setup

### Documentation
- `task docs:embedme` - Update embedded code snippets in CLAUDE.md

## Pre-commit Hooks
- `pre-commit install` - Install hooks
- `pre-commit run --all-files` - Run all hooks manually

Hooks include: helm-lint, helm-template, kubeconform, yamllint, terraform_fmt, terragrunt_fmt, trailing-whitespace, end-of-file-fixer

## Go CLI
- `go build -o bin/homelab ./cmd/homelab` - Build CLI
- `./bin/homelab bootstrap` - Bootstrap homelab
- `./bin/homelab validate` - Validate prerequisites

## TypeScript Scripts (Deno)
All scripts in `scripts/` use Deno with explicit permissions:
```
deno run --allow-net --allow-run --allow-env --allow-read scripts/<script>.ts
```

## CLI Tool Preferences (macOS/Darwin)
- Use `rg` (ripgrep) instead of grep
- Use `fd` instead of find
- Use `bat` instead of cat
- Use `eza` instead of ls
- Use `jq` for JSON processing
- Use `yq` for YAML processing
