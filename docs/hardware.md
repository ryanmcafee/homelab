# Hardware

The physical host, how it is carved up, and the firmware/BMC settings that took real time to
get right. Provisioning of everything above the metal is in
[architecture.md#provisioning](./architecture.md#provisioning).

Addresses written as `<KEY>` (`<PROXMOX_IP>`, `<IPMI_IP>`, `<GATEWAY_IP>`, `<TRUENAS_IP>`) are
placeholders resolved from the gitignored `configuration/environments/homelab.yaml`.

## Table of Contents

- [Overview](#overview)
- [Virtual machines](#virtual-machines)
- [Storage layout](#storage-layout)
- [PCI passthrough](#pci-passthrough)
- [GPU](#gpu)
- [HBA firmware (mixed mode for U.2 NVMe)](#hba-firmware-mixed-mode-for-u2-nvme)
- [BIOS settings](#bios-settings)
- [IPMI](#ipmi)
- [Network interfaces](#network-interfaces)
- [Power](#power)
- [Troubleshooting](#troubleshooting)
- [References](#references)

---

## Overview

One Supermicro server runs Proxmox VE. Every other component is a VM on it: the TrueNAS
storage appliance with its disk controllers passed through, three Talos control planes,
and three Talos workers (one with the Intel GPU passed through). Node sizing lives in
`terragrunt/environments/homelab/env.hcl` (`control_plane_nodes`, `worker_nodes`).

```
Supermicro chassis, AMD platform (AMD-Vi IOMMU), 256 GB ECC
├─ Proxmox VE on a 250 GB NVMe
├─ ZFS pool vm-storage   2x 1 TB NVMe mirror (Crucial P310)   worker + TrueNAS system disks
├─ ZFS pool cp-storage   1x 1 TB NVMe (Samsung 990 PRO)       control-plane system disks (etcd)
├─ PCI passthrough → TrueNAS VM
│    Broadcom 9400-8i (mixed mode)         U.2 NVMe: TrueNAS pool `ssd` (2x 1 TB)
│    AMD FCH SATA controller #1            8x 20 TB SATA
│    AMD FCH SATA controller #2            3x 20 TB SATA      → TrueNAS pool `storage` (RAIDZ3)
├─ PCI passthrough → worker-1
│    Intel Arc Pro B50 (active, GPU_VENDOR=intel)
│    NVIDIA Quadro P2200 (installed, not in use; historical)
└─ IPMI 1 GbE (<IPMI_IP>), 10 GbE to VLAN 100 (<PROXMOX_IP>)
```

The parts list with part numbers is in the
[Google Sheets parts list](https://docs.google.com/spreadsheets/d/19JLS5aV629NgUacsKQQx_2HI5iXPV7Kn0e5kuBvYOVQ/edit?gid=0#gid=0).

## Virtual machines

| VM | Count | vCPU | RAM | System disk | Datastore | Notes |
|----|-------|------|-----|-------------|-----------|-------|
| Talos control plane `cp-1..3` | 3 | 2 | 8 GB | 50 GB | `cp-storage` | etcd; Talos layer-2 VIP `<CP_VIP>` floats between them |
| Talos `worker-1` | 1 | 8 | 50 GB | 100 GB | `vm-storage` | GPU passthrough, `gpu=true` |
| Talos `worker-2`, `worker-3` | 2 | 4 | 50 GB | 100 GB | `vm-storage` | |
| TrueNAS | 1 | see `terragrunt/environments/homelab/truenas` | | | `vm-storage` | HBA + SATA controllers passed through |

Values are the `env.hcl` locals at the time of writing; the file is authoritative.

## Storage layout

### Proxmox pools

| Pool | Devices | Purpose | Terragrunt unit |
|------|---------|---------|-----------------|
| `vm-storage` | 2x 1 TB NVMe mirror (Crucial CT1000P310SSD8, QLC), `ashift=12` | Worker and TrueNAS system disks | `proxmox-zfs-pool` |
| `cp-storage` | 1x Samsung 990 PRO 1 TB (TLC), single device | Control-plane system disks only; no ISO/backup content | `proxmox-zfs-pool-cp` |
| `local` | Proxmox OS NVMe | ISOs and Talos images | — |

**Why two pools.** The three control-plane disks used to share `vm-storage` with every worker
disk. etcd keeps its write-ahead log on the Talos EPHEMERAL partition of that disk, so one
worker unpacking a large container image pushed etcd `fdatasync` from about 1 ms to tens of
seconds on all three members at once, leases expired, and the VIP moved: the API "went away"
for a while and came back on its own. Moving the control planes to their own NVMe removes
worker I/O from etcd's fsync path. The single device is deliberate (etcd is already
replicated across three nodes; isolation buys more than a mirror of the same class would).
Decision: ADR-016 in `docs/project_notes/decisions.md`; migration, verification and
rollback: [runbooks/control-plane-storage.md](./runbooks/control-plane-storage.md).

### TrueNAS pools

Created by `ansible/playbooks/truenas-full-setup.yml` (role `truenas_storage`):

| Pool | Devices | Serves |
|------|---------|--------|
| `storage` | 11x 20 TB SATA, RAIDZ3 | Media libraries over NFS; `storage/k8s` NFS volumes (`democratic-csi-nfs`); `storage/k8s` iSCSI HDD zvols (`democratic-csi-iscsi-hdd`) |
| `ssd` | 2x 1 TB U.2 NVMe | `ssd/k8s` NFS (`democratic-csi-ssd`); `ssd/iscsi` zvols for SQLite-heavy apps (`democratic-csi-iscsi`, ADR-008) |

Dataset parents are the `TRUENAS_ZONE_PARENT`, `TRUENAS_ZONE_SSD_PARENT`,
`TRUENAS_ISCSI_PARENT` and `TRUENAS_ISCSI_HDD_PARENT` keys in
`configuration/schema/infrastructure.schema.yaml`. Storage classes are described in
[architecture.md#storage](./architecture.md#storage).

## PCI passthrough

Every passthrough device is declared in `terragrunt/environments/homelab/env.hcl` with its
vendor:device ID, subsystem ID and IOMMU group, and mapped by the `talos-cluster` and
`truenas` modules (the Proxmox API token is not root, so the hardware mapping is explicit):

| Device | ID | Goes to | Purpose |
|--------|----|---------|---------|
| Broadcom 9400-8i (LSI SAS3408) | `1000:00af` | TrueNAS | U.2 NVMe in mixed mode |
| AMD FCH SATA controller #1 | `1022:7901` | TrueNAS | 8x 20 TB SATA |
| AMD FCH SATA controller #2 | `1022:7901` | TrueNAS | 3x 20 TB SATA |
| Intel Arc Pro B50 (Battlemage G21) | `8086:e212` | worker-1 | Plex transcoding (`gpu_intel_device`) |
| NVIDIA Quadro P2200 | `10de:1c31` | worker-1 when `gpu_vendor = "nvidia"` | historical |

Verify the groups on the host before changing a mapping:

```bash
for d in /sys/kernel/iommu_groups/*/devices/*; do
    n=${d#*/iommu_groups/*}; n=${n%%/*}
    printf 'IOMMU Group %s ' "$n"; lspci -nns "${d##*/}"
done
```

A device must be alone in its group (or grouped only with its own functions, e.g. a GPU and
its audio controller).

## GPU

`GPU_VENDOR` (`configuration/schema/gpu.schema.yaml`: `none | nvidia | intel`) selects the
whole stack; `terragrunt/environments/homelab/env.hcl` `gpu_vendor` must say the same.

| | Intel (current) | NVIDIA (historical) |
|--|-----------------|---------------------|
| Card | Arc Pro B50 | Quadro P2200 |
| Talos image | `talos-image-gpu-intel` unit, `talos/image/schematic-intel.yaml` (`siderolabs/xe`, `siderolabs/mei`, `i915-ucode`) | `talos-image-gpu`, `talos/image/schematic.yaml` (`nonfree-kmod-nvidia`, `nvidia-container-toolkit`) |
| Machine patch | `gpu_intel_config_patch` in the `talos-cluster` unit (reference copy `talos/patches/gpu-passthrough-intel.yaml`): loads `xe`, labels `intel.com/gpu=true`, soft taint `intel.com/gpu=true:PreferNoSchedule` | `talos/patches/gpu-passthrough.yaml` |
| Kubernetes | `intel-device-plugins-operator` + `intel-gpu-device-plugin` Applications, `node-feature-discovery` | `nvidia-gpu-operator` Application |
| Check | `task gpu:verify` (`homelab verify gpu`, vendor from config) | same |

Flipping the vendor is a `homelab.yaml` + `env.hcl` change followed by
`task talos:recreate:gpu-node` (recreates worker-1 with the other image and runs the check).

Proxmox side, common to both cards: IOMMU on (AMD-Vi is active by default on this platform;
no `intel_iommu=on` needed), `vfio`, `vfio_iommu_type1`, `vfio_pci` in `/etc/modules`, the
card bound to `vfio-pci` by ID in `/etc/modprobe.d/vfio.conf`, `update-initramfs -u -k all`,
reboot, then `lspci -nnk` shows `Kernel driver in use: vfio-pci`. The VM uses `machine: q35`
and `cpu: host`.

## HBA firmware (mixed mode for U.2 NVMe)

The Broadcom 9400-8i only presents NVMe devices after a firmware update that enables mixed
mode; without it the U.2 drives for the `ssd` pool are invisible.

| Cable MPN | Length | From | To |
|-----------|--------|------|----|
| 05-50065-00 | 0.5 m | HBA SFF-8643 | U.2 NVMe SFF-8639 |
| 05-50064-00 | 1.0 m | HBA SFF-8643 | U.2 NVMe SFF-8639 |

Reference: [Broadcom 9400 mixed-mode documentation](https://docs.broadcom.com/doc/12354774).
Flashing (IT mode, then mixed-mode NVDATA) from a UEFI shell with `sas3flash`:

```bash
sas3flash -o -e 7                 # erase
sas3flash -o -f 9400_8i_IT.bin    # IT-mode firmware
sas3flash -o -nvdata mixed.bin    # enable mixed mode (NVMe)
sas3flash -list                   # expect "NVMe Support: Enabled"
```

Day-to-day controller checks run from Proxmox with StorCLI, installed by the
`proxmox_storcli` Ansible role (`ansible/playbooks/proxmox-storcli.yml`, only when
`storcli_package_path` is set); the role also prints firmware versions for both controllers.
The update procedure is [runbooks/hba-firmware-update.md](./runbooks/hba-firmware-update.md).

## BIOS settings

| Area | Setting | Value |
|------|---------|-------|
| Boot | Mode | UEFI, fast boot off, boot device = Proxmox NVMe |
| CPU | Virtualisation (SVM) | Enabled |
| CPU | IOMMU (AMD-Vi) | Enabled |
| CPU | SMT | Enabled |
| Memory | ECC | Enabled |
| PCIe | Above 4G decoding, Re-Size BAR, ARI, SR-IOV | Enabled (large-BAR GPU, clean IOMMU groups) |
| SATA | Mode | AHCI (the onboard controllers are passed through as-is) |
| Power | Restore policy | Last state; Wake on LAN on |

## IPMI

Supermicro BMC on its own 1 GbE port at `<IPMI_IP>`. Change the default `ADMIN` password
first, disable Telnet/SNMP v1-2/plain HTTP, and keep the BMC on a management VLAN.

### Fan thresholds (Noctua fans)

Noctua fans idle below Supermicro's default lower thresholds, so the BMC flags them as failed
and ramps every fan to full speed in a loop. Lower the thresholds:

```bash
ipmitool sensor thresh FAN1 lower 200 300 400
```

Reference: [calvin.me, decrease IPMI fan threshold](https://calvin.me/quick-how-to-decrease-ipmi-fan-threshold/).

The `proxmox_ipmi` Ansible role (`ansible/playbooks/proxmox-ipmi-fans.yml`, part of
`site.yml`) applies the thresholds from `ipmi_fan_thresholds` for every fan, installs
`ipmi-fan-threshold.service` so they survive a BMC reset, and verifies them. Reference
copies of the sensor state and the systemd unit are in `docs/reference-configs/`.

## Network interfaces

| Interface | Speed | Purpose |
|-----------|-------|---------|
| IPMI | 1 GbE | Out-of-band management, `<IPMI_IP>` |
| 10 GbE port 1 | 10 GbE | `vmbr0`, VLAN 100, Proxmox management `<PROXMOX_IP>` and all VM traffic |
| 10 GbE port 2 | 10 GbE | unused |

The bridge is managed by the `proxmox_networking` role (`proxmox-networking.yml`): a
VLAN-aware `vmbr0` with `<PROXMOX_IP>/24` and gateway `<GATEWAY_IP>`. The rest of the
network (BGP, load balancer pool, ingress lanes, Tailscale) is in
[networking.md](./networking.md).

## Power

Two 1200 W Platinum PSUs (one active, one hot spare). Typical draw is a few hundred watts;
a 1500 VA UPS with NUT on Proxmox (`upsmon.conf`, `SHUTDOWNCMD "/sbin/shutdown -h +0"`)
gives a clean shutdown on power loss. Log growth on the host is bounded by the
`proxmox_log_retention` role (`proxmox-log-retention.yml`, journald caps + logrotate).

## Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| No POST | IPMI event log, BMC console | Reseat cards/DIMMs, clear CMOS, update BIOS |
| HBA sees no drives | `lspci \| rg -i sas`, `sas3flash -list`, `storcli /c0 show` | Cables, firmware mode (IT vs mixed), reseat |
| GPU not in the VM | `lspci -nnk \| rg -A3 -i 'nvidia\|arc'` shows `vfio-pci`? IOMMU group clean? | Fix `vfio.conf` IDs, BIOS IOMMU/Above 4G, VM `hostpci` address; then `task gpu:verify` |
| Fans cycling to full speed | `ipmitool sensor list \| rg -i fan` | Re-run `task ansible:apply` (fan thresholds) |
| Overheating / throttling | `sensors`, `ipmitool sensor list` | Dust, airflow, fan curve |
| API drops for seconds, recovers | `talosctl -n <cp> logs etcd \| rg "slow fdatasync"`, `task apiserver:probe` | Control-plane disk contention: [control-plane-storage.md](./runbooks/control-plane-storage.md) |

## References

- [Broadcom 9400-8i documentation](https://docs.broadcom.com/doc/12354774)
- [Proxmox PCI passthrough](https://pve.proxmox.com/wiki/PCI_Passthrough)
- [IPMI fan threshold guide](https://calvin.me/quick-how-to-decrease-ipmi-fan-threshold/)
- [runbooks/hba-firmware-update.md](./runbooks/hba-firmware-update.md),
  [runbooks/proxmox-recovery.md](./runbooks/proxmox-recovery.md),
  [runbooks/truenas-maintenance.md](./runbooks/truenas-maintenance.md),
  [runbooks/control-plane-storage.md](./runbooks/control-plane-storage.md)
- [setup/proxmox-zfs-pool-setup.md](./setup/proxmox-zfs-pool-setup.md),
  [setup/truenas-post-install.md](./setup/truenas-post-install.md)
- [architecture.md](./architecture.md), [networking.md](./networking.md),
  [disaster-recovery.md](./disaster-recovery.md)
