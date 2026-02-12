# PII Remediation & Configuration Centralization Design

**Date:** 2026-02-11
**Status:** Draft
**Issues:** #31, #32, #38, #48
**Scope:** Centralize all hardcoded configuration, eliminate PII from committed files, prevent future leaks

## Goals

1. **Centralize** — single source of truth for all configuration (IPs, domains, hostnames, usernames, versions, secrets references)
2. **Eliminate hardcoding** — replace 40+ files with inline PII with generated outputs from a config pipeline
3. **Prevent future leaks** — gitignore, pre-commit hooks, CI validation
4. **Type safety** — JSON schema validation, typed Go config package, IDE autocompletion
5. **DRY** — chart versions, repeated patterns, and duplicated values consolidated
6. **Git history rewrite** — deferred to a separate phase after centralization is stable

## Design Patterns (Adapted from Configu)

| Configu Concept | Homelab Adaptation |
|---|---|
| **ConfigSchema** (`.cfgu.yaml`) | `.schema.yaml` files declaring config keys with types, validation, defaults, descriptions |
| **ConfigSet** (hierarchical path) | `configuration/environments/` hierarchy: `defaults.yaml` -> `homelab.yaml` / `localdev.yaml` |
| **ConfigStore** (pluggable backend) | YAML file store (non-sensitive config) + 1Password (secrets) |
| **Eval pipeline** | `homelab config eval --set homelab` resolves all config for an environment |
| **Export formatters** | `homelab config export --format helm-values` generates consumer-specific files |
| **Expression system** | Computed keys: `ARGOCD_HOSTNAME` = `argocd.{{configs.DOMAIN.value}}` |
| **Config triple** | Every value is `{key, value, set}` with provenance tracking |

## Architecture

### Directory Structure

```
configuration/
├── schema/                       # Config key declarations (committed)
│   ├── network.schema.yaml       # IPs, CIDRs, hostnames, VLANs, BGP
│   ├── secrets.schema.yaml       # 1Password references, env var names
│   ├── kubernetes.schema.yaml    # Cluster settings, node config, storage
│   ├── applications.schema.yaml  # App-specific: Plex, Sonarr, HA, etc.
│   └── infrastructure.schema.yaml # Proxmox, TrueNAS, PCI passthrough
├── environments/                 # Config values per environment
│   ├── defaults.yaml             # Root set — shared defaults (committed)
│   ├── homelab.yaml              # Production values (GITIGNORED — contains PII)
│   ├── homelab.yaml.example      # Template showing required shape (committed)
│   └── localdev.yaml             # Kind/Tilt dev values (committed)
├── templates/                    # Export format templates (committed)
│   ├── helm-addons.tmpl
│   ├── helm-apps.tmpl
│   ├── tfvars.tmpl
│   ├── ansible.tmpl
│   └── dotenv.tmpl
├── versions.yaml                 # All chart/tool versions (committed)
└── .configu.yaml                 # Store + schema registry (committed)
```

### Data Flow

```
Schema (.schema.yaml)     Environment (homelab.yaml)     Versions (versions.yaml)
        |                         |                              |
        v                         v                              v
   ┌─────────────────────────────────────────────────────────────────┐
   │                    homelab config eval                          │
   │  1. Load schemas (validate key declarations)                   │
   │  2. Load environment values (hierarchy: defaults -> homelab)   │
   │  3. Validate values against schema (pattern, enum, required)   │
   │  4. Resolve expressions (const computed keys)                  │
   │  5. Merge versions                                             │
   └──────────────────────────┬──────────────────────────────────────┘
                              │
                              v
   ┌─────────────────────────────────────────────────────────────────┐
   │                   homelab config export                         │
   │  --format helm-addons  -> values-homelab.generated.yaml         │
   │  --format helm-apps    -> values-homelab.generated.yaml         │
   │  --format tfvars       -> env.generated.tfvars                  │
   │  --format ansible      -> homelab.generated.yml                 │
   │  --format env          -> .env.generated                        │
   │  --format json         -> resolved.json (debug)                 │
   └─────────────────────────────────────────────────────────────────┘
```

