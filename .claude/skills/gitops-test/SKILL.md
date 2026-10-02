---
name: gitops-test
description: Verify GitOps changes with the single verification contract. Level 0 runs automatically after every edit to charts/ or configuration/ (PostToolUse hook) and must pass; levels 1-2 run on Kind; CI re-runs level 0 on the PR head (pr-contract.yml). Production is read-only for agents (task verify:prod, task prod:status, task prod:diff). MUST be used before offering to commit or open a PR for chart/configuration changes.
triggers:
  # Explicit invocation
  - /gitops-test
  - test gitops changes
  - validate helm changes
  - validate chart changes
  - verify chart changes

  # ArgoCD issues
  - argocd not working
  - argocd not loading
  - argocd bug
  - fix argocd
  - argocd 500 error
  - argocd connection refused
  - argocd sync failed
  - gitops sync failed

  # Gateway/routing issues
  - envoy gateway not working
  - httproute not working
  - routing issue
  - route not accessible

  # Pre-commit / pre-PR validation (CRITICAL - invoke before offering to commit)
  - ready to commit charts
  - commit helm changes
  - commit chart changes
  - before committing
  - open a pr
  - create a pr

  # Implementation patterns that modify charts
  - implement.*gateway
  - implement.*httproute
  - add.*httproute
  - configure.*oidc
  - configure.*authentication
  - update envoy gateway
  - update helm values
  - modify charts
  - bump.*version

  # File change patterns
  - charts/addons modified
  - charts/applications modified
  - configuration modified
  - values-homelab.yaml modified
proactive: true
proactive_conditions:
  # The PostToolUse hook already runs level 0 after these edits; the skill adds
  # Kind (levels 1-2), the PR claim and CI.
  - file_modified: "charts/**"
  - file_modified: "configuration/**"
  - file_modified: "tests/**"
  # MUST invoke before commit / PR when these are staged
  - before_action: "git commit"
    when_staged: "charts/**"
  - before_action: "git commit"
    when_staged: "configuration/**"
  - before_action: "gh pr create"
---

# GitOps verification (the single contract)

One contract, three levels, the same JSON everywhere
(`{"level":N,"checks":[{"name","status":"pass|fail|skip","duration_ms","detail?","findings?"}],"pass":bool,"duration_ms"}`,
exit 0 pass / 1 fail / 2 usage). Full reference: `docs/runbooks/verification.md`.

| Step | Who runs it | Command | Where |
|---|---|---|---|
| Level 0 (static) | **automatic** after every Edit/Write/MultiEdit under `charts/` or `configuration/` (PostToolUse hook); pre-commit; CI | `task verify:text` / `task verify` | no cluster |
| Level 1 (server-side dry run) | the agent | `task verify:text LEVEL=1` | Kind only |
| Level 2 (Applications + e2e) | the agent; CI on every PR | `task verify:text LEVEL=2` | Kind only |
| PR check | CI, on every PR | `task verify` on the PR head | `pr-contract.yml` |
| Production | nobody applies; ArgoCD after merge | read-only: `task verify:prod`, `task prod:status`, `task prod:diff -- <app>` | homelab, read-only |

## Authority (ADR-009)

- Agents may **mutate only Kind** (`kind-homelab-localdev`). Always pass `--context kind-homelab-localdev`
  to a manual `kubectl`; the current context may be production.
- Production changes happen **only** through merge → ArgoCD. An agent never applies manifests to the
  homelab cluster, never patches, syncs, refreshes-with-overrides or repoints a live Application, never
  disables automated sync, and never deletes live resources. This skill contains no command that does.
- Production is **read-only** for agents, through the `homelab-readonly` context and the read-only ArgoCD
  account (`docs/runbooks/readonly-access.md`).

## Proactive use

Before saying "ready to commit", "would you like me to commit?" or opening a PR, the agent MUST:

```
□ Level 0 is green for the current tree (hook output was silent, or `task verify:text` passes)
□ Chart/configuration change → level 1 and, when Applications changed, level 2 on Kind
```

Do not wait for an explicit `/gitops-test`.

## Level 0: automatic after every edit

`.claude/settings.json` registers `scripts/claude-verify-hook.ts` as a PostToolUse hook for
`Edit|Write|MultiEdit`. When an edited file is under `charts/` or `configuration/` of the project it
builds `./cmd/homelab` and runs `homelab verify all --level 0 --json` (≈5 s, 150 s cap):

- **pass** → silent.
- **fail** → the tool result is followed by a summary: failing check names, detail, up to five findings
  each, and fix hints. Treat it like a compiler error: fix every finding before the next step.
- **could not run** (Go build error, timeout) → reported the same way; fix or run `task verify:text`.
- A run already in flight for the same tree makes the next edit skip (lock in `$TMPDIR`); the last edit
  of a burst may therefore go unverified, so run `task verify:text` before committing.
