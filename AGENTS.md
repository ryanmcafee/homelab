# AGENTS.md - Sub-Agent Coordination Rules

Use 'bd' for task tracking on long-running tasks.

## Core Rules
1. Always analyze plans for parallel execution opportunities before implementing
2. Fix pre-existing bugs encountered during task execution
3. Use sub-agents for multi-file analysis, version audits, and troubleshooting
4. Reference CLAUDE.local.md for environment-specific IP addresses and hostnames
5. Check and update project memory files in `docs/project_notes/`

## Project Memory System

Memory files in `docs/project_notes/`:
- **bugs.md** - Bug log with solutions
- **decisions.md** - Architectural Decision Records (ADRs)
- **key_facts.md** - Project configuration and constants
- **issues.md** - Work log with PR/issue references

### Memory Protocols for Sub-Agents

**Before proposing changes:**
- Check `decisions.md` for existing architectural decisions
- Reference past decisions when making recommendations

**When debugging:**
- Search `bugs.md` for similar issues before investigating
- Add new bugs with solutions after resolution

**When looking up configuration:**
- Check `key_facts.md` for project constants
- Reference `CLAUDE.local.md` for environment-specific values

**After completing work:**
- Log significant work in `issues.md` with PR/commit references

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
| Modified `charts/**/*` | Run Tier 1-2 validation before commit |
| ArgoCD accessibility issue | Use tiered debugging approach |
| ArgoCD sync failures | Validate templates and dry-run |
| After committing GitOps changes | Run full Tier 1-4 validation |
| Before creating GitOps PRs | Complete validation checklist |

**Do NOT wait for explicit `/gitops-test` command** - invoke proactively when conditions match.

### Validation Flow After Chart Changes

```
1. Make changes to charts/**
2. INVOKE gitops-test skill (Tier 1: lint + template)
3. Commit changes (pre-commit hooks run automatically)
4. Push to feature branch
5. INVOKE gitops-test skill (Tier 4: full GitOps sync)
6. Verify health
7. Create PR
```