## Schema Declarations

Each `.schema.yaml` declares config keys with validation rules. No actual values, only contracts.

```yaml
# configuration/schema/network.schema.yaml
keys:
  DOMAIN:
    description: Base domain for all services
    required: true
    test: validator.isFQDN($.storedValue)

  TRAEFIK_STATIC_IP:
    description: Static IP for Traefik ingress
    required: true
    pattern: "^(?:\\d{1,3}\\.){3}\\d{1,3}$"

  LB_POOL_START:
    description: First IP in Cilium LB IPAM pool
    required: true
    pattern: "^(?:\\d{1,3}\\.){3}\\d{1,3}$"

  LB_POOL_END:
    description: Last IP in Cilium LB IPAM pool
    required: true
    pattern: "^(?:\\d{1,3}\\.){3}\\d{1,3}$"

  BGP_K8S_ASN:
    description: Cilium BGP autonomous system number
    required: true
    test: "validator.isInt($.storedValue, {min: 64512, max: 65534})"
    default: "64512"

  ARGOCD_HOSTNAME:
    description: ArgoCD UI hostname
    const: "argocd.{{configs.DOMAIN.value}}"

  GRAFANA_HOSTNAME:
    description: Grafana dashboard hostname
    const: "grafana.{{configs.DOMAIN.value}}"
```

### Schema Properties (from Configu ICfgu)

| Property | Type | Purpose |
|----------|------|---------|
| `description` | string | Human-readable purpose, drives generated docs |
| `required` | bool | Eval fails if missing (catches misconfiguration early) |
| `pattern` | string | Regex validation (IPs, CIDRs, hostnames) |
| `test` | string/string[] | Expression-based validation (port ranges, ASN bounds) |
| `default` | any | Fallback value if not provided in any environment |
| `const` | string | Computed value via expressions (hostnames from DOMAIN) |
| `enum` | any[] | Allowable values list |
| `hidden` | bool | Omitted from export output |
| `label` | string/string[] | Categorization for filtering |

## Environment Values (ConfigSet Hierarchy)

```yaml
# configuration/environments/defaults.yaml
# Root ConfigSet — inherited by all environments
DOMAIN: example.com
BGP_K8S_ASN: "64512"
BGP_ROUTER_ASN: "64513"
K8S_POD_CIDR: "10.244.0.0/16"
K8S_SERVICE_CIDR: "10.96.0.0/12"
NFS_MAPALL_USER: ""
ACME_EMAIL: ""
```

```yaml
# configuration/environments/homelab.yaml (GITIGNORED)
# ConfigSet "homelab" — overrides defaults with real PII
DOMAIN: ryanmcafee.com
GATEWAY_IP: "172.16.100.1"
TRUENAS_IP: "172.16.100.150"
PROXMOX_IP: "172.16.100.250"
CP_VIP: "172.16.100.10"
CP1_IP: "172.16.100.11"
CP2_IP: "172.16.100.12"
CP3_IP: "172.16.100.13"
WORKER1_IP: "172.16.100.21"
WORKER2_IP: "172.16.100.22"
WORKER3_IP: "172.16.100.23"
LB_POOL_START: "172.16.100.100"
LB_POOL_END: "172.16.100.200"
TRAEFIK_STATIC_IP: "172.16.100.200"
NFS_MAPALL_USER: rmcafee
ACME_EMAIL: admin@ryanmcafee.com
NFS_BASE_PATH: /mnt/storage
```

```yaml
# configuration/environments/localdev.yaml
# ConfigSet "localdev" — Kind/Tilt development
DOMAIN: homelab.local
GATEWAY_IP: "127.0.0.1"
NFS_BASE_PATH: /tmp/storage
```

### Inheritance Rules

- `localdev` inherits everything from `defaults.yaml`, overrides only what differs
- `homelab` inherits from `defaults.yaml`, provides all production values
- If a key is `required: true` in the schema and missing from both the environment file and defaults, `homelab config eval` fails with a clear error
- `homelab.yaml.example` is committed showing the required shape with placeholder values

