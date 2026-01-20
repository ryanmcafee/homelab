# Talos Linux Cluster Upgrade Runbook

This runbook provides step-by-step procedures for upgrading Talos Linux nodes, Kubernetes versions, and recovering from cluster failures.

## Table of Contents

- [Overview](#overview)
- [Pre-Upgrade Preparation](#pre-upgrade-preparation)
- [Upgrade Procedures](#upgrade-procedures)
- [Emergency Recovery](#emergency-recovery)
- [Validation](#validation)
- [Rollback Procedures](#rollback-procedures)
- [Troubleshooting](#troubleshooting)
- [References](#references)

---

## Overview

### Upgrade Types

| Upgrade Type | Frequency | Risk Level | Downtime |
|--------------|-----------|------------|----------|
| Talos patch version | Monthly | Low | Rolling (0 downtime) |
| Talos minor version | Quarterly | Medium | Rolling (0 downtime) |
| Talos major version | Annually | High | Brief (minutes) |
| Kubernetes patch | As needed | Low | Rolling (0 downtime) |
| Kubernetes minor | Quarterly | Medium | Rolling (0 downtime) |
| Kubernetes major | Annually | High | Brief (minutes) |

### Version Compatibility

**Current Versions**:
- Talos: 1.7.x
- Kubernetes: 1.30.x

**Upgrade Path** (one minor version at a time):
- Talos 1.7.x → 1.8.x → 1.9.x
- Kubernetes 1.30.x → 1.31.x → 1.32.x

**Compatibility Matrix**: https://www.talos.dev/latest/introduction/support-matrix/

---

## Pre-Upgrade Preparation

### Step 1: Verify Current State

```bash
# Check Talos version on all nodes
talosctl -n 172.16.100.51,172.16.100.52,172.16.100.53,172.16.100.54,172.16.100.55 version

# Check Kubernetes version
kubectl version

# Check node status
kubectl get nodes -o wide

# Check etcd health
talosctl -n 172.16.100.51 etcd members
```

### Step 2: Backup etcd

**Critical**: Always backup etcd before upgrades

```bash
# Create etcd snapshot
talosctl -n 172.16.100.51 etcd snapshot /var/lib/etcd-backup-$(date +%Y%m%d-%H%M%S).db

# Copy snapshot to local machine
talosctl -n 172.16.100.51 cp /var/lib/etcd-backup-*.db ./

# Upload to TrueNAS
scp etcd-backup-*.db root@truenas:/mnt/tank/backups/kubernetes/etcd/

# Verify snapshot
ls -lh etcd-backup-*.db
```

### Step 3: Backup Kubernetes Resources

```bash
# Backup all Kubernetes resources
kubectl get all -A -o yaml > k8s-backup-$(date +%Y%m%d).yaml

# Backup specific namespaces
kubectl get all -n media -o yaml > media-backup-$(date +%Y%m%d).yaml

# Backup CRDs
kubectl get crd -o yaml > crd-backup-$(date +%Y%m%d).yaml

# Upload backups
scp *-backup-*.yaml root@truenas:/mnt/tank/backups/kubernetes/
```

### Step 4: Check Cluster Health

```bash
# Check all pods are running
kubectl get pods -A | grep -v Running

# Check PVCs are bound
kubectl get pvc -A | grep -v Bound

# Check cluster events
kubectl get events -A --sort-by='.lastTimestamp' | tail -20

# Run conformance test (optional, time-consuming)
# sonobuoy run --wait
```

### Step 5: Notify Stakeholders

- [ ] Inform family members of potential service interruption
- [ ] Schedule upgrade during low-usage window
- [ ] Document upgrade start time

### Step 6: Prepare Rollback Plan

- [ ] etcd backup created
- [ ] K8s resource backup created
- [ ] Previous Talos version documented
- [ ] Previous K8s version documented
- [ ] Rollback procedure reviewed

---

## Upgrade Procedures

### Procedure 1: Upgrade Talos (Patch Version)

**Example**: 1.7.0 → 1.7.1

**Risk**: Low
**Downtime**: None (rolling upgrade)

**Steps**:

```bash
# 1. Upgrade control plane nodes ONE AT A TIME
talosctl -n 172.16.100.51 upgrade --image ghcr.io/siderolabs/installer:v1.7.1 --preserve

# Wait for node to complete upgrade (5-10 minutes)
talosctl -n 172.16.100.51 health --wait-timeout 15m

# Verify node is ready
kubectl get nodes

# Repeat for second control plane node
talosctl -n 172.16.100.52 upgrade --image ghcr.io/siderolabs/installer:v1.7.1 --preserve
talosctl -n 172.16.100.52 health --wait-timeout 15m

# 2. Upgrade worker nodes ONE AT A TIME
talosctl -n 172.16.100.53 upgrade --image ghcr.io/siderolabs/installer:v1.7.1 --preserve
talosctl -n 172.16.100.53 health --wait-timeout 15m

talosctl -n 172.16.100.54 upgrade --image ghcr.io/siderolabs/installer:v1.7.1 --preserve
talosctl -n 172.16.100.54 health --wait-timeout 15m

talosctl -n 172.16.100.55 upgrade --image ghcr.io/siderolabs/installer:v1.7.1 --preserve
talosctl -n 172.16.100.55 health --wait-timeout 15m

# 3. Verify all nodes upgraded
talosctl -n 172.16.100.51,172.16.100.52,172.16.100.53,172.16.100.54,172.16.100.55 version

# 4. Verify cluster health
kubectl get nodes
kubectl get pods -A
```

**Expected Behavior**:
- Each node reboots during upgrade
- Pods automatically migrate to healthy nodes
- No service interruption for replicated workloads

**RTO**: 30-60 minutes (entire cluster)

---

### Procedure 2: Upgrade Talos (Minor/Major Version)

**Example**: 1.7.x → 1.8.x

**Risk**: Medium
**Downtime**: Brief (seconds to minutes)

**Additional Steps**:

```bash
# 1. Review release notes
# https://github.com/siderolabs/talos/releases

# 2. Update Talos machine config if needed
# Check for breaking changes or new required fields

# Edit machine configs
vim talos/machine-config/controlplane.yaml.tpl
vim talos/machine-config/worker.yaml.tpl

# 3. Generate new machine configs
talosctl gen config homelab https://172.16.100.51:6443 \
  --config-patch @talos/patches/controlplane-patch.yaml \
  --output-types controlplane -o controlplane.yaml

# 4. Apply config changes (if needed)
talosctl -n 172.16.100.51 apply-config --file controlplane.yaml

# 5. Follow Procedure 1 for upgrade
```

**RTO**: 1-2 hours

---

### Procedure 3: Upgrade Kubernetes

**Example**: 1.30.x → 1.31.x

**Risk**: Medium
**Downtime**: None (rolling upgrade)

**Prerequisites**:
- Talos version supports target Kubernetes version
- Check compatibility: https://www.talos.dev/latest/introduction/support-matrix/

**Steps**:

```bash
# 1. Upgrade Kubernetes via talosctl
talosctl -n 172.16.100.51 upgrade-k8s --to 1.31.0

# This command:
# - Upgrades control plane components
# - Upgrades kubelet on all nodes
# - Performs rolling upgrade (no downtime)
# - Waits for each component to be healthy

# Monitor progress
talosctl -n 172.16.100.51 upgrade-k8s --to 1.31.0 --verbose

# 2. Verify upgrade
kubectl version
kubectl get nodes

# 3. Verify all pods are running
kubectl get pods -A

# 4. Check for deprecated API usage
kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis
```

**Expected Behavior**:
- Control plane components upgrade first
- Worker nodes upgrade one at a time
- Pods may be evicted and rescheduled
- Short API server unavailability (< 30 seconds)

**RTO**: 45-90 minutes

---

### Procedure 4: Upgrade via Terragrunt (Recommended)

**Benefit**: Declarative, version-controlled, repeatable

**Steps**:

```bash
# 1. Update Talos version in Terragrunt
cd homelab/terragrunt/environments/homelab/talos-cluster

# Edit terragrunt.hcl
vim terragrunt.hcl
```

```hcl
locals {
  talos_version = "v1.7.1"  # Updated from v1.7.0
  kubernetes_version = "v1.31.0"  # Updated from v1.30.0
}
```

```bash
# 2. Review plan
terragrunt plan

# 3. Apply changes
terragrunt apply

# This will:
# - Generate new Talos machine configs
# - Upgrade all nodes (rolling)
# - Upgrade Kubernetes
# - Wait for health checks

# 4. Verify
kubectl get nodes
talosctl version
```

**RTO**: 1-2 hours

---

## Emergency Recovery

### Scenario 1: etcd Quorum Lost

**Symptoms**: Cannot access Kubernetes API, etcd members unreachable

**Recovery**:

```bash
# 1. Check etcd status
talosctl -n 172.16.100.51 etcd members

# If majority of nodes are down, etcd quorum is lost

# 2. Restore from etcd backup
# Download latest backup
scp root@truenas:/mnt/tank/backups/kubernetes/etcd/etcd-backup-latest.db ./

# 3. Stop all control plane nodes
talosctl -n 172.16.100.51 shutdown
talosctl -n 172.16.100.52 shutdown

# 4. Bootstrap first control plane node with backup
# This requires console access or recovery mode
talosctl -n 172.16.100.51 bootstrap --recover-from /path/to/etcd-backup.db

# 5. Start second control plane node
# Boot normally, it will join cluster

# 6. Verify etcd health
talosctl -n 172.16.100.51 etcd members
```

**RTO**: 2-4 hours

---

### Scenario 2: Control Plane Node Won't Start After Upgrade

**Symptoms**: Node stuck in boot loop or fails health checks

**Recovery**:

```bash
# 1. Check node logs
talosctl -n 172.16.100.51 logs

# 2. Check service status
talosctl -n 172.16.100.51 services

# 3. Rollback to previous version
talosctl -n 172.16.100.51 upgrade --image ghcr.io/siderolabs/installer:v1.7.0 --preserve

# 4. If rollback fails, reset and re-provision
talosctl -n 172.16.100.51 reset --graceful=false --reboot

# 5. Re-apply machine config
talosctl -n 172.16.100.51 apply-config --insecure --nodes 172.16.100.51 --file controlplane.yaml
```

**RTO**: 1-2 hours

---

### Scenario 3: Complete Cluster Failure

**Symptoms**: All nodes down, cluster unrecoverable

**Recovery**:

**Full cluster rebuild** - see [disaster-recovery.md](../disaster-recovery.md#scenario-5-complete-cluster-loss)

**High-level steps**:

1. Destroy existing cluster
2. Provision new cluster via Terragrunt
3. Restore etcd from backup
4. ArgoCD re-deploys applications from Git
5. Restore PVC data from Velero backups

**RTO**: 4-6 hours

---

## Validation

### Post-Upgrade Checklist

After any upgrade:

**Cluster Health**:
- [ ] All nodes in Ready state: `kubectl get nodes`
- [ ] All pods in Running state: `kubectl get pods -A`
- [ ] etcd healthy: `talosctl etcd members`
- [ ] API server responsive: `kubectl version`

**Application Health**:
- [ ] ArgoCD syncing: `kubectl get applications -n argocd`
- [ ] Ingress working: `curl http://plex.ryanmcafee.com`
- [ ] Persistent volumes bound: `kubectl get pvc -A`
- [ ] Services have IPs: `kubectl get svc -A`

**Monitoring**:
- [ ] Prometheus scraping: Check Grafana dashboards
- [ ] No critical alerts: Check Alertmanager
- [ ] Metrics flowing: Check Prometheus targets

**Network**:
- [ ] BGP peering up: Check MetalLB speaker logs
- [ ] DNS resolving: `nslookup plex.media.svc.cluster.local`
- [ ] Pods can reach internet: `kubectl run -it --rm curl --image=curlimages/curl --restart=Never -- curl https://google.com`

### Validation Commands

```bash
# Comprehensive health check
talosctl -n 172.16.100.51 health --server=false

# Check Talos services
talosctl -n 172.16.100.51,172.16.100.52,172.16.100.53,172.16.100.54,172.16.100.55 services

# Check Kubernetes components
kubectl get componentstatuses

# Check etcd
talosctl -n 172.16.100.51 etcd members
talosctl -n 172.16.100.51 etcd status

# Check CNI (Cilium)
kubectl -n kube-system get pods -l k8s-app=cilium
kubectl -n kube-system exec -it ds/cilium -- cilium status

# Check all resources
kubectl get all -A
```

---

## Rollback Procedures

### Rollback Talos Version

**Scenario**: Upgrade failed or introduced issues

**Procedure**:

```bash
# 1. Identify previous version
# Check etcd backup filename or Git history

# 2. Downgrade each node
talosctl -n 172.16.100.51 upgrade --image ghcr.io/siderolabs/installer:v1.7.0 --preserve

# Wait for health
talosctl -n 172.16.100.51 health --wait-timeout 15m

# 3. Repeat for all nodes (control plane first, then workers)

# 4. Verify
talosctl version
kubectl get nodes
```

**RTO**: 1-2 hours

---

### Rollback Kubernetes Version

**Note**: Kubernetes downgrades are NOT supported. Do not attempt to downgrade Kubernetes.

**Alternative**: Restore cluster from etcd backup taken before upgrade

```bash
# 1. Stop all nodes
talosctl -n <nodes> shutdown

# 2. Bootstrap from pre-upgrade etcd backup
# (Follow etcd restore procedure)

# 3. Verify old Kubernetes version restored
kubectl version
```

**RTO**: 4-6 hours

---

## Troubleshooting

### Issue: Node Stuck "Upgrading"

**Symptoms**: Node shows "Upgrading" status indefinitely

**Diagnosis**:

```bash
# Check upgrade progress
talosctl -n 172.16.100.51 logs

# Check service status
talosctl -n 172.16.100.51 services
```

**Resolution**:

```bash
# Force reboot
talosctl -n 172.16.100.51 reboot

# If still stuck, reset
talosctl -n 172.16.100.51 reset --graceful=false --reboot
```

---

### Issue: Pods Not Scheduling After Upgrade

**Symptoms**: Pods stuck in Pending state

**Diagnosis**:

```bash
# Check node status
kubectl get nodes
kubectl describe node talos-worker-1

# Check pod events
kubectl describe pod <pod-name> -n <namespace>
```

**Resolution**:

```bash
# Check for taints
kubectl get nodes -o json | jq '.items[].spec.taints'

# Remove taints if needed
kubectl taint nodes talos-worker-1 node.kubernetes.io/not-ready:NoSchedule-

# Check resource availability
kubectl top nodes
kubectl top pods -A
```

---

### Issue: etcd Unhealthy After Upgrade

**Symptoms**: etcd members show unhealthy

**Diagnosis**:

```bash
# Check etcd status
talosctl -n 172.16.100.51 etcd members
talosctl -n 172.16.100.51 etcd status

# Check etcd logs
talosctl -n 172.16.100.51 logs | grep etcd
```

**Resolution**:

```bash
# Restart etcd service
talosctl -n 172.16.100.51 service etcd restart

# If that fails, restore from backup
# (See Emergency Recovery - etcd Quorum Lost)
```

---

### Issue: CNI (Cilium) Not Working

**Symptoms**: Pods cannot reach network, DNS not resolving

**Diagnosis**:

```bash
# Check Cilium pods
kubectl -n kube-system get pods -l k8s-app=cilium

# Check Cilium status
kubectl -n kube-system exec -it ds/cilium -- cilium status

# Check Cilium connectivity
kubectl -n kube-system exec -it ds/cilium -- cilium connectivity test
```

**Resolution**:

```bash
# Restart Cilium pods
kubectl -n kube-system rollout restart ds/cilium

# If that fails, reinstall Cilium
kubectl delete -f talos/inline-manifests/cilium-install.yaml
kubectl apply -f talos/inline-manifests/cilium-install.yaml
```

---

## References

### Official Documentation

- [Talos Linux Documentation](https://www.talos.dev/latest/)
- [Talos Upgrade Guide](https://www.talos.dev/latest/talos-guides/upgrading-talos/)
- [Kubernetes Upgrade Guide](https://kubernetes.io/docs/tasks/administer-cluster/cluster-upgrade/)
- [etcd Disaster Recovery](https://etcd.io/docs/latest/op-guide/recovery/)

### Version Compatibility

- [Talos Support Matrix](https://www.talos.dev/latest/introduction/support-matrix/)
- [Kubernetes Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/)

### Related Runbooks

- [proxmox-recovery.md](./proxmox-recovery.md) - Proxmox recovery procedures
- [truenas-maintenance.md](./truenas-maintenance.md) - TrueNAS maintenance

### Related Documentation

- [architecture.md](../architecture.md) - Architecture overview
- [disaster-recovery.md](../disaster-recovery.md) - Complete DR strategy
- [networking.md](../networking.md) - Network configuration

---

**Last Updated**: 2026-01-19
**Version**: 1.0
**Maintainer**: homelab team

---

## Appendix: Quick Reference Commands

### Talos Commands

```bash
# Version
talosctl version
talosctl -n <node> version

# Health check
talosctl -n <node> health

# Service status
talosctl -n <node> services
talosctl -n <node> service <service> status

# Logs
talosctl -n <node> logs
talosctl -n <node> logs -f  # Follow

# Upgrade
talosctl -n <node> upgrade --image <image> --preserve

# Reboot
talosctl -n <node> reboot

# Shutdown
talosctl -n <node> shutdown

# Reset
talosctl -n <node> reset
```

### etcd Commands

```bash
# Members
talosctl -n <cp-node> etcd members

# Status
talosctl -n <cp-node> etcd status

# Snapshot
talosctl -n <cp-node> etcd snapshot /var/lib/etcd-backup.db

# Forfeit leadership (graceful leader change)
talosctl -n <cp-node> etcd forfeit-leadership
```

### Kubernetes Commands

```bash
# Version
kubectl version

# Nodes
kubectl get nodes
kubectl describe node <node>

# Pods
kubectl get pods -A
kubectl describe pod <pod> -n <namespace>

# Events
kubectl get events -A --sort-by='.lastTimestamp'

# Component status
kubectl get componentstatuses
```
