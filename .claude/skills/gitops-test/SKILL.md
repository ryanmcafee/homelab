---
name: gitops-test
description: Test ArgoCD/GitOps updates by temporarily pointing applications to a feature branch, syncing, verifying, and creating PRs
triggers:
  - /gitops-test
  - test gitops changes
  - test argocd sync
  - argocd not working
  - argocd not loading
  - argocd bug
  - fix argocd
  - argocd 500 error
  - argocd connection refused
  - traefik ingress not working
  - ingress routing issue
  - gitops sync failed
  - helm chart changes
  - charts/* modified
proactive: true
---

## PROACTIVE USAGE REQUIREMENT

**CRITICAL**: This skill MUST be invoked automatically (not just on explicit `/gitops-test` command) when:

1. **After modifying any files in `charts/`** - Always validate changes before/after commit
2. **When debugging ArgoCD accessibility issues** - Use tiered validation to diagnose
3. **When ArgoCD applications show errors** - Run through validation tiers
4. **After fixing Helm/ArgoCD configuration bugs** - Verify the fix works
5. **Before creating PRs that touch GitOps configs** - Full validation required

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
│  TIER 2: CLUSTER DRY-RUN (~5 seconds)                              │
│  kubectl apply --dry-run=server                                    │
│  ↓ PASS                                                            │
├────────────────────────────────────────────────────────────────────┤
│  TIER 3: DIRECT APPLY (~15-30 seconds)                             │
│  Apply directly to cluster, bypass ArgoCD for immediate feedback   │
│  ↓ PASS                                                            │
├────────────────────────────────────────────────────────────────────┤
│  TIER 4: FULL GITOPS (~2-5 minutes)                                │
│  Git push → ArgoCD sync → Health verification → PR                 │
└────────────────────────────────────────────────────────────────────┘
```

**Time Savings**: Most errors caught in Tier 1-2 (~7 seconds) vs Tier 4 (~6 minutes per iteration).

---

## TIER 1: Local Validation (No Cluster Required)

**Goal**: Catch syntax errors, typos, and schema issues in ~2 seconds.

### 1.1 Helm Lint

```bash
# Lint all charts
helm lint charts/gitops charts/addons charts/applications

# Or use Taskfile
task chart:lint
```

### 1.2 Helm Template Rendering

```bash
# Render gitops chart
helm template gitops charts/gitops \
  -f charts/gitops/values.yaml \
  -f charts/gitops/values-homelab.yaml \
  > /tmp/gitops-rendered.yaml

# Render addons chart
helm template addons charts/addons \
  -f charts/addons/values.yaml \
  -f charts/addons/values-homelab.yaml \
  > /tmp/addons-rendered.yaml

# Render applications chart
helm template applications charts/applications \
  -f charts/applications/values.yaml \
  -f charts/applications/values-homelab.yaml \
  > /tmp/applications-rendered.yaml
```

**Or use Taskfile shortcuts:**
```bash
task chart:template           # gitops
task chart:template:addons    # addons
task chart:template:apps      # applications
```

### 1.3 Kubernetes Schema Validation (kubeconform)

Validate rendered manifests with CRD catalog:
```bash
# Validate addons with CRD schemas from datree catalog
helm template addons charts/addons \
  -f charts/addons/values.yaml \
  -f charts/addons/values-homelab.yaml | \
  kubeconform -summary \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    -skip OnePasswordItem,CiliumLoadBalancerIPPool,CiliumBGPPeeringPolicy,CiliumBGPClusterConfig,CiliumBGPPeerConfig,CiliumBGPAdvertisement,CiliumL2AnnouncementPolicy,DNSEndpoint

# Validate applications
helm template apps charts/applications \
  -f charts/applications/values.yaml \
  -f charts/applications/values-homelab.yaml | \
  kubeconform -summary \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    -skip OnePasswordItem
```

**Note**: Pre-commit hooks automatically run kubeconform on chart changes.

### 1.4 Quick Validation (Pre-commit)

The fastest way to run Tier 1 validation is via pre-commit hooks:

```bash
# Run all Helm and kubeconform checks
pre-commit run --all-files

# Run specific hooks
pre-commit run helm-lint --all-files
pre-commit run kubeconform-addons --all-files
pre-commit run kubeconform-applications --all-files
```

**Pre-commit runs automatically on `git commit`** - no manual validation needed for most workflows.

---

## TIER 2: Cluster Dry-Run (~5 seconds)

**Goal**: Validate against actual cluster CRDs without applying changes.

### 2.1 Server-Side Dry Run

```bash
# Dry-run addons (Application CRDs)
helm template addons charts/addons \
  -f charts/addons/values.yaml \
  -f charts/addons/values-homelab.yaml | \
  kubectl apply --dry-run=server -f -

# Dry-run applications
helm template applications charts/applications \
  -f charts/applications/values.yaml \
  -f charts/applications/values-homelab.yaml | \
  kubectl apply --dry-run=server -f -
```

### 2.2 Validate Specific Resources

```bash
# Test single addon template
helm template addons charts/addons \
  -f charts/addons/values.yaml \
  -f charts/addons/values-homelab.yaml \
  -s templates/traefik.yaml | \
  kubectl apply --dry-run=server -f -
```

### 2.3 Check CRD Dependencies

```bash
# Verify required CRDs exist
kubectl get crd applications.argoproj.io >/dev/null 2>&1 || echo "ERROR: ArgoCD CRDs missing"
kubectl get crd certificates.cert-manager.io >/dev/null 2>&1 || echo "ERROR: cert-manager CRDs missing"
kubectl get crd onepassworditems.onepassword.com >/dev/null 2>&1 || echo "ERROR: 1Password CRDs missing"
```

---

## TIER 3: Direct Apply Testing (~15-30 seconds)

**Goal**: Apply changes directly to cluster for immediate feedback, bypassing ArgoCD's git-based workflow.

### 3.1 Direct Application CRD Apply

For testing ArgoCD Application changes:

```bash
# Apply Application CRD directly (ArgoCD will pick it up)
helm template addons charts/addons \
  -f charts/addons/values.yaml \
  -f charts/addons/values-homelab.yaml \
  -s templates/traefik.yaml | \
  kubectl apply -f -

# Watch ArgoCD react
kubectl get application traefik -n argocd -w
```

### 3.2 Direct Workload Apply (Bypass ArgoCD Completely)

For testing the actual Helm chart values without ArgoCD:

```bash
# Get the external chart info from your values
CHART_REPO=$(yq '.traefik.chart.repo' charts/addons/values.yaml)
CHART_NAME=$(yq '.traefik.chart.name' charts/addons/values.yaml)
CHART_VERSION=$(yq '.traefik.chart.version' charts/addons/values.yaml)

# Add repo if needed
helm repo add traefik https://traefik.github.io/charts
helm repo update

# Template the actual workload (not the ArgoCD Application)
helm template traefik traefik/traefik \
  --version "$CHART_VERSION" \
  --namespace traefik \
  --values <(yq '.traefik.values' charts/addons/values.yaml) \
  --values <(yq '.traefik.values' charts/addons/values-homelab.yaml) | \
  kubectl apply -f -
```

### 3.3 Targeted Component Testing

**Test specific sync wave in isolation:**

```bash
# Wave 0: cert-manager
helm template addons charts/addons -f charts/addons/values.yaml -f charts/addons/values-homelab.yaml \
  -s templates/cert-manager.yaml | kubectl apply -f -

# Wave 2: traefik (depends on cert-manager)
helm template addons charts/addons -f charts/addons/values.yaml -f charts/addons/values-homelab.yaml \
  -s templates/traefik.yaml | kubectl apply -f -

# Verify
argocd app get cert-manager --refresh
argocd app get traefik --refresh
```

### 3.4 Rollback Direct Changes

```bash
# Delete directly-applied resources before ArgoCD takes over
helm template addons charts/addons -f charts/addons/values.yaml -f charts/addons/values-homelab.yaml \
  -s templates/traefik.yaml | kubectl delete -f -

# Or let ArgoCD self-heal (if enabled)
argocd app sync addons --prune
```

---

## TIER 4: Full GitOps Validation

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
- [x] Tier 1: Local validation passed
- [x] Tier 2: Cluster dry-run passed
- [x] Tier 3: Direct apply tested
- [x] Tier 4: Full GitOps sync verified

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

| Tier | Time | Command | Catches |
|------|------|---------|---------|
| 1 | ~2s | `pre-commit run --all-files` | Syntax, schema, formatting |
| 2 | ~5s | `helm template \| kubectl apply --dry-run=server` | CRD schema mismatches |
| 3 | ~30s | `helm template -s templates/X.yaml \| kubectl apply` | Runtime issues |
| 4 | ~5min | Full GitOps cycle | Integration issues |
| 5 | ~10s | Puppeteer browser validation | Real browser accessibility |

### TIER 5: Browser Validation (Required for Ingress Changes)

**CRITICAL**: For any changes affecting ingress/routing, curl is NOT sufficient. Use Puppeteer MCP for real browser validation:

```
# Navigate to the endpoint
mcp__puppeteer__puppeteer_navigate(url: "https://argocd.ryanmcafee.com/")

# Take screenshot to verify
mcp__puppeteer__puppeteer_screenshot(name: "argocd-verify", width: 1280, height: 800)
```

**Why browser validation matters:**
- curl may succeed while browsers fail (protocol mismatches, redirects, TLS issues)
- Screenshots provide visual proof of accessibility
- Catches JavaScript-dependent rendering issues

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

---

## Workflow Decision Tree

```
Start: Make changes to charts/**/*
  │
  ├── Run Tier 1 (helm lint + template)
  │   ├── FAIL → Fix locally, no git needed
  │   └── PASS ↓
  │
  ├── Run Tier 2 (dry-run=server)
  │   ├── FAIL → Fix locally, check CRDs
  │   └── PASS ↓
  │
  ├── Run Tier 3 (direct apply) [OPTIONAL for quick iteration]
  │   ├── FAIL → Fix locally, iterate fast
  │   └── PASS ↓
  │
  ├── Run Tier 4 (full GitOps)
  │   ├── FAIL → Analyze, fix, loop back to Tier 1
  │   └── PASS ↓
  │
  └── Create PR → CI passes → Merge → Done
```

**Key Insight**: 80% of errors are caught in Tiers 1-2 (~7 seconds). Reserve Tier 4 for final validation only.