## Versions Management

```yaml
# configuration/versions.yaml
charts:
  argocd: "7.7.15"
  cilium: "1.16.5"
  cert-manager: "v1.16.2"
  external-dns: "1.15.0"
  kube-prometheus-stack: "69.8.2"
  traefik: "39.0.0"
  democratic-csi: "0.14.6"
  kubelet-csr-approver: "1.2.2"
  onepassword-connect: "1.16.1"
  plex-media-server: "1.4.0"
  sonarr: "25.2.11"
  radarr: "26.3.11"
  prowlarr: "21.3.12"
  home-assistant: "28.19.14"
  mosquitto: "17.13.9"

tools:
  talos: "v1.9.2"
  kubernetes: "v1.32.0"
  terraform: "1.9.8"
  helm: "3.16.0"
```

One file replaces version duplication across `values.yaml`, `values-homelab.yaml`, `CLAUDE.md`, and Terragrunt configs. Renovate/Dependabot PRs update one file, not 4.

## Export Pipeline

### Export Targets

| Format | Output File | Replaces |
|--------|------------|----------|
| `helm-addons` | `charts/addons/values-homelab.generated.yaml` | Hardcoded IPs/domains in `values-homelab.yaml` |
| `helm-apps` | `charts/applications/values-homelab.generated.yaml` | Hardcoded IPs/domains in `values-homelab.yaml` |
| `tfvars` | `terragrunt/environments/homelab/env.generated.tfvars` | Hardcoded values in `env.hcl` |
| `ansible` | `ansible/inventory/generated/homelab.yml` | Hardcoded IPs in `inventory/homelab.yml` |
| `env` | `.env.generated` | Manual `.env` files |
| `json` | `configuration/resolved.json` | Debugging/inspection |

### Export Rules

- Generated files use `.generated.` in the name — gitignored, distinguishable from hand-maintained files
- Helm values use merge strategy: `values.yaml` (base, committed) + `values-homelab.generated.yaml` (PII, gitignored)
- Templates in `configuration/templates/` use Go `text/template` to map config keys to output structure
- Export is deterministic — same input always produces same output

## Go CLI & Taskfile Integration

### CLI Commands

```bash
homelab config validate --set homelab     # Validate schemas + environment values
homelab config eval --set homelab         # Resolve all config (prints JSON)
homelab config export --set homelab --format helm-addons  # Export specific format
homelab config export --set homelab --all  # Export all formats
homelab config diff --set homelab         # Diff resolved config vs generated files
homelab config guard                      # Scan staged files for PII patterns
homelab config init --set staging         # Scaffold new environment from example
```

### Go Package Structure

```
internal/config/
├── schema.go        # Schema loading + JSON Schema validation
├── set.go           # ConfigSet hierarchy + inheritance resolution
├── eval.go          # Eval pipeline: load -> merge -> validate -> resolve expressions
├── export.go        # Formatter registry + template rendering
├── store.go         # ConfigStore interface (YAML file reader)
└── formats/
    ├── helm.go      # Helm values formatter
    ├── tfvars.go    # Terraform tfvars formatter
    ├── ansible.go   # Ansible inventory formatter
    └── dotenv.go    # .env formatter
```

### Taskfile Targets

```yaml
config:validate:
  desc: Validate configuration schemas and values
  cmds: [homelab config validate --set {{.ENV | default "homelab"}}]

config:export:
  desc: Export all configuration formats
  cmds: [homelab config export --set {{.ENV | default "homelab"}} --all]

config:diff:
  desc: Show pending config changes
  cmds: [homelab config diff --set {{.ENV | default "homelab"}}]
```

### Integration with Existing Commands

- `homelab render` calls `config eval` internally before rendering Cilium/CSR manifests
- `homelab bootstrap` calls `config validate` as a preflight check
- `task tf:plan` runs `config:export:tfvars` before `terragrunt plan`

## Prevention & Guardrails

### Layer 1: Gitignore