- `HOMELAB_VERIFY_HOOK=off` disables it (only for a long mechanical edit series; run `task verify:text`
  at the end). Edits outside `charts/`/`configuration/` that change rendering (`tests/**`, `localdev/**`,
  `internal/verify/**`) are not watched: run `task verify:text` yourself.
- The hook watches `$CLAUDE_PROJECT_DIR`: launch Claude Code from the worktree you edit.

Manual runs:

```bash
task verify:text                              # human-readable, failures first
task verify                                   # JSON
task verify -- --env homelab                  # one environment
task verify:render -- --chart addons --keep   # keep the rendered manifests
```

| Check | Meaning | Typical fix |
|---|---|---|
| `render/<env>/<chart>`, `lint/<env>/<chart>` | `helm template --include-crds` / `helm lint` of every chart; homelab renders through the CMP's two-stage `config export` path from `homelab.yaml.example` | read the helm error in `findings` |
| `render/localdev/_committed-values` | committed `values-localdev.yaml` equals `config export --set localdev` | `task config:export:localdev` |
| `kubeconform/<env>` | every object validates against `tools.kubernetes` and `tests/schemas/` (no skip list) | new kind: add it to `tests/schemas/sources.yaml`, `task schemas:vendor` |
| `pluto/<env>` | no deprecated apiVersions | bump the apiVersion or chart |
| `gitops/<env>/*` | value-file paths, waves, CRD order, OCI repo Secrets, secret refs, namespaces, SSA on huge-CRD charts, unique names (`tests/gitops/`) | per `detail` |
| `snapshot/<env>/<chart>` | render is byte-identical to `tests/snapshots/` | intended change: `task test:snapshot -- --update`, review the diff, commit |
| `policy/<env>` | conftest rules in `tests/policy/` | fix the chart, or the policy-exempt annotations described in the runbook |

The `verify-level-0` pre-commit hook re-runs `task verify:text`; `verify.yml` re-runs level 0 in CI.

## Levels 1 and 2: Kind

```bash
task localdev:kind && task verify:text LEVEL=1   # server-side dry run of every localdev chart (dryrun/localdev/<chart>)
task localdev:up   && task verify:text LEVEL=2   # + argocd/<app> Healthy+Succeeded + e2e/<test> (chainsaw)
```

- `task localdev:sync -- --only <app>` re-syncs one Application from the working tree after an edit.
- `task localdev:diagnose` prints conditions, events and failing pod logs.
- `task localdev:report -- --base main` renders the Kind report (Application table, level-2 summary,
  `argocd app diff <app> --revision main` of every git-path Application); `tilt-ci.yml` posts the same
  report as the sticky `kind-preview` comment.
- Every Application tracks the PR head (`task localdev:argocd -- --revision <ref>` / `LOCALDEV_REVISION`,
  default the upstream branch of HEAD, `main` when unpushed) and is synced from the working tree
  (automated sync is off in localdev): `Synced` means the tree equals the pushed head; the contract
  still judges health and the last operation, never sync status.
- One test: `task test:e2e -- --test-dir tests/e2e/<app>`; health Lua: `task test:health`.

## Level 0 on the PR head

