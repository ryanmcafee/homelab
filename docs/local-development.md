# Local Development Guide

This document provides comprehensive instructions for developing and testing homelab configurations locally using Kind (Kubernetes in Docker) and Tilt.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Tilt Modes](#tilt-modes)
- [Development Workflow](#development-workflow)
- [Testing Strategies](#testing-strategies)
- [Debugging](#debugging)
- [CI Integration](#ci-integration)
- [Troubleshooting](#troubleshooting)
- [References](#references)

---

## Overview

### Why Local Development?

**"Test before you wreck."**

Local development enables:
- **Rapid Iteration**: See changes in seconds, not minutes
- **Risk-Free Testing**: Break things without affecting production
- **Offline Development**: Work without VPN or hardware access
- **CI Validation**: Automated testing in GitHub Actions
- **Environment Parity**: Same Helm charts as homelab

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Developer Laptop                        │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Docker Desktop / Podman                               │ │
│  │                                                        │ │
│  │  ┌──────────────────────────────────────────────────┐ │ │
│  │  │  Kind Cluster (Kubernetes in Docker)            │ │ │
│  │  │                                                  │ │ │
│  │  │  ┌─────────────┐  ┌─────────────┐              │ │ │
│  │  │  │ Control     │  │ Worker      │              │ │ │
│  │  │  │ Plane       │  │ Node        │              │ │ │
│  │  │  │ Container   │  │ Container   │              │ │ │
│  │  │  └─────────────┘  └─────────────┘              │ │ │
│  │  │                                                  │ │ │
│  │  │  Addons:         Applications:                  │ │ │
│  │  │  - Traefik       - Plex (no GPU)                │ │ │
│  │  │  - cert-manager  - Sonarr                       │ │ │
│  │  │  - Prometheus    - Radarr                       │ │ │
│  │  └──────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Tilt (Hot Reload & Orchestration)                    │ │
│  │  - Watches file changes                               │ │
│  │  - Rebuilds/redeploys automatically                   │ │
│  │  - Web UI: http://localhost:10350                    │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Key Differences from Production

| Feature | Production | Local Dev |
|---------|------------|-----------|
| Platform | Proxmox VMs (Talos) | Kind (Docker) |
| Nodes | 2 control + 3 workers | 1 control + 1 worker |
| Storage | TrueNAS (NFS) | local-path-provisioner |
| Load Balancer | MetalLB (BGP) | NodePort |
| DNS | external-dns (Cloudflare) | /etc/hosts or localhost |
| Secrets | 1Password Operator | Fake secrets |
| GPU | NVIDIA Quadro P2200 | None |
| Deployment | ArgoCD (GitOps) | Tilt (direct or ArgoCD) |

---

## Prerequisites

### Required Software

| Tool | Version | Installation |
|------|---------|--------------|
| Docker Desktop | 24.0+ | https://www.docker.com/products/docker-desktop |
| Kind | 0.22+ | `brew install kind` or https://kind.sigs.k8s.io/docs/user/quick-start/ |
| Kubectl | 1.30+ | `brew install kubectl` or https://kubernetes.io/docs/tasks/tools/ |
| Helm | 3.14+ | `brew install helm` or https://helm.sh/docs/intro/install/ |
| Tilt | 0.33+ | `brew install tilt` or https://docs.tilt.dev/install.html |
| Task (Taskfile) | 3.35+ | `brew install go-task/tap/go-task` or https://taskfile.dev/installation/ |

### System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 4 cores | 8+ cores |
| RAM | 8 GB | 16+ GB |
| Disk | 20 GB free | 50+ GB free |
| Docker | 4 GB RAM allocated | 8+ GB RAM allocated |

### Verify Prerequisites

```bash
# Check Docker
docker --version
docker ps

# Check Kind
kind --version

# Check kubectl
kubectl version --client

# Check Helm
helm version

# Check Tilt
tilt version

# Check Task
task --version
```

---

## Quick Start

### Option 1: Using Taskfile (Recommended)

```bash
# Clone repository
git clone https://github.com/username/homelab.git
cd homelab

# Start local dev environment
task localdev:up

# Wait for cluster ready (opens Tilt UI automatically)
# Access Tilt UI: http://localhost:10350

# Stop environment
task localdev:down
```

### Option 2: Manual Setup

```bash
# Create Kind cluster
cd localdev
kind create cluster --config kind-config.yaml --name homelab

# Start Tilt (direct mode)
tilt up

# Start Tilt (ArgoCD mode)
tilt up -- --mode=argocd

# Stop Tilt (keeps cluster running)
tilt down

# Delete cluster
kind delete cluster --name homelab
```

### Verify Installation

```bash
# Check cluster status
kubectl cluster-info
kubectl get nodes

# Check pods
kubectl get pods -A

# Access Tilt UI
# http://localhost:10350
```

**Expected Output**:

```
$ kubectl get nodes
NAME                    STATUS   ROLES           AGE   VERSION
homelab-control-plane   Ready    control-plane   2m    v1.30.0
homelab-worker          Ready    <none>          2m    v1.30.0

$ kubectl get pods -A
NAMESPACE            NAME                                        READY   STATUS    RESTARTS   AGE
kube-system          coredns-xxx                                 1/1     Running   0          2m
kube-system          local-path-provisioner-xxx                  1/1     Running   0          2m
traefik              traefik-xxx                                 1/1     Running   0          1m
cert-manager         cert-manager-xxx                            1/1     Running   0          1m
```

---

## Tilt Modes

### Direct Mode (Default)

**Use Case**: Fast iteration on Helm charts

**How It Works**:
- Tilt deploys charts directly via `helm upgrade --install`
- File changes trigger automatic rebuild/redeploy
- No ArgoCD overhead
- Fastest feedback loop (< 10 seconds)

**Start**:

```bash
tilt up
# or
task localdev:tilt
```

**Architecture**:

```
File Change → Tilt Detects → Helm Upgrade → Pod Restart → Browser Refresh
```

### ArgoCD Mode

**Use Case**: Realistic GitOps testing

**How It Works**:
- Tilt installs ArgoCD
- ArgoCD deploys charts from local filesystem
- Simulates production GitOps workflow
- Slower but more realistic (30-60 seconds)

**Start**:

```bash
tilt up -- --mode=argocd
# or
task localdev:tilt:argocd
```

**Architecture**:

```
File Change → Tilt Watches → Manual Sync → ArgoCD Reconciles → Pods Update
```

**Access ArgoCD UI**:

```bash
# Get admin password
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d

# Access UI: http://localhost:8080
# Username: admin
# Password: (from above command)
```

### Switching Modes

```bash
# Stop current mode
tilt down

# Start in different mode
tilt up -- --mode=argocd
# or
tilt up  # (defaults to direct)
```

---

## Development Workflow

### Typical Development Cycle

```
┌─────────────────────────────────────────────────────────┐
│  1. Make changes to Helm chart or values file          │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  2. Save file (Tilt auto-detects change)                │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  3. Tilt rebuilds/redeploys (< 10 seconds)              │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  4. Verify in Tilt UI or browser                        │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  5. Commit changes when satisfied                       │
└─────────────────────────────────────────────────────────┘
```

### Example: Modify Traefik Configuration

**Step 1**: Edit chart values

```bash
vim charts/addons/values-localdev.yaml
```

**Step 2**: Change Traefik resource limits

```yaml
traefik:
  enabled: true
  resources:
    requests:
      cpu: 100m  # Changed from 50m
      memory: 256Mi  # Changed from 128Mi
```

**Step 3**: Save file (Tilt auto-deploys)

**Step 4**: Verify in Tilt UI

- Open http://localhost:10350
- Click on `traefik` resource
- Check logs for successful restart
- View pod status

**Step 5**: Test changes

```bash
# Check new resource limits
kubectl -n traefik get pods traefik-xxx -o yaml | grep -A 5 resources
```

**Step 6**: Commit

```bash
git add charts/addons/values-localdev.yaml
git commit -m "Increase Traefik resource limits for local dev"
git push
```

### Example: Add New Application

**Step 1**: Create Helm template

```bash
vim charts/applications/templates/nginx-demo.yaml
```

```yaml
{{- if .Values.nginxDemo.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-demo
  namespace: {{ .Values.nginxDemo.namespace | default "demo" }}
spec:
  replicas: {{ .Values.nginxDemo.replicas | default 1 }}
  selector:
    matchLabels:
      app: nginx-demo
  template:
    metadata:
      labels:
        app: nginx-demo
    spec:
      containers:
        - name: nginx
          image: nginx:{{ .Values.nginxDemo.version | default "latest" }}
          ports:
            - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: nginx-demo
  namespace: {{ .Values.nginxDemo.namespace | default "demo" }}
spec:
  selector:
    app: nginx-demo
  ports:
    - port: 80
      targetPort: 80
{{- end }}
```

**Step 2**: Enable in values

```bash
vim charts/applications/values-localdev.yaml
```

```yaml
nginxDemo:
  enabled: true
  namespace: demo
  replicas: 1
  version: "1.25"
```

**Step 3**: Tilt auto-deploys

**Step 4**: Verify

```bash
kubectl get pods -n demo
kubectl port-forward -n demo svc/nginx-demo 8888:80

# Visit http://localhost:8888
```

---

## Testing Strategies

### Unit Testing (Helm Charts)

**Test chart rendering**:

```bash
# Render chart with values
helm template charts/addons \
  --values charts/addons/values.yaml \
  --values charts/addons/values-localdev.yaml

# Check for errors
helm lint charts/addons

# Validate against Kubernetes API
helm template charts/addons \
  --values charts/addons/values-localdev.yaml | \
  kubectl apply --dry-run=client -f -
```

### Integration Testing (Tilt)

**Test in live cluster**:

```bash
# Start Tilt
tilt up

# Deploy specific resource
tilt trigger traefik

# Run smoke tests
kubectl run -it --rm curl --image=curlimages/curl --restart=Never -- \
  curl http://traefik.traefik.svc.cluster.local

# Check resource health
kubectl get pods -A
kubectl get ingress -A
```

### End-to-End Testing

**Test complete flow**:

```bash
# Deploy full stack
task localdev:up

# Wait for ready
kubectl wait --for=condition=ready pod -l app=traefik -n traefik --timeout=300s

# Test Ingress
curl -H "Host: demo.local" http://localhost:9080

# Cleanup
task localdev:down
```

### CI Testing (GitHub Actions)

See [CI Integration](#ci-integration) section.

---

## Debugging

### Tilt UI

**Access**: http://localhost:10350

**Features**:
- Real-time logs for all resources
- Build status and errors
- Resource dependency graph
- Manual triggers for rebuilds

**Common Tasks**:

```bash
# View resource logs
# Click resource → Logs tab

# Trigger manual rebuild
# Click resource → Trigger Update button

# View all resources
# Main dashboard shows status of all resources
```

### Kubectl Debugging

**Check pod status**:

```bash
# List all pods
kubectl get pods -A

# Describe pod
kubectl describe pod -n traefik traefik-xxx

# View logs
kubectl logs -n traefik traefik-xxx

# Follow logs
kubectl logs -n traefik traefik-xxx -f

# Previous container logs (if crashed)
kubectl logs -n traefik traefik-xxx --previous
```

**Interactive debugging**:

```bash
# Exec into pod
kubectl exec -it -n traefik traefik-xxx -- sh

# Run debug pod
kubectl run -it --rm debug --image=nicolaka/netshoot --restart=Never -- bash

# Inside debug pod:
nslookup traefik.traefik.svc.cluster.local
curl http://traefik.traefik.svc.cluster.local
ping 8.8.8.8
```

**Port forwarding**:

```bash
# Forward pod port to localhost
kubectl port-forward -n traefik svc/traefik 9080:80

# Access: http://localhost:9080

# Forward multiple ports
kubectl port-forward -n monitoring svc/grafana 3000:80 &
kubectl port-forward -n traefik svc/traefik 9080:80 &
```

### Helm Debugging

**Check chart values**:

```bash
# Show computed values
helm get values traefik -n traefik

# Show all values (including defaults)
helm get values traefik -n traefik --all

# Dry-run install to see rendered manifests
helm template my-release charts/addons \
  --values charts/addons/values-localdev.yaml \
  --debug
```

### Common Issues

**Issue: Pods stuck in Pending**

```bash
# Check events
kubectl get events -n traefik --sort-by='.lastTimestamp'

# Check PVC status
kubectl get pvc -n traefik

# Check node resources
kubectl describe nodes
```

**Issue: Tilt not detecting changes**

```bash
# Check Tiltfile syntax
tilt ci  # (runs in headless mode, catches errors)

# Check file watch patterns
# Edit Tiltfile, look for watch_file() calls

# Restart Tilt
tilt down
tilt up
```

**Issue: Kind cluster out of resources**

```bash
# Check Docker resources
docker stats

# Increase Docker Desktop resources:
# Settings → Resources → Increase CPU/Memory

# Restart cluster
kind delete cluster --name homelab
kind create cluster --config localdev/kind-config.yaml --name homelab
```

---

## CI Integration

### GitHub Actions Workflow

**File**: `.github/workflows/tilt-ci.yml`

```yaml
name: Tilt CI

on:
  pull_request:
    paths:
      - 'charts/**'
      - 'localdev/**'
      - 'Tiltfile'

jobs:
  tilt-ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Kind
        uses: helm/kind-action@v1
        with:
          version: v0.22.0
          cluster_name: homelab

      - name: Install Tilt
        run: |
          curl -fsSL https://github.com/tilt-dev/tilt/releases/download/v0.33.11/tilt.0.33.11.linux.x86_64.tar.gz | \
          tar -xzv tilt && \
          sudo mv tilt /usr/local/bin/tilt

      - name: Run Tilt CI
        run: |
          cd localdev
          tilt ci

      - name: Check cluster health
        run: |
          kubectl get pods -A
          kubectl get nodes
```

### Manual CI Testing

**Run locally**:

```bash
# Simulate CI environment
kind delete cluster --name homelab
kind create cluster --config localdev/kind-config.yaml --name homelab

cd localdev
tilt ci  # Runs in headless mode, exits after deploy

# Check results
kubectl get pods -A
```

---

## Troubleshooting

### Tilt Issues

**Symptom**: Tilt UI shows "error" status

**Diagnosis**:

```bash
# Check Tilt logs
tilt logs

# Check resource logs in UI
# http://localhost:10350 → Click resource → Logs

# Check Tiltfile syntax
tilt ci
```

**Resolution**:
- Fix syntax errors in Tiltfile
- Check Helm chart templates for errors
- Verify values files are valid YAML

### Kind Cluster Issues

**Symptom**: Cannot create cluster

**Diagnosis**:

```bash
# Check Docker
docker ps

# Check Kind logs
kind create cluster --config localdev/kind-config.yaml --name homelab --verbosity=9999
```

**Resolution**:
- Restart Docker Desktop
- Delete and recreate cluster
- Check Docker resource limits

### Storage Issues

**Symptom**: PVCs stuck in Pending

**Diagnosis**:

```bash
# Check storage class
kubectl get storageclass

# Check local-path-provisioner
kubectl -n local-path-storage get pods
kubectl -n local-path-storage logs -l app=local-path-provisioner
```

**Resolution**:

```bash
# Reinstall local-path-provisioner
kubectl delete -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.26/deploy/local-path-storage.yaml
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.26/deploy/local-path-storage.yaml
```

### Performance Issues

**Symptom**: Slow rebuild/redeploy times

**Diagnosis**:

```bash
# Check Docker resources
docker stats

# Check file watch performance
# (macOS/Windows may be slow with large file trees)
```

**Resolution**:
- Increase Docker Desktop CPU/memory allocation
- Use `.tiltignore` to exclude large directories
- Disable auto-reload for large charts:
  ```python
  # In Tiltfile
  trigger_mode=TRIGGER_MODE_MANUAL
  ```

---

## References

### Official Documentation

- [Kind Documentation](https://kind.sigs.k8s.io/)
- [Tilt Documentation](https://docs.tilt.dev/)
- [Helm Documentation](https://helm.sh/docs/)
- [Taskfile Documentation](https://taskfile.dev/)

### Guides

- [Tilt Tutorial](https://docs.tilt.dev/tutorial.html)
- [Kubernetes Local Development Best Practices](https://kubernetes.io/docs/tasks/debug/debug-cluster/local-debugging/)

### Related Documentation

- [architecture.md](./architecture.md) - Architecture overview
- [disaster-recovery.md](./disaster-recovery.md) - Backup procedures
- [networking.md](./networking.md) - Network configuration

### Tilt Resources

- [Tiltfile API Reference](https://docs.tilt.dev/api.html)
- [Tilt Extensions](https://github.com/tilt-dev/tilt-extensions)
- [Tilt Community](https://tilt.dev/community)

---

**Last Updated**: 2026-01-19
**Version**: 1.0
**Maintainer**: homelab team