```gitignore
# Configuration - environment-specific values contain PII
configuration/environments/homelab.yaml
configuration/environments/staging.yaml
!configuration/environments/defaults.yaml
!configuration/environments/localdev.yaml
!configuration/environments/*.example

# Generated outputs
*.generated.yaml
*.generated.tfvars
*.generated.yml
.env.generated

# Audit files
PII.md
```

### Layer 2: Pre-commit Hook

`homelab config guard` scans staged files for PII patterns read from `configuration/environments/homelab.yaml`:

- IP addresses matching `172.16.100.x` patterns
- The configured `DOMAIN` value (e.g., `ryanmcafee.com`)
- Email addresses matching `ACME_EMAIL`
- Usernames matching `NFS_MAPALL_USER`

The guard list stays in sync automatically because it reads from the same config it protects.

### Layer 3: CI Pipeline

```yaml
- name: Config validation
  run: |
    homelab config validate --set localdev
    homelab config guard --ci
```

CI runs against `localdev` (committed, safe). `--ci` flag checks no generated files or PII environment files were accidentally committed.

### Layer 4: Template-only Committed Files

```yaml
# configuration/environments/homelab.yaml.example
DOMAIN: your-domain.com
GATEWAY_IP: "192.168.1.1"
TRUENAS_IP: "192.168.1.100"
# ... all keys with placeholder values
```

## Migration Phases

### TDD Methodology

Every implementation phase follows a strict Red-Green-Refactor cycle using Claude Code agent teams with context isolation per phase.

**TDD Rules:**

1. **RED** — test-writer creates failing tests from requirements/schema contracts only. No implementation in context.
2. **GREEN** — implementer receives only the failing test + minimal context. Writes minimum code to pass.
3. **REFACTOR** — refactorer evaluates code quality with tests passing. Cleans up or confirms "no refactoring needed."
4. **Gate** — never proceed until current gate passes (tests fail -> tests pass -> tests still pass after refactor).

### Agent Team Structure

Each phase spawns a team with the lead in delegate mode (coordination only):

| Teammate | Role | Context |
|----------|------|---------|
| **Lead** | Orchestrator (delegate mode) | Full plan, phase requirements |
| **test-writer** | RED phase — writes failing tests | Schema contracts + requirements only |
| **implementer** | GREEN phase — minimal code to pass | Failing test file + minimal context |
| **refactorer** | REFACTOR phase — cleanup | Passing tests + implementation |
| **reviewer** | Quality gate — validates each phase | All files, runs tests |

### Agent Team Workflow

```
Lead (delegate mode):
  1. Creates task list from phase requirements
  2. Assigns task to test-writer -> requires plan approval
  3. test-writer plans test approach -> lead approves/rejects
  4. test-writer writes tests -> messages reviewer "tests ready"
  5. reviewer runs tests, confirms RED -> messages lead "gate passed"
  6. Lead assigns task to implementer -> requires plan approval
  7. implementer plans approach -> lead approves only if minimal
  8. implementer writes code -> messages reviewer "impl ready"
  9. reviewer runs tests, confirms GREEN -> messages lead "gate passed"
  10. Lead assigns task to refactorer
  11. refactorer cleans up -> messages reviewer "refactor ready"
  12. reviewer runs tests, confirms still GREEN -> messages lead "done"
  13. Lead marks task complete, moves to next
```

**Key agent team features used:**

- **Delegate mode** — lead never writes code, only coordinates
- **Plan approval** — lead rejects implementer plans that over-engineer
- **Inter-agent messaging** — reviewer notifies lead of gate results; test-writer and implementer never communicate directly (context isolation)
- **Shared task list** — all teammates see progress, blocked tasks auto-unblock
- **`TaskCompleted` hook** — enforces tests pass before any task can be marked complete

### Phase 1: Foundation (Issues #31, #32)

**Team:** 3 teammates (test-writer, implementer, reviewer)

