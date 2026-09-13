# GitOps Test Command

Run the verification contract for the current change: level 0, Kind (levels 1-2), the PR claim, CI.
Never touches production; production is read-only (ADR-009). Details: the `gitops-test` skill and
`docs/runbooks/verification.md`.

## Usage

```
/gitops-test [level] [app ...]
```

## Arguments

- `$ARGUMENTS` - Optional. A level (`0`, `1` or `2`, default: the highest the change needs) and/or
  Application names to re-sync on Kind before level 2 (default: everything the change touches).

## What This Does

1. **Level 0**: `task verify:text` (the PostToolUse hook already ran it after each edit to `charts/` or
   `configuration/`; this confirms the final tree). Fix every finding; intended render changes:
   `task test:snapshot -- --update` after reviewing the diff.
2. **Level 1 (Kind)**: `task localdev:kind && task verify:text LEVEL=1`.
3. **Level 2 (Kind)**: `task localdev:up` (or `task localdev:sync -- --only <app>` on a running loop),
   then `task verify:text LEVEL=2`; on failure `task localdev:diagnose`. `task localdev:report` shows the
   working tree against `main`.
4. **Claim**: `task verify:claim`, pasted into the PR body's Verification section.
5. **CI**: push, open or update the PR (`gh pr create` / `gh pr edit`), `gh pr checks --watch`
   (`verify.yml`, `pr-contract.yml`, `tilt-ci.yml`, `upgrade.yml` for bumps).
6. **Production (read-only, after merge)**: `task verify:prod`, `task prod:status`, `task prod:diff -- <app>`.

## Prerequisites

- `mise install` (go, helm, kubeconform, conftest, pluto, kind, argocd, chainsaw, deno, task)
- Docker running for levels 1-2
- `gh` authenticated for the PR steps
- For read-only production: `task prod:kubeconfig` (see `docs/runbooks/readonly-access.md`)

## Examples

```
/gitops-test            # full contract for the current change
/gitops-test 0          # level 0 + claim only
/gitops-test 2 sonarr   # re-sync sonarr on Kind, then level 2
```

## Safety

- Mutates only the Kind cluster `kind-homelab-localdev`; every manual kubectl pins that context.
- Never applies to, patches, syncs or repoints production Applications and never disables automated sync.
- Preview labels (`preview`, `preview:<app>`) deploy into the homelab cluster: ask the user to apply them.
