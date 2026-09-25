# Tooling

Every CLI this repository needs is pinned in `mise.toml` and installed by
[mise](https://mise.jdx.dev/); `configuration/versions.yaml` is the single source of truth for
chart, image and tool versions and the only file Renovate bumps. The two must agree on `helm`
(golden snapshots are byte-exact against `tools.helm`).

```bash
curl https://mise.run | sh                       # once
eval "$(~/.local/bin/mise activate zsh)"         # add to your shell rc
task install-tools                               # mise install + the terraform plugin cache dir
task validate                                    # per-tier prerequisite table (--environment homelab for production)
```

| Command | Purpose |
|---|---|
| `mise ls` / `task mise:list` | installed tools and versions |
| `mise ls --outdated` / `task mise:outdated` | what has a newer release |
| `mise upgrade` / `task mise:upgrade` | upgrade everything pinned |
| `mise doctor` / `task mise:doctor` | diagnose PATH/shim problems |
| `go build -o bin/homelab ./cmd/homelab` | build the `homelab` CLI that `task setup`, `task validate`, `task verify` and `task config:*` call |

Gotchas that cost time before (also in `CLAUDE.md`):

- A fresh git worktree needs `mise trust && mise install` before pre-commit's `terraform_fmt` /
  `terragrunt_fmt` hooks find their binaries.
- Non-interactive shells miss the shims: prepend `$HOME/.local/share/mise/shims` to `PATH`.
- `go run ./cmd/homelab` collapses child exit codes to 1; use the built binary to check exit codes.
- A stale `OP_SERVICE_ACCOUNT_TOKEN` shadows an interactive `op signin` and makes `op run` hang
  silently; unset it if `op whoami` hangs.

The `homelab` CLI (`cmd/homelab`) groups the commands the Taskfile wraps:

```text
homelab bootstrap        tier-aware setup: Kind loop by default, production with --environment homelab
homelab validate         prerequisite table for the chosen tier
homelab verify all       level 0 (static), 1 (+ Kind dry run), 2 (+ ArgoCD health and chainsaw e2e)
homelab config ...       validate | eval | export | guard   (configuration/ pipeline and PII guard)
homelab sops ...         bootstrap | setup
homelab talos recreate   recreate a Talos node from its image
homelab scaffold app     new application from a pattern (operator | helm | deps-main-config)
```

Every command accepts `--help`; the ones that change something accept `--dry-run`.

<!-- MCAA-139 gate evidence: a single HTML comment; no command, pin or documented step changed. -->
