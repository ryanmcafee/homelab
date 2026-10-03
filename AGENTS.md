# AGENTS.md - Sub-Agent Coordination Rules

Use 'bd' for task tracking on long-running tasks.

## Before you decide a tool is missing

If `bun`, `go`, `task`, `helm` or `mise` itself is "not found", **everything `mise.toml` pins is
already installed** — the shims are just not on `PATH`, and this repo's `mise.toml` is untrusted in
a fresh clone. Never download a toolchain by hand. Two exports fix both:

```bash
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
export MISE_TRUSTED_CONFIG_PATHS="$PWD"   # the repo root, if you are not in it
```

mise reports the trust problem as `error parsing config file: .../mise.toml`, which is not what is
wrong. Details, the verified versions and the nested-shell caveat: `Claude.md` →
"If your toolchain looks missing, it isn't".

## Core Rules
1. Always analyze plans for parallel execution opportunities before implementing
2. Fix pre-existing bugs encountered during task execution
3. Use sub-agents for multi-file analysis, version audits, and troubleshooting
4. Reference CLAUDE.local.md for environment-specific IP addresses and hostnames, and `docs/project_notes/key_facts.md` for project constants
5. Check `mcp__serena__list_memories` at session start; call `write_memory` after any non-trivial discovery
6. Use Serena MCP tools proactively - search_for_pattern, memories, think tools

## Serena Tool Guidelines

**All agents** should:
- Check `list_memories` at session start for relevant context
- Use `search_for_pattern` for complex regex across config files
- Call `think_about_collected_information` after multi-file exploration
- Call `think_about_task_adherence` before making code changes
- Call `think_about_whether_you_are_done` before completing tasks
- Use `write_memory` to persist useful discoveries for future sessions

**Agents working on Go or TypeScript** should also:
- Use `get_symbols_overview` before reading unfamiliar Go/TS files
- Use `find_symbol` to locate functions by name
- Use `find_referencing_symbols` to trace usage across codebase

## Sub-Agent Task Patterns

### For Helm Version Audits (3 agents)
- Agent 1: Fetch infrastructure chart versions from GitHub (ArgoCD, Cilium, cert-manager, etc.)
- Agent 2: Fetch application chart versions from GitHub (Plex, Sonarr, Radarr, etc.)
- Agent 3: Compare with current values.yaml versions and identify outdated

### For ArgoCD Troubleshooting (4 agents)
- Agent 1: Check application sync status and health
- Agent 2: Analyze controller and repo-server logs
- Agent 3: Review Helm template for the failing application
- Agent 4: Search Git history for related changes

### For Feature Implementation (5 agents)
- Agent 1: Analyze existing similar implementations
- Agent 2: Check test patterns and coverage
- Agent 3: Review related configuration files
- Agent 4: Identify integration points
- Agent 5: Search for documentation and comments

## Parallel Opportunities by Task Type

| Task | Agents | Focus Areas |
|------|--------|-------------|
| Version audit | 3 | Infra/Apps/Compare |
| New application | 4 | Similar/Patterns/Tests/Docs |
| Bug investigation | 5 | Logs/Code/History/Config/Related |
| Security audit | 4 | Secrets/RBAC/Network/Images |
| Infrastructure change | 4 | Terraform/Helm/Talos/ArgoCD |

## Proactive Skill Invocation

### gitops-test Skill (MANDATORY)

The `/gitops-test` skill MUST be invoked automatically in these scenarios:

| Trigger Condition | Action |
|-------------------|--------|
| Edit/Write/MultiEdit of `charts/**` or `configuration/**` | Automatic: the PostToolUse hook (`.claude/settings.json` → `scripts/claude-verify-hook.ts`) runs level 0 and returns failures as feedback; fix every finding before the next step |
| Modified `tests/**`, `localdev/**`, `internal/verify/**` (not watched by the hook) | Run `task verify:text` (level 0); fix every finding |
| ArgoCD sync failure or unhealthy Application on Kind | `task localdev:diagnose`, fix, `task localdev:sync -- --only <app>`, `task verify:text LEVEL=2` |
| ArgoCD or production question | Read-only only: `task verify:prod`, `task prod:status`, `task prod:diff -- <app>` (`docs/runbooks/readonly-access.md`) |
| After pushing | `gh pr checks --watch`: `verify.yml` (level 0), `pr-contract.yml` (level 0 on the PR head), `tilt-ci.yml` (Kind level 2 + report), `upgrade.yml` (version bumps) |

**Do NOT wait for explicit `/gitops-test` command** - invoke proactively when conditions match.

### Validation Flow After Chart Changes

```
1. Edit charts/** or configuration/**: the PostToolUse hook runs level 0 after every edit
   (silent on pass; failures come back as feedback). Edits to tests/**, localdev/** or
   internal/verify/** are not watched: run `task verify:text` yourself.
   HOMELAB_VERIFY_HOOK=off only for a long mechanical edit series, then `task verify:text`.
2. If the render changed on purpose: review the diff, `task test:snapshot -- --update`
3. Level 1 on Kind: `task localdev:kind && task verify:text LEVEL=1`
   (server-side dry run of every localdev chart: dryrun/localdev/<chart>)
4. Level 2 on Kind: `task localdev:up && task verify:text LEVEL=2`
   (every Application Healthy + Succeeded, chainsaw e2e: argocd/<app>, e2e/<test>);
   `task localdev:diagnose` on failure, `task localdev:sync -- --only <app>` to re-sync one,
   `task localdev:report -- --base main` for this branch vs main (Applications track the PR head)
5. Commit (the pre-commit hook re-runs level 0)
6. Push to a feature branch, create the PR, `gh pr checks --watch`:
   verify.yml (level 0), pr-contract.yml (re-runs level 0 on the PR head; no block in the body),
   tilt-ci.yml kind-argocd (level 2 + sticky Kind report), upgrade.yml for version bumps.
7. Optional preview on the homelab cluster: ask the maintainer to add the `preview` and
   `preview:<app>` labels (docs/runbooks/previews.md)
8. After merge, observe production read-only: `task verify:prod`, `task prod:status`,
   `task prod:diff -- <app>`. Never apply to, patch, sync or repoint production
```

Agents may mutate only Kind clusters (ADR-009). Production is verified through merge -> ArgoCD -> CI/notifications, and read through the `homelab-readonly` context only.