- Create `configuration/` directory structure
- Write `.schema.yaml` files for all 5 domains
- Create `versions.yaml` from current chart versions
- Write `defaults.yaml`, `homelab.yaml`, `localdev.yaml` from PII audit
- Create `homelab.yaml.example` with placeholder values
- Add gitignore rules
- **TDD:** RED — schema validation tests (malformed schemas, missing required fields, invalid patterns). GREEN — implement schema parser. REFACTOR.

**Deliverable:** Configuration directory with all schemas + environments, schema loading tested.

### Phase 2: Go CLI (Issue #38)

**Team:** 4 teammates (test-writer, implementer, refactorer, reviewer)

TDD cycle per component:

1. `schema.go`: RED — test schema loading, key validation, pattern/enum/required enforcement. GREEN — implement. REFACTOR.
2. `set.go`: RED — test hierarchy resolution (child overrides parent, defaults apply, missing required fails). GREEN — implement. REFACTOR.
3. `eval.go`: RED — test expression evaluation (`const` computed keys, `{{configs.DOMAIN.value}}`), full pipeline resolution. GREEN — implement. REFACTOR.
4. `export.go`: RED — test each formatter produces correct output (helm values structure, tfvars syntax, dotenv format). GREEN — implement. REFACTOR.
5. `guard`: RED — test PII pattern detection in staged files (true positives, false negatives). GREEN — implement. REFACTOR.

**Deliverable:** Working `homelab config` CLI with validate, eval, export, diff, guard subcommands. All tests passing.

### Phase 3: Consumer Migration (Issues #38, #48)

**Team:** 4 teammates (helm-teammate, terraform-teammate, ansible-teammate, reviewer) — parallel by file ownership

Phase 3 uses agent teams differently: parallel implementation by consumer since each is independent and won't conflict.

- **helm-teammate:** Helm export templates + tests asserting parity with current `values-homelab.yaml`
- **terraform-teammate:** tfvars export templates + tests asserting parity with current `env.hcl`
- **ansible-teammate:** Ansible inventory export + tests asserting parity with current `inventory/homelab.yml`
- **reviewer:** Validates parity with current hand-maintained files

One PR per consumer group — incremental, reviewable.

**Deliverable:** All consumers read from generated config. Hardcoded PII removed from committed files.

### Phase 4: Prevention

**Team:** 2 teammates (test-writer + implementer, reviewer)

- **TDD:** RED — test pre-commit hook catches real PII patterns, allows clean files. Test CI pipeline rejects accidentally committed PII. GREEN — implement hooks. REFACTOR.
- Add pre-commit hook (`homelab config guard`)
- Add CI pipeline validation
- Remove `PII.md`
- Update `CLAUDE.md` and `CLAUDE.local.md` to reference the config system

**Deliverable:** Automated guardrails preventing future PII leaks.

### Phase 5: History Rewrite (Deferred)

Separate planning session after all phases are stable.

- Use `git filter-repo` to scrub PII from all historical commits
- Force push, all contributors re-clone
- Verify no PII remains in any historical commit

### TaskCompleted Hook

```bash
#!/bin/bash
# .claude/hooks/task-completed.sh
# Enforce all tests pass before task completion
cd /Users/ryanmcafee/Projects/homelab
go test ./internal/config/... 2>&1
```

## Files Changed Summary

### New Files

- `configuration/` — entire directory (schemas, environments, versions, templates)
- `internal/config/` — Go config package
- `cmd/homelab/commands/config.go` — CLI subcommand registration
- `.pre-commit-config.yaml` — pre-commit hook config

### Modified Files

- `charts/addons/values-homelab.yaml` — hardcoded values replaced with generated
- `charts/applications/values-homelab.yaml` — hardcoded values replaced with generated
- `terragrunt/environments/homelab/env.hcl` — hardcoded values replaced with generated
- `ansible/inventory/homelab.yml` — hardcoded IPs replaced with generated
- `Taskfile.yml` — new config targets
- `.gitignore` — PII environment files + generated outputs
- `CLAUDE.md` — reference config system
- `CLAUDE.local.md` — simplified (most content moves to `homelab.yaml`)

### Removed Files

- `PII.md` — replaced by living schema documentation
