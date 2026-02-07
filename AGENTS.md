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

## Installed Subagents (VoltAgent)

25 specialized subagents from [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents), customized with homelab project context. Installed in both `.claude/agents/` (project) and `~/.claude/agents/` (global).

### Infrastructure (9 agents)

| Agent | Model | Purpose |
|-------|-------|---------|
| kubernetes-specialist | sonnet | K8s cluster design, workloads, security hardening, GitOps |
| terraform-engineer | sonnet | Terraform modules, state management, CI/CD integration |
| terragrunt-expert | sonnet | Terragrunt stack architecture, DRY configs, multi-env |
| devops-engineer | sonnet | IaC automation, CI/CD, containerization, monitoring |
| sre-engineer | sonnet | SLO/SLI management, reliability, toil reduction, chaos |
| security-engineer | opus | DevSecOps, zero-trust, compliance, secrets management |
| deployment-engineer | haiku | CI/CD pipelines, deployment strategies, GitOps |
| devops-incident-responder | sonnet | Production incident triage, postmortems, emergency response |
| network-engineer | sonnet | Cloud/hybrid networking, DNS, BGP, security |

### Quality & Security (5 agents)

| Agent | Model | Purpose |
|-------|-------|---------|
| code-reviewer | opus | Code quality, security vulnerabilities, best practices |
| architect-reviewer | opus | System design, architectural patterns, scalability |
| performance-engineer | sonnet | Profiling, load testing, database optimization |
| debugger | sonnet | Root cause analysis, systematic debugging, postmortems |
| chaos-engineer | sonnet | Resilience testing, failure injection, game days |

### Language Specialists (2 agents)

| Agent | Model | Purpose |
|-------|-------|---------|
| golang-pro | sonnet | Go concurrency, performance, microservices, testing |
| typescript-pro | sonnet | TypeScript/Deno, type safety, async patterns |

### Data (2 agents)

| Agent | Model | Purpose |
|-------|-------|---------|
| database-administrator | sonnet | DB performance, HA, backup/recovery, multi-engine |
| postgres-pro | sonnet | PostgreSQL optimization, replication, CloudNativePG |

### Developer Experience (5 agents)

| Agent | Model | Purpose |
|-------|-------|---------|
| documentation-engineer | haiku | API docs, doc systems, version management |
| git-workflow-manager | haiku | Branching strategies, Git hooks, release management |
| refactoring-specialist | sonnet | Code smell detection, safe refactoring, test-driven |
| mcp-developer | sonnet | MCP server/client development, JSON-RPC, tool integration |
| build-engineer | haiku | Build optimization, caching, bundling, monorepo |

### Other (2 agents)

| Agent | Model | Purpose |
|-------|-------|---------|
| dependency-manager | haiku | Security scanning, version conflicts, license compliance |
| technical-writer | haiku | API references, user guides, documentation automation |

### Agent-Specific Customizations

These agents have additional project-specific context beyond the base homelab context:

| Agent | Customizations |
|-------|---------------|
| kubernetes-specialist | ArgoCD sync wave order, Cilium LB IPAM pool, Democratic-CSI notes, known issues |
| terraform-engineer | Module/environment paths, rendered manifest workflow, 1Password docs |
| terragrunt-expert | DRY patterns, module/environment directory layout |
| security-engineer | SOPS age key paths, 1Password vault paths, sync wave ordering for secrets |
| golang-pro | Table-driven tests, 95%+ coverage, Pact/TestContainers |
| typescript-pro | Deno runtime, permissions pattern, Vitest/Pact, no Bash/Python |
| code-reviewer | Forbidden CLI patterns, TypeScript-only scripting, semantic commits |
| deployment-engineer | ArgoCD sync waves, health checks, ServerSideApply |
| postgres-pro | CloudNativePG operator patterns |
| network-engineer | Cilium BGP config (ASN 64512/64513), IP addresses, LB pool |
