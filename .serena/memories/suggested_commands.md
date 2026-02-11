# Suggested Commands

## Task Runner (Taskfile)
All commands use `task` as the runner.

### Development
- `task localdev:up` - Start Kind + Tilt local development
- `task localdev:down` - Destroy local environment
- `task localdev:reset` - Full teardown + recreate

### Helm Charts
- `task chart:lint` - Lint all Helm charts
- `task chart:template:addons` - Template addons chart (debug)
- `task chart:template:apps` - Template applications chart (debug)

### Terraform/Terragrunt
- `task tf:plan` - Plan all components (homelab env)
- `task tf:plan:component COMPONENT=X` - Plan single component
- `task tf:apply` - Apply all components
- `task tf:apply:component COMPONENT=X` - Apply single component
- `task tf:fmt` - Format HCL files

### Rendered Manifests
- `task render` - Render Cilium, CSR approver, Spegel to YAML
- `task render:push` - Upload to 1Password
- `task render:pull` - Download from 1Password
- `task render:status` - Check local vs 1Password status

### Talos Cluster
- `task talos:recreate:node NODE=X` - Recreate a Talos node
- `task talos:recreate:gpu-node` - Recreate GPU worker + verify
- `task gpu:verify` - Verify GPU support

### SOPS Secrets
- `task sops:setup` - Full SOPS setup (pull from 1Password, encrypt, commit)
- `task sops:verify` - Verify SOPS decryption works
- `task sops:decrypt` - View decrypted secrets

### CI / Linting
- `task ci:lint` - Run all linters (ansible, helm, yamllint)
- `task ci:test` - Full CI test suite
- `pre-commit run --all-files` - Run pre-commit hooks

### Validation
- `task validate` - Validate all prerequisites installed
- `task install-tools` - Install CLI tools via mise

### Documentation
- `task docs:embedme` - Update embedded code snippets in markdown

### Go CLI
- `./bin/homelab bootstrap` - Bootstrap setup
- `./bin/homelab render push/pull/status/sync` - Rendered manifest management
- `./bin/homelab sops bootstrap/setup` - SOPS key management
- `./bin/homelab talos recreate --node=X` - Node recreation
- `./bin/homelab verify gpu` - GPU verification
- `./bin/homelab validate` - Prerequisites validation

## System Utilities (Darwin/macOS)
- `rg` (ripgrep) for searching, NOT grep
- `fd` for finding files, NOT find
- `bat` for viewing files, NOT cat
- `eza` for listing files, NOT ls
- `jq` / `yq` for JSON/YAML processing
- `gh` for GitHub CLI operations
