---
name: gitops-test
description: Validate ArgoCD/GitOps chart changes with level-0 static verification (Tier 1) and, on a Kind cluster, a dry-run (Tier 2). MUST be invoked automatically after ANY modification to charts/ files before committing. Tiers 3 and 4 (applying to, or repointing, the live cluster) are RETIRED for agents by ADR-009 and are human-only reference.
triggers:
  # Explicit invocation
  - /gitops-test
  - test gitops changes
  - validate helm changes
  - validate chart changes

  # ArgoCD issues
  - argocd not working
  - argocd not loading
  - argocd bug
  - fix argocd
  - argocd 500 error
  - argocd connection refused
  - argocd sync failed
  - gitops sync failed

  # Ingress/routing issues
  - traefik ingress not working
  - ingress routing issue
  - ingress not accessible
  - middleware not working

  # Pre-commit validation (CRITICAL - invoke before offering to commit)
  - ready to commit charts
  - commit helm changes
  - commit chart changes
  - before committing

  # Implementation patterns that modify charts
  - implement.*traefik
  - implement.*middleware
  - implement.*ingress
  - add.*middleware
  - add.*plugin
  - configure.*oidc
  - configure.*authentication
  - replace.*oauth2-proxy
  - update traefik
  - update helm values
  - modify charts

  # File change patterns
  - charts/addons modified
  - charts/applications modified
  - values-homelab.yaml modified
  - traefik.yaml modified
proactive: true
# Proactive invocation is capped at Tier 1 (and Tier 2 against Kind). Tiers 3
# and 4 mutate or repoint the live cluster and are RETIRED for agents by
# ADR-009 — nothing here may invoke them.
proactive_tier_ceiling: 2
proactive_conditions:
  # MUST invoke after ANY of these file patterns are modified
  - file_modified: "charts/addons/templates/*.yaml"
  - file_modified: "charts/addons/values*.yaml"
  - file_modified: "charts/applications/templates/*.yaml"
  - file_modified: "charts/applications/values*.yaml"
  - file_modified: "charts/gitops/templates/*.yaml"
  - file_modified: "charts/gitops/values*.yaml"
  # MUST invoke before commit when charts/ files are staged
  - before_action: "git commit"
    when_staged: "charts/**"
---

