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
| 1 | ~2s | `task chart:lint` | Syntax, schema, formatting |
| 2 | ~5s | `helm template $CHART charts/$CHART -f charts/$CHART/values.yaml -f charts/$CHART/values-homelab.yaml \| kubectl apply --dry-run=server -f -` | CRD schema mismatches |
| 3 | ~30s | `helm template $CHART charts/$CHART -f charts/$CHART/values.yaml -f charts/$CHART/values-homelab.yaml -s templates/X.yaml > /tmp/X.yaml && kubectl apply -f /tmp/X.yaml` | Runtime issues |
| 4 | ~5min | Full GitOps cycle (git push → ArgoCD sync) | Integration issues |
| 5 | ~10s | Context-aware validation (component-specific checks) | Component-specific issues |

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
- What template was rendered/applied in Tier 3?
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