The PR description carries no verification block. `pr-contract.yml` (required check "Verification claim
matches level 0") runs `task verify` on the PR head and fails when level 0 fails; the job summary lists the
failing checks.

## After pushing

```bash
gh pr checks --watch
```

`verify.yml` (level 0 on the merge result), `pr-contract.yml` (level 0 on the PR head), `tilt-ci.yml` `kind-argocd`
(level 2 + Kind report), and for version bumps `upgrade.yml` (upstream manifest diff). Read failing jobs
with `gh run view <id> --log-failed`; download `verify-level0` / `verify-level2` artifacts for the JSON.

## Previews on the homelab cluster

A PR labelled `preview` plus `preview:<app>` (for example `preview:sonarr`) gets that application
deployed from the PR head into namespace `preview-<pr>` at `<app>-pr<pr>.<domain>`
(`docs/runbooks/previews.md`: allowed apps, quota, fresh storage, no 1Password, teardown on close or
unlabel). The label makes ArgoCD deploy into the homelab cluster, so it is a maintainer action: an
agent asks the user to apply it (or applies it with `gh pr edit --add-label` only when the user
explicitly asks), then observes the result read-only.

## Production: read-only

```bash
task prod:kubeconfig             # once: ~/.kube/homelab-readonly.yaml (token provisioned by a human)
task verify:prod                 # prod/argocd/<app> Health + last operation, JSON contract (level 2 shape)
task prod:status                 # Application table
task prod:diff -- <app>          # argocd app diff with the read-only account
kubectl --context homelab-readonly get <kind> -A    # anything else: get/list/watch only, no Secrets
```

Setup and the human-only steps (Tailscale ACL grant, tokens in 1Password) are in
`docs/runbooks/readonly-access.md`. After merge, ArgoCD reports the deploy on the PR and as the commit
status `argocd/<app>` once GitHub notifications are enabled there. If production is broken, report what
you read and propose a PR; a live fix is a human action.

## Renovate and version bumps

Edit only `configuration/versions.yaml` (single source of truth). On the PR, `upgrade.yml` runs
`task verify:upgrade -- --base origin/main`: it renders every upstream chart at base and head, diffs
the manifests (sticky `upgrade-diff` comment), re-validates every CR against the new CRD schemas, and
sets the `upgrade/automerge-gate` status (success only when nothing rendered changed). Locally:

```bash
task verify:upgrade -- --base origin/main --report upgrade-report.md
task schemas:vendor            # operator bump that ships CRDs
task test:snapshot -- --update # accept the render change after reviewing it
```

## Other contract commands

| Command | Purpose |
|---|---|
| `task scaffold -- app <name> --pattern operator\|helm\|deps-main-config [--dry-run]` | new app following the repo's patterns, with tests and snapshots |
| `task drill:restore` | CloudNativePG backup/restore drill on Kind (weekly in CI) |
| `task test:policy`, `task test:health`, `task test:config` | policy, health Lua and config contract unit tests |

## Read-only diagnostics by component

Use `CTX=kind-homelab-localdev` while iterating on Kind and `CTX=homelab-readonly` to look at production.
Every command below only reads.

**ArgoCD**
```bash
kubectl --context "$CTX" -n argocd get applications -o wide
kubectl --context "$CTX" -n argocd get application <app> -o json | jq '.status.conditions, .status.operationState.message'
kubectl --context "$CTX" -n argocd logs -l app.kubernetes.io/name=argocd-application-controller --tail=100 | rg -i "error|failed"
task prod:diff -- <app>          # production; on Kind: task localdev:report
```

**cert-manager**
```bash
kubectl --context "$CTX" get certificates,orders,challenges -A
kubectl --context "$CTX" describe challenge -n <namespace>
kubectl --context "$CTX" -n cert-manager logs -l app.kubernetes.io/name=cert-manager --tail=100 | rg -i "error|failed"
kubectl --context "$CTX" -n cert-manager get pods -l app.kubernetes.io/name=cert-manager \
  -o jsonpath='{.items[0].spec.containers[0].args}' | jq -r '.[]' | rg dns01
dig TXT _acme-challenge.<domain> +short
```

| Error | Cause | Fix (in a PR) |
|---|---|---|
| `SERVFAIL looking up CAA` | cluster DNS resolver | `dns01RecursiveNameservers` under cert-manager in `charts/addons/values.yaml` |
| `zone ID empty` (Cloudflare) | token lacks Zone:Read | human: token permissions, or an explicit zoneID |
| challenge stuck `pending` | DNS propagation | wait; public resolvers (1.1.1.1, 8.8.8.8) |
| `CleanUpError` | cannot delete the ACME TXT record | human: Cloudflare token permissions |

**Envoy Gateway / routes**
```bash
kubectl --context "$CTX" get gatewayclasses,gateways -A
kubectl --context "$CTX" get httproutes -A -o wide
kubectl --context "$CTX" -n envoy-gateway-system get svc envoy-internal envoy-external
```
A route is served only when its parent status shows `Accepted` and `ResolvedRefs` True for the
`https` listener (`kubectl get httproute <name> -n <ns> -o yaml`).
For routing or TLS changes, a browser check of the affected endpoint (`mcp__puppeteer__puppeteer_navigate`
to `https://<endpoint-under-test>/`, then a screenshot) is read-only and proves the change; use the
preview hostname for a preview.

**external-dns**: `kubectl --context "$CTX" get dnsendpoints -A`; `dig <hostname> +short`.

**Storage (democratic-csi, local-path)**
```bash
kubectl --context "$CTX" get pvc -A | rg -v Bound
kubectl --context "$CTX" -n democratic-csi get pods
```

**Monitoring**: `kubectl --context "$CTX" -n monitoring get pods`; `kubectl --context "$CTX" get servicemonitors -A`.

**Applications (plex, sonarr, ...)**
```bash
kubectl --context "$CTX" -n <namespace> get pods,endpoints
kubectl --context "$CTX" -n <namespace> get events --sort-by=.lastTimestamp | tail -20
```

## Decision tree

```
Edit charts/** or configuration/**
  │  hook: level 0 after every edit ── fail → fix the findings (snapshot drift on purpose → task test:snapshot -- --update)
  ▼
Kind: task verify:text LEVEL=1, then LEVEL=2 after task localdev:up
  │  fail → task localdev:diagnose, fix, task localdev:sync -- --only <app>
  ▼
Commit (pre-commit re-runs level 0)
  ▼
Push → gh pr checks: verify.yml, pr-contract.yml, tilt-ci.yml (+ upgrade.yml for bumps)
  │  optional: ask the maintainer for the preview labels
  ▼
Merge → ArgoCD applies → observe read-only: task verify:prod / task prod:status
```
