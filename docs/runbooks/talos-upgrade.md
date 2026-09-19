# Talos Linux Cluster Upgrade Runbook

Upgrading the Talos OS and Kubernetes on the homelab cluster, recovering from a failed
upgrade, and validating the result.

Every address is a `<KEY>` placeholder resolved from the gitignored
`configuration/environments/homelab.yaml` (`task config:eval` prints them): `<CP_VIP>`,
`<CP1_IP>`, `<CP2_IP>`, `<CP3_IP>`, `<WORKER1_IP>`, `<WORKER2_IP>`, `<WORKER3_IP>`. The
cluster is **three control planes and three workers**; `worker-1` carries the Intel GPU.

Agents never run any of this: every step mutates production (ADR-009). An agent may run
the read-only checks in [Validation](#validation) and `task apiserver:probe`.

## Table of Contents

- [Overview](#overview)
- [Where the versions live](#where-the-versions-live)
- [Pre-Upgrade Preparation](#pre-upgrade-preparation)
- [Upgrade Procedures](#upgrade-procedures)
- [Emergency Recovery](#emergency-recovery)
- [Validation](#validation)
- [Rollback Procedures](#rollback-procedures)
- [Troubleshooting](#troubleshooting)
- [References](#references)

---

## Overview

| Upgrade Type | Risk | Downtime |
|--------------|------|----------|
| Talos patch version | Low | Rolling, none |
| Talos minor version | Medium | Rolling, none |
| Kubernetes patch | Low | Rolling, none |
| Kubernetes minor | Medium | Rolling, brief API blips |

Upgrade one minor version at a time and check the
[Talos support matrix](https://www.talos.dev/latest/introduction/support-matrix/) for the
Kubernetes versions each Talos release supports.

## Where the versions live

| What | Where | Notes |
|------|-------|-------|
| Registry (Renovate target) | `configuration/versions.yaml` `tools.talos`, `tools.kubernetes` | Single source of truth for pins; Renovate bumps only this file |
| What the cluster runs | `terragrunt/environments/homelab/env.hcl` `talos_version`, `kubernetes_version` | Consumed by the `talos-cluster` and `talos-image*` units |
| Installer images | `terragrunt/environments/homelab/talos-image`, `talos-image-gpu`, `talos-image-gpu-intel` | Image Factory schematics from `talos/image/schematic*.yaml`; output `factory.talos.dev/installer/<schematic_id>:<talos_version>` |
| Machine config patches | `terragrunt/environments/homelab/talos-cluster/terragrunt.hcl` | etcd `extraArgs`, GPU patch, CSI patches from `talos/patches/` |

`versions.yaml` is the **target** (Renovate bumps it); `env.hcl` is what the cluster runs.
Level 0's `versions/pins` check fails when the two disagree unless the lag is registered with
a reason under `pins:` in `tests/gitops/version-drift.yaml` (file, key, the running revision).
The entry fails again the moment `env.hcl` moves, so each upgrade step updates `env.hcl` and
the registered revision together, and the last step deletes the entry. The current plan is
`docs/plans/2026-09-17-talos-kubernetes-upgrade.md`.

```bash
task verify:text | rg versions/pins
```

---

## Pre-Upgrade Preparation

### Step 1: Verify Current State

```bash
# Talos version on every node
talosctl -n <CP1_IP>,<CP2_IP>,<CP3_IP>,<WORKER1_IP>,<WORKER2_IP>,<WORKER3_IP> version

# Kubernetes version and node status
kubectl version
kubectl get nodes -o wide

# etcd quorum (three members expected)
talosctl -n <CP1_IP> etcd members
talosctl -n <CP1_IP> etcd status

# API reachability through the VIP and each control plane side by side (read-only)
task apiserver:probe
```

### Step 2: Backup etcd

**Critical**: always snapshot etcd before an upgrade.

```bash
talosctl -n <CP1_IP> etcd snapshot ./etcd-backup-$(date +%Y%m%d-%H%M%S).db
ls -lh etcd-backup-*.db
```

Copy the snapshot somewhere off the cluster (TrueNAS or the workstation). The
CloudNativePG data (Paperclip) has its own backup path; see `docs/runbooks/verification.md`
and the restore drill (`task drill:restore`).

### Step 3: Check Cluster Health

```bash
kubectl get pods -A | rg -v 'Running|Completed'
kubectl get pvc -A | rg -v Bound
kubectl get events -A --sort-by='.lastTimestamp' | tail -20
kubectl -n argocd get applications | rg -v 'Synced.*Healthy'
```

The control planes keep etcd on the dedicated `cp-storage` NVMe pool; if `talosctl -n <CP1_IP>
logs etcd | rg "slow fdatasync"` shows stalls before you start, read
[control-plane-storage.md](./control-plane-storage.md) first.

### Step 4: Prepare Rollback Plan

- [ ] etcd snapshot taken and copied off the cluster
- [ ] Current Talos and Kubernetes versions noted (`talosctl version`, `kubectl version`)
- [ ] Previous installer image tag noted (`talosctl -n <CP1_IP> get machineconfig -o yaml | rg image:`)
- [ ] Low-usage window chosen; household informed

---

## Upgrade Procedures

### Procedure 1: Upgrade Talos through Terragrunt (recommended)

Declarative and repeatable: the image units build a new Image Factory installer, the
cluster unit rolls it out.

```bash
# 1. Bump the versions
#    configuration/versions.yaml  tools.talos (Renovate usually does this)
#    terragrunt/environments/homelab/env.hcl  talos_version

# 2. Rebuild the installer images (one unit per schematic)
task talos:upgrade:image                                   # talos-image
task tf:apply:component COMPONENT=talos-image-gpu          # NVIDIA schematic (historical)
task tf:apply:component COMPONENT=talos-image-gpu-intel    # Intel schematic (worker-1)

# 3. Plan, then apply the cluster unit
task tf:plan:component COMPONENT=talos-cluster
task tf:apply:component COMPONENT=talos-cluster

# 4. Verify
talosctl -n <CP1_IP>,<CP2_IP>,<CP3_IP>,<WORKER1_IP>,<WORKER2_IP>,<WORKER3_IP> version
kubectl get nodes
```

Every `task tf:*` command runs through `op run` with `.env.op`, so the Proxmox and Talos
credentials come from 1Password; never call `terragrunt` by hand.

### Procedure 2: Upgrade Talos with talosctl (manual, one node at a time)

Use the installer image the image unit produced (`task tf:output` in
`terragrunt/environments/homelab/talos-image*`), not a generic `ghcr.io/siderolabs/installer`
tag: the homelab images carry the QEMU guest agent, iSCSI/NFS tools and the GPU extensions.

```bash
IMG=factory.talos.dev/installer/<schematic_id>:<talos_version>

# 1. Control planes, one at a time; wait for health between nodes
for n in <CP1_IP> <CP2_IP> <CP3_IP>; do
  talosctl -n "$n" upgrade --image "$IMG" --preserve
  talosctl -n "$n" health --wait-timeout 15m
  kubectl get nodes
done

# 2. Workers, one at a time (worker-1 uses the Intel schematic image)
talosctl -n <WORKER1_IP> upgrade --image "$IMG_INTEL" --preserve
talosctl -n <WORKER1_IP> health --wait-timeout 15m
talosctl -n <WORKER2_IP> upgrade --image "$IMG" --preserve
talosctl -n <WORKER2_IP> health --wait-timeout 15m
talosctl -n <WORKER3_IP> upgrade --image "$IMG" --preserve
talosctl -n <WORKER3_IP> health --wait-timeout 15m

# 3. Verify
talosctl -n <CP1_IP>,<CP2_IP>,<CP3_IP>,<WORKER1_IP>,<WORKER2_IP>,<WORKER3_IP> version
kubectl get nodes
kubectl get pods -A | rg -v 'Running|Completed'
```

Each node reboots once; pods reschedule onto the remaining nodes. With three control
planes etcd keeps quorum while one member is down, and the layer-2 VIP moves to a healthy
control plane.

### Procedure 3: Upgrade Kubernetes

```bash
# Bump configuration/versions.yaml tools.kubernetes and env.hcl kubernetes_version first
talosctl -n <CP1_IP> upgrade-k8s --to <kubernetes_version>

# Watch it roll the control plane components, then the kubelets
kubectl get nodes -w

# Verify
kubectl version
kubectl get pods -A | rg -v 'Running|Completed'
kubectl get --raw /metrics | rg apiserver_requested_deprecated_apis
```

`upgrade-k8s` talks to one control plane and upgrades every node itself; expect short API
server unavailability while each control plane restarts. Run `task apiserver:probe`
afterwards to confirm the VIP and each control plane answer.

### Procedure 4: Recreate a node instead of upgrading it

When a node is wedged, or after a schematic change that a `--preserve` upgrade cannot apply,
recreate the VM from Terragrunt:

```bash
task talos:recreate:node NODE=worker-2          # taint + apply for one VM
task talos:recreate:gpu-node                     # worker-1, then `homelab verify gpu`
```

---

## Emergency Recovery

### Scenario 1: etcd Quorum Lost

Three members; quorum survives one failure. With two members down the API is gone.

```bash
# 1. Which members are up?
talosctl -n <CP1_IP> etcd members
talosctl -n <CP2_IP> etcd members
talosctl -n <CP3_IP> etcd members

# 2. If a single healthy member remains, bring the others back before anything else:
#    reboot them (Proxmox console or `talosctl -n <ip> reboot`) and wait for them to rejoin.

# 3. Only if every member is lost: restore the snapshot on one control plane
talosctl -n <CP1_IP> bootstrap --recover-from ./etcd-backup-<stamp>.db
talosctl -n <CP1_IP> health --wait-timeout 15m

# 4. Let the other two rejoin, then verify
talosctl -n <CP1_IP> etcd members
```

### Scenario 2: Control Plane Node Won't Start After Upgrade

```bash
talosctl -n <CP1_IP> dmesg | tail -50
talosctl -n <CP1_IP> services
talosctl -n <CP1_IP> logs etcd

# Roll that node back to the previous installer image
talosctl -n <CP1_IP> upgrade --image factory.talos.dev/installer/<schematic_id>:<previous_talos_version> --preserve

# If it will not come back, recreate the VM from Terragrunt
task talos:recreate:node NODE=cp-1
```

### Scenario 3: Complete Cluster Failure

Rebuild from Terragrunt and let ArgoCD restore every workload from Git; see
[disaster-recovery.md](../disaster-recovery.md).

---

## Validation

### Post-Upgrade Checklist

**Cluster**

- [ ] Every node Ready: `kubectl get nodes`
- [ ] No pod outside Running/Completed: `kubectl get pods -A | rg -v 'Running|Completed'`
- [ ] Three etcd members, no `slow fdatasync`: `talosctl -n <CP1_IP> etcd members`, `talosctl -n <CP1_IP> logs etcd | rg "slow fdatasync"`
- [ ] VIP and every control plane answer: `task apiserver:probe`

**GitOps**

- [ ] Every Application Synced and Healthy: `task prod:status` (read-only context) or `kubectl -n argocd get applications`
- [ ] Ingress answers: `curl -I https://plex.<DOMAIN>`
- [ ] PVCs Bound: `kubectl get pvc -A`
- [ ] LoadBalancer Services have addresses: `kubectl get svc -A | rg LoadBalancer`

**Network**

- [ ] BGP sessions established: `kubectl -n kube-system exec ds/cilium -- cilium bgp peers`
- [ ] In-cluster DNS: `kubectl run -it --rm dns --image=nicolaka/netshoot --restart=Never -- nslookup kubernetes.default.svc.cluster.local`

**GPU (worker-1)**

- [ ] `task gpu:verify` (`homelab verify gpu`, vendor from `GPU_VENDOR`)

### Validation Commands

```bash
talosctl -n <CP1_IP> health --server=false
talosctl -n <CP1_IP>,<CP2_IP>,<CP3_IP>,<WORKER1_IP>,<WORKER2_IP>,<WORKER3_IP> services
talosctl -n <CP1_IP> etcd status
kubectl -n kube-system get pods -l k8s-app=cilium
kubectl -n kube-system exec ds/cilium -- cilium status
```

---

## Rollback Procedures

### Rollback Talos

```bash
# Previous installer image from Step 4 of the preparation
talosctl -n <CP1_IP> upgrade --image factory.talos.dev/installer/<schematic_id>:<previous_talos_version> --preserve
talosctl -n <CP1_IP> health --wait-timeout 15m
# repeat per node: control planes first, then workers
```

If the rollback came from Terragrunt, revert `env.hcl` and `versions.yaml` and re-apply
`talos-image*` and `talos-cluster` (Procedure 1) so the state matches the running cluster.

### Rollback Kubernetes

Kubernetes downgrades are not supported. Restore the pre-upgrade etcd snapshot
(Scenario 1, step 3) and re-run the upgrade once the cause is fixed.

---

## Troubleshooting

### Node Stuck "Upgrading"

```bash
talosctl -n <WORKER2_IP> dmesg | tail -50
talosctl -n <WORKER2_IP> services
talosctl -n <WORKER2_IP> reboot
# last resort: wipe and re-provision from Terragrunt
task talos:recreate:node NODE=worker-2
```

### Pods Not Scheduling After Upgrade

```bash
kubectl describe node <node>
kubectl get nodes -o json | jq '.items[].spec.taints'
kubectl describe pod <pod> -n <namespace>
```

`worker-1` carries the soft taint `intel.com/gpu=true:PreferNoSchedule` by design
(`talos/patches/gpu-passthrough-intel.yaml`); do not remove it.

### etcd Unhealthy After Upgrade

```bash
talosctl -n <CP1_IP> etcd members
talosctl -n <CP1_IP> etcd status
talosctl -n <CP1_IP> logs etcd | rg -i 'slow fdatasync|leader|error'
talosctl -n <CP1_IP> service etcd restart
```

Persistent `slow fdatasync` means the control-plane disk is contended again; see
[control-plane-storage.md](./control-plane-storage.md#diagnose-a-recurrence).

### Cilium Not Working

Cilium is installed by the `cilium` ArgoCD Application (`charts/addons/templates/cilium.yaml`),
not from a file you apply by hand.

```bash
kubectl -n kube-system get pods -l k8s-app=cilium
kubectl -n kube-system exec ds/cilium -- cilium status
kubectl -n kube-system rollout restart ds/cilium
kubectl -n argocd get application cilium
```

---

## References

- [Talos upgrade guide](https://www.talos.dev/latest/talos-guides/upgrading-talos/) and
  [support matrix](https://www.talos.dev/latest/introduction/support-matrix/)
- [Kubernetes version skew policy](https://kubernetes.io/releases/version-skew-policy/)
- [etcd disaster recovery](https://etcd.io/docs/latest/op-guide/recovery/)
- [control-plane-storage.md](./control-plane-storage.md), [proxmox-recovery.md](./proxmox-recovery.md),
  [truenas-maintenance.md](./truenas-maintenance.md), [readonly-access.md](./readonly-access.md)
- [architecture.md](../architecture.md), [disaster-recovery.md](../disaster-recovery.md),
  [networking.md](../networking.md)

## Appendix: Quick Reference

```bash
talosctl -n <node> version | health | services | dmesg | reboot | shutdown
talosctl -n <node> upgrade --image <installer image> --preserve
talosctl -n <cp> etcd members | status | snapshot <file> | forfeit-leadership
talosctl -n <cp> upgrade-k8s --to <version>
task apiserver:probe                          # read-only VIP + per-control-plane probe
task talos:recreate:node NODE=<name>          # destroy and recreate one VM
```