> ## ⛔ TIERS 3 AND 4 ARE RETIRED FOR AGENTS
>
> **ADR-009 and `AGENTS.md`: agents may mutate only Kind clusters. Production is
> verified by merge → ArgoCD → CI/notifications, never by an agent applying
> manifests to it or repointing a live Application at a feature branch.**
>
> - **Tier 1** (level-0 static verification, `task verify`) is the mandatory gate.
> - **Tier 2** is the Kind loop, `task verify LEVEL=1|2`, and is allowed **against Kind only**.
> - **Tier 3** (direct `kubectl apply` to the cluster) and **Tier 4** (patching the
>   live `gitops`/`addons`/`applications` Applications to a feature branch) are
>   **retired for agents**. They remain below as human-only reference.
> - Section B of [issue #261](https://github.com/ryanmcafee/homelab/issues/261)
>   replaced them with the Kind loop (ADR-012). An agent's end state for a chart
>   change is: Tier 1 passes → Tier 2 on Kind passes → commit → PR → CI.
>
> Nothing in this skill may proactively invoke Tier 3 or Tier 4.

## PROACTIVE USAGE REQUIREMENT

**CRITICAL**: This skill MUST be invoked automatically (not just on explicit `/gitops-test` command) when:

Every item below means **Tier 1**, plus Tier 2 when a Kind cluster is up. None of
them authorises Tier 3 or Tier 4.

1. **IMMEDIATELY after modifying any files in `charts/`** - Run Tier 1 before proceeding
2. **BEFORE offering to commit chart changes** - NEVER offer "would you like me to commit?" without running validation first
3. **After implementing features that touch Helm templates** - traefik, middleware, ingress, authentication, etc.
4. **When debugging ArgoCD accessibility issues** - Tier 1 for anything static; reading live state (`kubectl get`, `argocd app get`) is fine, mutating it is not
5. **When ArgoCD applications show errors** - Tier 1, then read live state; a live fix is a human action
6. **After fixing Helm/ArgoCD configuration bugs** - Verify with Tier 1
7. **Before creating PRs that touch GitOps configs** - Tier 1 must pass; CI re-runs it on the PR

### Proactive Invocation Checklist

Before saying "ready to commit" or "would you like me to commit?", the agent MUST:

```
□ Check if any charts/* files were modified in this session
□ If yes → Run gitops-test Tier 1 (level 0); Tier 2 too if Kind is up
□ Only after validation passes → Offer to commit
```

### Example Workflow (CORRECT)

```
User: "Replace oauth2-proxy with traefik OIDC plugin"
Agent: [modifies charts/addons/templates/traefik.yaml]
Agent: [modifies charts/addons/values-homelab.yaml]
Agent: [INVOKES /gitops-test skill - Tier 1 (level-0) validation]
Agent: "Validation passed. Would you like me to commit these changes?"
```

### Example Workflow (INCORRECT - DO NOT DO THIS)

```
User: "Replace oauth2-proxy with traefik OIDC plugin"
Agent: [modifies charts/addons/templates/traefik.yaml]
Agent: [modifies charts/addons/values-homelab.yaml]
Agent: "Would you like me to commit these changes?"  ← WRONG: No validation!
```

The agent MUST invoke this skill proactively when these conditions are met, without waiting for the user to explicitly request `/gitops-test`.

# GitOps Test Skill (Optimized)

Test ArgoCD/GitOps changes with minimal feedback loop using tiered validation.

## Prerequisites

Tools managed via `mise.toml` (run `mise install` if missing):
- `helm` - Chart templating and linting
- `kubectl` - Cluster operations
- `argocd` - ArgoCD CLI
- `kubeconform` - Kubernetes schema validation
- `yq` - YAML processing
- `pre-commit` - Git hooks (already installed via `pre-commit install`)

## Scope

This skill monitors and tests changes to:
- `charts/addons/templates/*`
- `charts/applications/templates/*`
- `charts/gitops/templates/*`
- `charts/secrets/*`

## Tiered Validation Strategy

**Design Principle**: Fail fast locally before involving git or ArgoCD.

```
┌────────────────────────────────────────────────────────────────────┐
│  TIER 1: LOCAL VALIDATION (~2 seconds)                             │
│  helm lint + helm template + kubeconform                           │
│  ↓ PASS                                                            │
├────────────────────────────────────────────────────────────────────┤
│  TIER 2: KIND LOOP (level 1 ~10 s dry run, level 2 minutes)        │
│  task verify LEVEL=1 | LEVEL=2  (Kind only)                        │
│  ↓ PASS                                                            │
├────────────────────────────────────────────────────────────────────┤
│  TIER 3: DIRECT APPLY — ⛔ RETIRED FOR AGENTS (ADR-009)             │
│  Human-only reference. Agents may mutate Kind only.                │
├────────────────────────────────────────────────────────────────────┤
│  TIER 4: FULL GITOPS — ⛔ RETIRED FOR AGENTS (ADR-009)              │
│  Repoints live Applications at a branch. Human-only reference.      │
└────────────────────────────────────────────────────────────────────┘
```

**An agent's path stops at Tier 2**: Tier 1 passes → Tier 2 on Kind passes → commit → PR
→ CI → merge → ArgoCD. The Kind loop (Section B of issue #261, ADR-012) replaced Tiers 3-4.

**Time Savings**: Most errors are caught in Tier 1 (~2 seconds).

---

## TIER 1: Level-0 Static Verification (No Cluster Required)

**Goal**: Catch rendering, schema, GitOps-graph, snapshot and policy problems in < 5 seconds, with no cluster, no network and no PII. This is the mandatory gate for every chart change (ADR-009). Full reference: `docs/runbooks/verification.md`.

### 1.1 Run it

```bash
task verify:text                 # human-readable, failures first
task verify                      # JSON summary (paste into the PR body)
task verify -- --env homelab     # one environment
task verify:render -- --chart addons --keep   # keep rendered manifests for inspection
```

Exit code 0 = pass, 1 = findings, 2 = usage error. JSON contract:

```json
{"level":0,"checks":[{"name":"render/homelab/addons","status":"pass","duration_ms":120}],"pass":true,"duration_ms":2900}
```

### 1.2 What it checks

| Check | Meaning |
|---|---|
| `render/<env>/<chart>`, `lint/<env>/<chart>` | `helm template --include-crds` and `helm lint` for every chart in `charts/` (homelab renders through the same two-stage `config export` path as the CMP, from `homelab.yaml.example`) |
| `kubeconform/<env>` | Every object validates against `versions.yaml` `tools.kubernetes` and the vendored CRD schemas in `tests/schemas/` — there is **no `-skip` list**; a missing schema means `task schemas:vendor` after adding the kind to `tests/schemas/sources.yaml` |
| `pluto/<env>` | No deprecated apiVersions for the target Kubernetes version |
| `gitops/<env>/*` | paths + value files exist, `*-dependencies` < main, CR after CRD provider, OCI repo Secrets present, secret refs produced in-namespace, namespaces declared, `ServerSideApply=true` on huge-CRD charts, unique Application names (registries in `tests/gitops/`) |
| `snapshot/<env>/<chart>` | Byte-identical to `tests/snapshots/`; intended changes: `task test:snapshot -- --update` |
| `policy/<env>` | conftest rules in `tests/policy/` (finalizer, sync-wave, SSA, automated sync, no `:latest`, resources, no inline secrets, hostnames under DOMAIN); exempt with `homelab.ryanmcafee.com/policy-exempt` + `-reason` annotations |

### 1.3 Pre-commit

The `verify-level-0` pre-commit hook runs `task verify:text` whenever `charts/`, `configuration/`, `localdev/` or `tests/` change, so `git commit` is gated automatically. CI re-runs it in `.github/workflows/verify.yml`, and runs the Kind loop (level 2) in `.github/workflows/tilt-ci.yml`.

---

## TIER 2: Kind Loop (`task verify LEVEL=1|2`)

**Goal**: Prove the change against a real API server and a real ArgoCD, on Kind only
(ADR-009). Both levels emit the same JSON contract as level 0 and run in CI
(`.github/workflows/tilt-ci.yml`, job `kind-argocd`, required). Full reference:
`docs/runbooks/verification.md`, `docs/local-development.md`.

### 2.1 Level 1: server-side dry run (~10 seconds once the cluster exists)

```bash
task localdev:kind               # Kind + Cilium + fakes; idempotent, no ArgoCD needed
task verify:text LEVEL=1         # level 0 + kubectl apply --server-side --dry-run=server of every localdev chart
```

Checks `dryrun/localdev/<chart>`: admission webhooks, installed CRD versions, namespaces
and StorageClasses that exist in Kind. `--env` must include `localdev`; the homelab render
is never applied anywhere by an agent.

### 2.2 Level 2: Application health and e2e (minutes)

```bash
task localdev:up                 # Kind + ArgoCD + every Application synced from the working tree (argocd app sync --local)
task verify:text LEVEL=2         # level 1 + argocd/<app> (Healthy + Succeeded) + e2e/<test> (chainsaw)
```

After editing, `task localdev:sync` (or `-- --only <app>`) pushes the working tree again;
`task localdev:diagnose` prints conditions, events and failing pod logs. Every
Application is `OutOfSync` against GitHub `main` after a local sync by design (automated
sync is off in localdev); never treat that as a failure.

### 2.3 One-off checks

```bash
task test:e2e -- --test-dir tests/e2e/<app>      # one chainsaw test with full output
task test:health                                 # health Lua fixtures, no cluster
kubectl --context kind-homelab-localdev get crd applications.argoproj.io certificates.cert-manager.io
```

Always pin `--context kind-homelab-localdev` on any manual kubectl call: the current
context may be production.

---

## TIER 3: Direct Apply Testing (~15-30 seconds)

> ### ⛔ RETIRED FOR AGENTS — human-only reference
>
> ADR-009 and `AGENTS.md`: **an agent may mutate only a Kind cluster.** Applying
> rendered manifests to the homelab cluster bypasses ArgoCD, makes the cluster
> disagree with git, and will be reverted by self-heal. Section D of issue #261
> replaces this tier with the Kind loop. An agent that reaches this point has
> already done its job at Tier 1: commit, open a PR, and let ArgoCD apply the
> change after merge.
>
> Everything below is kept for a human operator working the cluster by hand.

**Goal**: Apply changes directly to cluster for immediate feedback, bypassing ArgoCD's git-based workflow.

### 3.1 Generic Render and Apply Pattern

Use this pattern for any chart/template:

```bash
# Generic pattern: Render specific template and apply
CHART="addons"          # or: gitops, applications
TEMPLATE="traefik.yaml" # template filename in templates/

helm template "$CHART" "charts/$CHART" \
  -f "charts/$CHART/values.yaml" \
  -f "charts/$CHART/values-homelab.yaml" \
  -s "templates/$TEMPLATE" \
  > "/tmp/$TEMPLATE"

# Apply to cluster
kubectl apply -f "/tmp/$TEMPLATE"
```

**Shorthand function (add to shell profile):**
```bash
# Usage: gitops-apply addons traefik.yaml
gitops-apply() {
  local chart="$1" template="$2"
  helm template "$chart" "charts/$chart" \
    -f "charts/$chart/values.yaml" \
    -f "charts/$chart/values-homelab.yaml" \
    -s "templates/$template" | kubectl apply -f -
}
```

### 3.2 Validate and Assert Pattern

After applying, always validate the result:

```bash
# Generic validation pattern
CHART="addons"
TEMPLATE="argo-workflows.yaml"
APP_NAME="argo-workflows"  # ArgoCD Application name
NAMESPACE="argo-workflows" # Target namespace

# Step 1: Render and apply
helm template "$CHART" "charts/$CHART" \
  -f "charts/$CHART/values.yaml" \
  -f "charts/$CHART/values-homelab.yaml" \
  -s "templates/$TEMPLATE" | kubectl apply -f -

# Step 2: Wait for ArgoCD to process (if Application CRD)
sleep 5

# Step 3: Assert sync status
SYNC_STATUS=$(kubectl get application "$APP_NAME" -n argocd -o jsonpath='{.status.sync.status}')
HEALTH_STATUS=$(kubectl get application "$APP_NAME" -n argocd -o jsonpath='{.status.health.status}')

echo "Sync: $SYNC_STATUS | Health: $HEALTH_STATUS"

# Step 4: Assert expected state
if [[ "$HEALTH_STATUS" == "Healthy" ]] || [[ "$HEALTH_STATUS" == "Progressing" ]]; then
  echo "✅ PASS: Application is healthy or progressing"
else
  echo "❌ FAIL: Application health is $HEALTH_STATUS"
  kubectl get application "$APP_NAME" -n argocd -o json | jq '.status.conditions'
  exit 1
fi

# Step 5: Check for sync errors
SYNC_ERROR=$(kubectl get application "$APP_NAME" -n argocd -o json | jq -r '.status.conditions[]? | select(.type=="ComparisonError") | .message')
if [[ -n "$SYNC_ERROR" ]]; then
  echo "❌ FAIL: Sync error detected"
  echo "$SYNC_ERROR"
  exit 1
fi
```

### 3.3 Resource-Specific Assertions

```bash
# Assert Certificate is ready
kubectl wait --for=condition=Ready certificate/"$CERT_NAME" -n "$NAMESPACE" --timeout=120s

# Assert Deployment is available
kubectl wait --for=condition=Available deployment/"$DEPLOY_NAME" -n "$NAMESPACE" --timeout=120s

# Assert Ingress has IP assigned
INGRESS_IP=$(kubectl get ingress "$INGRESS_NAME" -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
if [[ -z "$INGRESS_IP" ]]; then
  echo "❌ FAIL: Ingress has no IP"
  exit 1
fi
echo "✅ Ingress IP: $INGRESS_IP"

# Assert Pod is running
kubectl wait --for=condition=Ready pod -l "app=$APP_LABEL" -n "$NAMESPACE" --timeout=120s
```

### 3.4 Targeted Component Testing

**Test specific sync wave in isolation:**

```bash
# Wave 0: cert-manager
gitops-apply addons cert-manager.yaml

# Wave 2: traefik (depends on cert-manager)
gitops-apply addons traefik.yaml

# Verify via kubectl (argocd CLI may not be configured)
kubectl get application cert-manager -n argocd -o jsonpath='{.status.sync.status} {.status.health.status}'
kubectl get application traefik -n argocd -o jsonpath='{.status.sync.status} {.status.health.status}'
```

### 3.5 Rollback Direct Changes

```bash
# Delete directly-applied resources
helm template "$CHART" "charts/$CHART" \
  -f "charts/$CHART/values.yaml" \
  -f "charts/$CHART/values-homelab.yaml" \
  -s "templates/$TEMPLATE" | kubectl delete -f -

# Or let ArgoCD self-heal (if enabled)
argocd app sync addons --prune
```

---

## TIER 4: Full GitOps Validation

> ### ⛔ RETIRED FOR AGENTS — human-only reference
>
> ADR-009 and `AGENTS.md`: **an agent must never repoint the live
> `gitops`/`addons`/`applications` Applications at a feature branch, and must
> never disable their automated sync.** Doing so leaves production tracking an
> unmerged branch, and a missed cleanup step leaves it there. Production is
> verified by merge → ArgoCD → CI/notifications. Section D of issue #261
> replaces this tier with the Kind loop.
>
> Everything below is kept for a human operator doing a deliberate, supervised
> branch deploy.

**Goal**: Complete end-to-end GitOps verification. Only run after Tiers 1-3 pass.

### 4.1 Setup - Redirect to Feature Branch

```bash
FEATURE_BRANCH=$(git branch --show-current)

# Verify not on main
if [ "$FEATURE_BRANCH" = "main" ]; then
  echo "ERROR: Cannot test on main branch"
  exit 1
fi

# Push branch
git push -u origin "$FEATURE_BRANCH"

# Patch all apps to feature branch + disable auto-sync
for app in gitops addons applications; do
  kubectl patch application "$app" -n argocd --type=merge -p '{
    "spec": {
      "source": {"targetRevision": "'"$FEATURE_BRANCH"'"},
      "syncPolicy": {"automated": null}
    }
  }'
done

# Verify
kubectl get applications -n argocd -o custom-columns='NAME:.metadata.name,REVISION:.spec.source.targetRevision,AUTO-SYNC:.spec.syncPolicy.automated'
```

### 4.2 Commit and Push Changes

```bash
git add charts/
git commit -m "feat: <description>"
git push origin "$FEATURE_BRANCH"
```

### 4.3 Force Refresh and Sync

```bash
# Cancel any running operations
for app in gitops addons applications; do
  argocd app terminate-op "$app" 2>/dev/null || true
done

# Hard refresh (clear cache, fetch latest)
for app in gitops addons applications; do
  argocd app get "$app" --hard-refresh
done

# Sync in wave order
argocd app sync gitops --force --prune --timeout 120
argocd app sync addons --force --prune --timeout 300
argocd app sync applications --force --prune --timeout 300
```

### 4.4 Verify Health

```bash
# Quick status
argocd app list -o wide

# Detailed check
argocd app wait addons --health --timeout 300
argocd app wait applications --health --timeout 300

# Check for degraded child apps
kubectl get applications -n argocd -o json | \
  jq -r '.items[] | select(.status.health.status != "Healthy") | "\(.metadata.name): \(.status.health.status) - \(.status.health.message)"'
```

### 4.5 Create PR (on success)

```bash
gh pr create --title "feat: <title>" --body "$(cat <<'EOF'
## Summary
- <changes>

## Validation
- [x] Tier 1: level-0 static verification passed (`task verify`)
- [ ] Tier 2: `task verify LEVEL=2` on Kind passed (paste the JSON summary)

## ArgoCD Status
- gitops: Synced/Healthy
- addons: Synced/Healthy
- applications: Synced/Healthy
EOF
)"

# Watch CI
gh pr checks --watch
```

### 4.6 Cleanup - Restore Main

```bash
# Restore all apps to main + re-enable auto-sync
for app in gitops addons applications; do
  kubectl patch application "$app" -n argocd --type=merge -p '{
    "spec": {
      "source": {"targetRevision": "main"},
      "syncPolicy": {
        "automated": {"prune": true, "selfHeal": true}
      }
    }
  }'
done

# Verify restoration
kubectl get applications -n argocd -o custom-columns='NAME:.metadata.name,REVISION:.spec.source.targetRevision,AUTO-SYNC:.spec.syncPolicy.automated'
```

---

## Current Tooling

### Pre-commit Hooks (Installed)

Pre-commit hooks are configured in `.pre-commit-config.yaml` and run automatically on commit:

| Hook | Purpose |
|------|---------|
| `helm-lint` | Validate Helm chart syntax |
| `helm-template-*` | Test chart rendering |
| `kubeconform-*` | K8s schema validation with CRD catalog |
| `yamllint` | YAML syntax (non-templates) |
| `terraform_fmt` | Auto-format Terraform |
| `trailing-whitespace` | Remove trailing whitespace |
| `detect-private-key` | Block private keys |

### Future Optimization: Enable Webhooks

To eliminate ArgoCD's 3-minute polling delay, configure GitHub webhooks:

1. Add to `charts/applications/values-homelab.yaml`:
```yaml
argocd:
  values:
    configs:
      secret:
        webhook.github.secret: <base64-encoded-secret>
```

2. Configure GitHub webhook:
   - URL: `https://argocd.ryanmcafee.com/api/webhook`
   - Content type: `application/json`
   - Events: `push`, `pull_request`

**Time saved**: 0-180s per sync cycle.

---

## Quick Reference

### Validation Tiers Summary

⛔ **Tiers 3 and 4 are retired for agents (ADR-009).** An agent uses Tiers 1, 2 (Kind
only) and 5.

| Tier | Agents? | Time | Command | Catches |
|------|---------|------|---------|---------|
| 1 | ✅ mandatory | ~2s | `task verify` | Render, schema, GitOps graph, snapshots, policy |
| 2 | ✅ Kind only | ~10s / minutes | `task verify LEVEL=1` (server-side dry run) / `task verify LEVEL=2` (Application health + chainsaw e2e) after `task localdev:up` | Webhook and CRD rejections; Applications that do not reach Healthy; endpoints that do not answer |
| 3 | ⛔ retired | ~30s | `helm template ... > /tmp/X.yaml && kubectl apply -f /tmp/X.yaml` | Runtime issues (human-only) |
| 4 | ⛔ retired | ~5min | Full GitOps cycle (repoint live Applications → sync) | Integration issues (human-only) |
| 5 | ✅ | ~10s | Context-aware validation (component-specific checks) | Component-specific issues |

### Generic Render/Apply/Assert Commands

```bash
# Variables (set these for your use case)
CHART="addons"                    # Chart directory name
TEMPLATE="argo-workflows.yaml"    # Template to render
APP_NAME="argo-workflows"         # ArgoCD Application name

# Render to temp file
helm template "$CHART" "charts/$CHART" \
  -f "charts/$CHART/values.yaml" \
  -f "charts/$CHART/values-homelab.yaml" \
  -s "templates/$TEMPLATE" > "/tmp/$TEMPLATE"

# Apply
kubectl apply -f "/tmp/$TEMPLATE"

# Assert health (wait up to 60s)
kubectl get application "$APP_NAME" -n argocd -w --timeout=60s

# Or one-liner status check
kubectl get application "$APP_NAME" -n argocd -o jsonpath='Sync:{.status.sync.status} Health:{.status.health.status}'
```

### TIER 5: Context-Aware Validation

**CRITICAL**: Validation MUST be specific to the component being tested. Do NOT default to checking ArgoCD - evaluate the actual changes made.

#### Step 1: Identify the Component Under Test

Before running Tier 5, determine what was modified:
- What template was changed (and, for a human working Tier 3, applied)?
- What ArgoCD Application was affected?
- What namespace and resources were changed?

#### Step 2: Run Component-Specific Validation

**cert-manager changes:**
```bash
# Check certificate status
kubectl get certificates -A -o wide

# Verify specific certificate
kubectl describe certificate <CERT_NAME> -n <NAMESPACE>

# Check orders/challenges if pending
kubectl get orders,challenges -A

# Validate TLS on affected endpoint
curl -w "TLS: %{ssl_verify_result}\n" -so /dev/null https://<ENDPOINT>
```

**traefik/ingress changes:**
```bash
# Check IngressRoute status
kubectl get ingressroutes -A

# Verify Traefik service has LoadBalancer IP
kubectl get svc traefik -n traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}'

# Browser validation for routing changes
mcp__puppeteer__puppeteer_navigate(url: "https://<AFFECTED_ENDPOINT>/")
mcp__puppeteer__puppeteer_screenshot(name: "<component>-verify", width: 1280, height: 800)
```

**external-dns changes:**
```bash
# Check DNSEndpoint resources
kubectl get dnsendpoints -A

# Verify DNS resolution
dig <HOSTNAME> +short
```

**democratic-csi/storage changes:**
```bash
# Check PVCs are bound
kubectl get pvc -A | grep -v Bound

# Check CSI driver pods
kubectl get pods -n democratic-csi
```

**kube-prometheus-stack changes:**
```bash
# Check Prometheus/Grafana pods
kubectl get pods -n monitoring

# Verify ServiceMonitors
kubectl get servicemonitors -A
```

**Application deployments (plex, sonarr, etc.):**
```bash
# Check pod status
kubectl get pods -n <NAMESPACE> -l app=<APP_NAME>

# Check service endpoints
kubectl get endpoints -n <NAMESPACE>

# Browser validation
mcp__puppeteer__puppeteer_navigate(url: "https://<APP_HOSTNAME>/")
mcp__puppeteer__puppeteer_screenshot(name: "<app>-verify", width: 1280, height: 800)
```

#### Step 3: Browser Validation (When Applicable)

Only use Puppeteer browser validation when:
- Testing ingress/routing changes
- Verifying TLS certificate presentation
- Checking UI accessibility after deployment

```
# Navigate to the AFFECTED endpoint (not a default)
mcp__puppeteer__puppeteer_navigate(url: "https://<ENDPOINT_UNDER_TEST>/")

# Take screenshot as proof
mcp__puppeteer__puppeteer_screenshot(name: "<component>-verify", width: 1280, height: 800)
```

**Why context-aware validation matters:**
- Validates the actual change, not an unrelated component
- Catches component-specific issues (cert issuance, DNS propagation, storage binding)
- Provides meaningful proof that the tested change works

### Emergency Cleanup

If something goes wrong, always restore:

```bash
# Force restore all apps to main
for app in gitops addons applications; do
  kubectl patch application "$app" -n argocd --type=merge -p '{"spec":{"source":{"targetRevision":"main"},"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}'
done

# Force sync from main
argocd app sync gitops addons applications --force
```

### Debugging Failures

```bash
# Application-level errors
argocd app get <app> --show-operation

# Resource-level events
kubectl get events -n <namespace> --sort-by='.lastTimestamp' | tail -20

# Controller logs
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-application-controller --tail=100 | rg -i "error|failed"

# Diff without syncing
argocd app diff <app>
```

### Certificate Debugging (cert-manager)

When ingress TLS certificates fail to issue:

```bash
# Check certificate status
kubectl get certificates -A

# Check orders and challenges
kubectl get orders -A
kubectl get challenges -A

# Describe failing challenge for details
kubectl describe challenge -n <namespace>

# Check cert-manager logs
kubectl logs -n cert-manager -l app.kubernetes.io/name=cert-manager --tail=100 | rg -i "error|failed"

# Verify cert-manager has DNS resolver args
kubectl get pods -n cert-manager -l app.kubernetes.io/name=cert-manager \
  -o jsonpath='{.items[0].spec.containers[0].args}' | jq -r '.[]' | rg dns01

# Check for orphaned ACME challenge TXT records
dig TXT _acme-challenge.<domain> +short
```

**Common cert-manager issues:**
| Error | Cause | Solution |
|-------|-------|----------|
| `SERVFAIL looking up CAA` | DNS resolver issues | Configure `dns01RecursiveNameservers` in cert-manager |
| `zone ID empty` in Cloudflare API | API token missing Zone:Read | Update token permissions or add explicit zoneID |
| Challenge stuck in `pending` | DNS propagation delay | Wait or use public DNS resolvers (1.1.1.1, 8.8.8.8) |
| `CleanUpError` | Failed to delete ACME TXT record | Check Cloudflare API token permissions |

**DNS Resolver Configuration:**
cert-manager uses cluster DNS by default which may have propagation delays. Configure public resolvers:

```yaml
# In charts/addons/values.yaml under cert-manager:
dns01RecursiveNameservers:
  - "1.1.1.1:53"
  - "8.8.8.8:53"
  - "8.8.4.4:53"
```

This adds `--dns01-recursive-nameservers` and `--dns01-recursive-nameservers-only` to the cert-manager controller.

---

## Workflow Decision Tree

```
Start: Make changes to charts/**/*
  │
  ├── Run Tier 1 (helm lint + template)
  │   ├── FAIL → Fix locally, no git needed
  │   └── PASS ↓
  │
  ├── Run Tier 2 on Kind (task verify LEVEL=1, then LEVEL=2 after task localdev:up)
  │   ├── FAIL → task localdev:diagnose, fix locally, task localdev:sync
  │   └── PASS ↓
  │
  ├── ⛔ Tier 3 / Tier 4 — RETIRED FOR AGENTS (ADR-009), human-only
  │
  └── Create PR → CI passes → Merge → ArgoCD applies → Done
```

**Key Insight**: almost every error is caught in Tier 1 (~2 seconds). An agent's loop
ends at the PR; ArgoCD applies the change after merge, and CI is the production
feedback signal.
