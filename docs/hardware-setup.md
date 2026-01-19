# Hardware Setup and Configuration

This document provides comprehensive hardware configuration instructions for the homelab, including BIOS settings, HBA configuration, cable management, and troubleshooting.

## Table of Contents

- [Hardware Overview](#hardware-overview)
- [Server Specifications](#server-specifications)
- [BIOS Configuration](#bios-configuration)
- [HBA Card Setup](#hba-card-setup)
- [GPU Passthrough Configuration](#gpu-passthrough-configuration)
- [Network Interface Configuration](#network-interface-configuration)
- [Cable Management](#cable-management)
- [IPMI Configuration](#ipmi-configuration)
- [Storage Drive Layout](#storage-drive-layout)
- [Power Management](#power-management)
- [Troubleshooting](#troubleshooting)
- [References](#references)

---

## Hardware Overview

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Supermicro Server Chassis                       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Motherboard: Supermicro X11 Series                      │  │
│  │  CPU: 24 vCPUs                                            │  │
│  │  RAM: 256 GB DDR4 ECC                                     │  │
│  │                                                            │  │
│  │  PCIe Slots:                                              │  │
│  │  ├─ Slot 1: Broadcom HBA 9400-8i (Proxmox storage)       │  │
│  │  ├─ Slot 2: Broadcom HBA 9400-8i Mixed (TrueNAS pass)    │  │
│  │  ├─ Slot 3: NVIDIA Quadro P2200 5GB (Plex GPU)           │  │
│  │  └─ Slot 4: (Available)                                  │  │
│  │                                                            │  │
│  │  Storage:                                                 │  │
│  │  ├─ NVMe 1: 250GB (Proxmox OS)                           │  │
│  │  ├─ NVMe 2: 1TB (VM storage pool - ZFS mirror)           │  │
│  │  ├─ NVMe 3: 1TB (VM storage pool - ZFS mirror)           │  │
│  │  ├─ NVMe 4: 1TB (TrueNAS special vDev - mirror)          │  │
│  │  ├─ NVMe 5: 1TB (TrueNAS special vDev - mirror)          │  │
│  │  ├─ HDD 1-8: 20TB (TrueNAS data pool - RAIDZ2)           │  │
│  │  └─ HDD 9-16: (Available for expansion)                  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Network:                                                        │
│  ├─ 1GbE Port 1: IPMI (172.16.100.26)                           │
│  ├─ 10GbE Port 1: Proxmox Management (172.16.100.250)           │
│  └─ 10GbE Port 2: (Available)                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Server Specifications

### Complete Parts List

See [Google Sheets Parts List](https://docs.google.com/spreadsheets/d/19JLS5aV629NgUacsKQQx_2HI5iXPV7Kn0e5kuBvYOVQ/edit?gid=0#gid=0) for detailed part numbers and pricing.

### CPU and Memory

| Component | Specification | Notes |
|-----------|---------------|-------|
| CPU | 24 vCPUs | Exact model varies |
| RAM | 256 GB DDR4 ECC | 8x 32GB DIMMs recommended |
| RAM Speed | 2666 MHz or higher | Match CPU supported speed |

### Storage Devices

| Device | Capacity | Interface | Purpose |
|--------|----------|-----------|---------|
| NVMe SSD 1 | 250 GB | M.2 NVMe | Proxmox OS |
| NVMe SSD 2-3 | 1 TB each | M.2 NVMe | Proxmox VM storage (ZFS mirror) |
| NVMe SSD 4-5 | 1 TB each | U.2 NVMe | TrueNAS special vDev (ZFS mirror) |
| HDD 1-8 | 20 TB each | SATA/SAS | TrueNAS data pool (RAIDZ2) |

**Total Raw Storage**: 250 GB + 2 TB + 2 TB + 160 TB = ~164 TB
**Usable Storage**: ~122 TB (after RAID overhead)

### PCIe Cards

| Slot | Card | Model | Purpose |
|------|------|-------|---------|
| 1 | HBA | Broadcom 9400-8i | Proxmox storage (HDDs) |
| 2 | HBA | Broadcom 9400-8i Mixed Mode | TrueNAS passthrough (NVMe + HDDs) |
| 3 | GPU | NVIDIA Quadro P2200 5GB | Plex hardware transcoding |
| 4 | - | Available | Future expansion |

### Cables

#### U.2 NVMe Cables (for Mixed Mode HBA)

| Cable MPN | Length | Quantity | From | To |
|-----------|--------|----------|------|-----|
| 05-50065-00 | 0.5m | 2 | HBA SFF-8643 | U.2 NVMe SFF-8639 |
| 05-50064-00 | 1.0m | 0 | HBA SFF-8643 | U.2 NVMe SFF-8639 |

**Reference**: [Broadcom Mixed Mode Documentation](https://docs.broadcom.com/doc/12354774)

#### SAS Cables (for HDDs)

| Cable Type | Length | Quantity | From | To |
|------------|--------|----------|------|-----|
| SFF-8643 to SFF-8482 x4 | 0.5m | 2 | HBA SFF-8643 | 4x SATA/SAS HDDs |

### Network Interfaces

| Interface | Speed | Purpose | VLAN |
|-----------|-------|---------|------|
| IPMI | 1 GbE | Out-of-band management | Dedicated |
| eth0 | 10 GbE | Proxmox management + VM traffic | 100 |
| eth1 | 10 GbE | (Available) | - |

---

## BIOS Configuration

### Accessing BIOS

1. Connect keyboard and monitor to server
2. Power on server
3. Press **Delete** key during POST
4. Login with IPMI credentials if required

### Required BIOS Settings

#### Boot Settings

| Setting | Value | Path |
|---------|-------|------|
| Boot Mode | UEFI | Boot → Boot Mode |
| Fast Boot | Disabled | Boot → Fast Boot |
| Boot Device | NVMe SSD 1 (250GB) | Boot → Boot Device Priority |

#### CPU Configuration

| Setting | Value | Path | Purpose |
|---------|-------|------|---------|
| Intel VT-x | Enabled | Advanced → CPU Configuration | Hardware virtualization |
| Intel VT-d | Enabled | Advanced → CPU Configuration | IOMMU for PCIe passthrough |
| Hyper-Threading | Enabled | Advanced → CPU Configuration | Double thread count |
| C-States | Enabled | Advanced → CPU Configuration | Power saving |

#### Memory Settings

| Setting | Value | Path | Purpose |
|---------|-------|------|---------|
| ECC Mode | Enabled | Advanced → Memory Configuration | Error correction |
| Memory Speed | Auto or Max | Advanced → Memory Configuration | Performance |

#### PCIe Configuration

| Setting | Value | Path | Purpose |
|---------|-------|------|---------|
| IOMMU | Enabled | Advanced → PCIe/PCI/PnP Configuration | Device passthrough |
| ARI Support | Enabled | Advanced → PCIe/PCI/PnP Configuration | Alternative Routing-ID |
| SR-IOV | Enabled | Advanced → PCIe/PCI/PnP Configuration | Single Root I/O Virtualization |
| Above 4G Decoding | Enabled | Advanced → PCIe/PCI/PnP Configuration | Large BAR support (GPU) |
| Re-Size BAR Support | Enabled | Advanced → PCIe/PCI/PnP Configuration | Modern GPU support |

#### Storage Configuration

| Setting | Value | Path | Purpose |
|---------|-------|------|---------|
| SATA Mode | AHCI | Advanced → SATA Configuration | Standard SATA mode |
| NVMe Support | Enabled | Advanced → NVMe Configuration | Boot from NVMe |

#### Power Management

| Setting | Value | Path | Purpose |
|---------|-------|------|---------|
| Power Restore Policy | Last State | Advanced → ACPI Configuration | Auto-restart after power loss |
| Wake on LAN | Enabled | Advanced → ACPI Configuration | Remote power-on |

### IOMMU Groups

After enabling VT-d and IOMMU, verify IOMMU groups in Proxmox:

```bash
# List IOMMU groups
for d in /sys/kernel/iommu_groups/*/devices/*; do
    n=${d#*/iommu_groups/*}; n=${n%%/*}
    printf 'IOMMU Group %s ' "$n"
    lspci -nns "${d##*/}"
done
```

**Expected Output** (example):

```
IOMMU Group 15: 01:00.0 Serial Attached SCSI controller [0107]: Broadcom / LSI SAS3008 PCI-Express Fusion-MPT SAS-3 [1000:0097] (rev 02)
IOMMU Group 16: 02:00.0 Serial Attached SCSI controller [0107]: Broadcom / LSI SAS3008 PCI-Express Fusion-MPT SAS-3 [1000:0097] (rev 02)
IOMMU Group 17: 03:00.0 VGA compatible controller [0300]: NVIDIA Corporation GP106GL [Quadro P2200] [10de:1c31] (rev a1)
IOMMU Group 17: 03:00.1 Audio device [0403]: NVIDIA Corporation GP106 High Definition Audio Controller [10de:10f1] (rev a1)
```

**Important**: GPU and its audio device must be in same IOMMU group.

---

## HBA Card Setup

### Broadcom 9400-8i Configuration

The homelab uses two Broadcom 9400-8i HBA cards:
1. **HBA 1**: IT mode for Proxmox storage (standard SATA/SAS)
2. **HBA 2**: Mixed mode for TrueNAS passthrough (NVMe + SATA/SAS)

### Firmware Requirements

| HBA | Mode | Firmware | Purpose |
|-----|------|----------|---------|
| HBA 1 | IT Mode | 16.00.12.00 | Proxmox direct access to HDDs |
| HBA 2 | Mixed Mode | 16.00.12.00 | TrueNAS NVMe + HDD support |

**Reference**: [Broadcom Firmware Downloads](https://docs.broadcom.com/doc/12354774)

### Flashing HBA to IT Mode

**Prerequisites**:
- USB drive with FreeDOS or UEFI shell
- sas3flash utility
- IT mode firmware (9400_8i_IT.bin)

**Procedure**:

```bash
# Boot to UEFI shell or FreeDOS

# Erase existing firmware
sas3flash -o -e 7

# Flash IT mode firmware
sas3flash -o -f 9400_8i_IT.bin

# Flash BIOS (optional, needed for boot)
sas3flash -o -b mptsas3.rom

# Verify
sas3flash -list

# Reboot
```

**Expected Output**:

```
LSI Corporation SAS3 Flash Utility
Version 16.00.00.00

Adapter Selected is a LSI SAS: SAS3008(B0)
Controller Number: 0
Firmware Product ID: 0x002f (IT)
Firmware Version: 16.00.12.00
```

### Enabling Mixed Mode (NVMe Support)

**Only for HBA 2** (TrueNAS passthrough):

```bash
# Boot to UEFI shell

# Enable mixed mode
sas3flash -o -nvdata mixed.bin

# Verify
sas3flash -list
```

**Expected Output**:

```
NVMe Support: Enabled
Mixed Mode: Enabled
```

### HBA Passthrough to TrueNAS

**In Proxmox**:

```bash
# List PCI devices
lspci -nnk | grep -i sas

# Example output:
# 02:00.0 Serial Attached SCSI controller [0107]: Broadcom / LSI SAS3008

# Edit VM config
vim /etc/pve/qemu-server/101.conf

# Add HBA passthrough (replace 02:00 with actual address)
hostpci0: 02:00,pcie=1,rombar=0
```

**Verify in TrueNAS**:

```bash
# SSH to TrueNAS
ssh root@truenas.local

# List NVMe devices
nvmecontrol devlist

# List SAS/SATA devices
camcontrol devlist
```

---

## GPU Passthrough Configuration

### NVIDIA Quadro P2200 Setup

**Purpose**: Hardware-accelerated transcoding for Plex

**Requirements**:
- IOMMU enabled in BIOS
- GPU in dedicated IOMMU group
- vfio-pci driver loaded in Proxmox

### Proxmox Configuration

**Edit GRUB config**:

```bash
# Edit GRUB
vim /etc/default/grub

# Add to GRUB_CMDLINE_LINUX_DEFAULT:
GRUB_CMDLINE_LINUX_DEFAULT="quiet intel_iommu=on iommu=pt pcie_acs_override=downstream,multifunction video=efifb:off"

# Update GRUB
update-grub

# Reboot
reboot
```

**Load vfio modules**:

```bash
# Edit modules
vim /etc/modules

# Add:
vfio
vfio_iommu_type1
vfio_pci
vfio_virqfd

# Update initramfs
update-initramfs -u -k all

# Reboot
reboot
```

**Bind GPU to vfio-pci**:

```bash
# Get GPU vendor:device ID
lspci -nn | grep NVIDIA

# Example output:
# 03:00.0 VGA compatible controller [0300]: NVIDIA Corporation GP106GL [Quadro P2200] [10de:1c31]
# 03:00.1 Audio device [0403]: NVIDIA Corporation GP106 HDMI Audio [10de:10f1]

# Edit vfio config
vim /etc/modprobe.d/vfio.conf

# Add (replace with your IDs):
options vfio-pci ids=10de:1c31,10de:10f1

# Update initramfs
update-initramfs -u -k all

# Reboot
reboot

# Verify GPU bound to vfio-pci
lspci -nnk | grep -A 3 NVIDIA
```

**Expected Output**:

```
03:00.0 VGA compatible controller [0300]: NVIDIA Corporation GP106GL [Quadro P2200] [10de:1c31]
    Kernel driver in use: vfio-pci
```

### Talos Worker VM Configuration

**Edit Talos worker VM** (worker-1 with GPU):

```bash
# Edit VM config
vim /etc/pve/qemu-server/103.conf

# Add GPU passthrough (replace 03:00 with actual address)
hostpci0: 03:00,pcie=1,x-vga=1
cpu: host,hidden=1,flags=+pcid
machine: q35
```

**In Talos**: See [Talos GPU patch](../talos/patches/gpu-passthrough.yaml) for configuration.

---

## Network Interface Configuration

### IPMI Configuration

See [IPMI Configuration](#ipmi-configuration) section below.

### Proxmox Network Bridge

**Edit network config**:

```bash
vim /etc/network/interfaces
```

**Configuration**:

```
auto lo
iface lo inet loopback

# Physical interface
auto enp1s0
iface enp1s0 inet manual

# Bridge for VMs (VLAN 100)
auto vmbr0
iface vmbr0 inet static
    address 172.16.100.250/24
    gateway 172.16.100.1
    bridge-ports enp1s0
    bridge-stp off
    bridge-fd 0
    bridge-vlan-aware yes
    bridge-vids 100
```

**Restart networking**:

```bash
systemctl restart networking

# Or reboot
reboot
```

---

## Cable Management

### Recommended Cable Routing

```
┌─────────────────────────────────────────────────────────┐
│                     Rear of Server                       │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   HBA 1     │  │   HBA 2     │  │     GPU     │    │
│  │  (Proxmox)  │  │  (TrueNAS)  │  │  (Quadro)   │    │
│  │             │  │             │  │             │    │
│  │ SFF-8643 x2 │  │ SFF-8643 x2 │  │ DisplayPort │    │
│  └──────┬──────┘  └──────┬──────┘  └─────────────┘    │
│         │                │                              │
│         │ ┌──────────────┘                              │
│         │ │                                             │
│         ▼ ▼                                             │
│  ┌─────────────────────────────────────────┐           │
│  │         Drive Backplane                 │           │
│  │  ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐  │           │
│  │  │HDD│ │HDD│ │HDD│ │HDD│ │HDD│ │HDD│  │           │
│  │  │1  │ │2  │ │3  │ │4  │ │5  │ │6  │  │           │
│  │  └───┘ └───┘ └───┘ └───┘ └───┘ └───┘  │           │
│  │  ┌───┐ ┌───┐ ┌────┐ ┌────┐ ┌────┐     │           │
│  │  │HDD│ │HDD│ │NVMe│ │NVMe│ │NVMe│ ... │           │
│  │  │7  │ │8  │ │ 4  │ │ 5  │ │ 6  │     │           │
│  │  └───┘ └───┘ └────┘ └────┘ └────┘     │           │
│  └─────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────┘
```

### Cable Color Coding (Recommended)

| Cable Type | Color | Purpose |
|------------|-------|---------|
| SAS HDD | Red | HBA 1 → Proxmox HDDs |
| SAS HDD | Blue | HBA 2 → TrueNAS HDDs |
| NVMe | Yellow | HBA 2 → TrueNAS NVMe |
| Network | Green | Management network |
| Power | Black | Power supply cables |

### Cable Management Best Practices

1. **Label Everything**: Use cable labels or colored tape
2. **Leave Slack**: Allow for drive replacement without cable strain
3. **Route Away from Fans**: Avoid blocking airflow
4. **Secure with Velcro**: Don't use zip ties (hard to change)
5. **Document**: Take photos before and after changes

---

## IPMI Configuration

### Initial Setup

**Default Credentials** (Supermicro):
- Username: `ADMIN`
- Password: `ADMIN` (change immediately!)

**Access IPMI Web UI**:

1. Connect to IPMI network (separate from main network)
2. Navigate to `http://172.16.100.26` (or DHCP-assigned IP)
3. Login with default credentials

### Network Configuration

**Static IP Assignment**:

1. Navigate to **Configuration** → **Network**
2. Configure:
   - IP Address: `172.16.100.26`
   - Subnet Mask: `255.255.255.0`
   - Gateway: `172.16.100.1`
   - VLAN: (optional) Dedicated IPMI VLAN
3. Save and reboot IPMI

### Security Configuration

**Change Default Password**:

1. Navigate to **Configuration** → **Users**
2. Select `ADMIN` user
3. Click **Modify User**
4. Set strong password
5. Save

**Disable Unused Protocols**:

1. Navigate to **Configuration** → **Services**
2. Disable:
   - Telnet
   - SNMP v1/v2 (use v3 if needed)
   - HTTP (use HTTPS only)

### Fan Control (Noctua Fans)

**Problem**: Noctua fans spin slowly, triggering IPMI fan alerts

**Solution**: Lower fan thresholds via IPMI

```bash
# SSH to IPMI (if enabled) or use ipmitool from another host
ipmitool -I lanplus -H 172.16.100.26 -U ADMIN -P <password> sensor thresh FAN1 lower 200 300 400
ipmitool -I lanplus -H 172.16.100.26 -U ADMIN -P <password> sensor thresh FAN2 lower 200 300 400
ipmitool -I lanplus -H 172.16.100.26 -U ADMIN -P <password> sensor thresh FAN3 lower 200 300 400
ipmitool -I lanplus -H 172.16.100.26 -U ADMIN -P <password> sensor thresh FAN4 lower 200 300 400
```

**Reference**: [IPMI Fan Threshold Guide](https://calvin.me/quick-how-to-decrease-ipmi-fan-threshold/)

**Persist Settings** (Ansible):

```yaml
# ansible/roles/proxmox-ipmi/tasks/main.yml
- name: Set IPMI fan thresholds
  command: >
    ipmitool -I lanplus -H {{ ipmi_host }} -U {{ ipmi_user }} -P {{ ipmi_pass }}
    sensor thresh {{ item }} lower 200 300 400
  loop:
    - FAN1
    - FAN2
    - FAN3
    - FAN4
```

---

## Storage Drive Layout

### Physical Drive Bay Mapping

```
┌─────────────────────────────────────────────────────────────┐
│                     Front Drive Bays                         │
│                                                              │
│  Row 1 (HDDs - TrueNAS Data Pool RAIDZ2):                  │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐   │
│  │ 20TB │ │ 20TB │ │ 20TB │ │ 20TB │ │ 20TB │ │ 20TB │   │
│  │ HDD1 │ │ HDD2 │ │ HDD3 │ │ HDD4 │ │ HDD5 │ │ HDD6 │   │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘   │
│                                                              │
│  Row 2:                                                     │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐   │
│  │ 20TB │ │ 20TB │ │ 1TB  │ │ 1TB  │ │ 1TB  │ │ 1TB  │   │
│  │ HDD7 │ │ HDD8 │ │ NVMe │ │ NVMe │ │ NVMe │ │ NVMe │   │
│  │      │ │      │ │  2   │ │  3   │ │  4   │ │  5   │   │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘   │
│                                                              │
│  Internal (not hot-swap):                                   │
│  ┌──────┐                                                   │
│  │ 250GB│  NVMe 1 (Proxmox OS)                             │
│  └──────┘                                                   │
└─────────────────────────────────────────────────────────────┘
```

### Drive Purpose Summary

| Drive | Capacity | Controller | Purpose |
|-------|----------|------------|---------|
| NVMe 1 | 250 GB | Onboard | Proxmox OS |
| NVMe 2-3 | 1 TB | HBA 1 | Proxmox VM storage (ZFS mirror) |
| NVMe 4-5 | 1 TB | HBA 2 | TrueNAS special vDev (ZFS mirror) |
| HDD 1-8 | 20 TB | HBA 2 | TrueNAS data pool (RAIDZ2) |

---

## Power Management

### Power Supply Configuration

| PSU | Wattage | Efficiency | Redundancy |
|-----|---------|------------|------------|
| PSU 1 | 1200W | Platinum | Active |
| PSU 2 | 1200W | Platinum | Hot spare |

### Power Consumption Estimates

| State | Estimated Power | Components |
|-------|-----------------|------------|
| Idle | ~150W | All drives spun down |
| Normal | ~250W | OS + VMs running |
| Peak | ~400W | Heavy transcoding + backups |

### UPS Configuration

**Recommended UPS**: 1500 VA / 900W minimum

**Runtime Estimates**:
- Idle: ~90 minutes
- Normal: ~45 minutes
- Peak: ~25 minutes

**Graceful Shutdown**:

Configure Proxmox to monitor UPS via NUT (Network UPS Tools):

```bash
# Install NUT
apt install nut

# Configure NUT client
vim /etc/nut/upsmon.conf

# Add:
MONITOR ups@localhost 1 monuser secret master
SHUTDOWNCMD "/sbin/shutdown -h +0"
```

---

## Troubleshooting

### Server Won't Boot

**Symptoms**: No POST, black screen

**Diagnosis**:
1. Check power cables
2. Check IPMI for error codes
3. Remove all PCIe cards except GPU
4. Test with minimal RAM (1 DIMM)
5. Reset CMOS (remove battery for 30 seconds)

**Resolution**:
- Replace faulty component
- Update BIOS if boot issues persist

### HBA Not Detecting Drives

**Symptoms**: Drives not visible in Proxmox or TrueNAS

**Diagnosis**:

```bash
# Check HBA is detected
lspci | grep -i sas

# Check drive detection
lsblk

# Check HBA firmware
sas3flash -list
```

**Resolution**:
- Reseat HBA card
- Check cable connections
- Verify HBA firmware is correct (IT mode vs Mixed mode)
- Test with different drive/cable

### GPU Passthrough Not Working

**Symptoms**: VM won't start with GPU, or GPU not visible in VM

**Diagnosis**:

```bash
# Check GPU is bound to vfio-pci
lspci -nnk | grep -A 3 NVIDIA

# Check IOMMU groups
for d in /sys/kernel/iommu_groups/*/devices/*; do
    n=${d#*/iommu_groups/*}; n=${n%%/*}
    printf 'IOMMU Group %s ' "$n"
    lspci -nns "${d##*/}"
done | grep NVIDIA
```

**Resolution**:
- Verify IOMMU enabled in BIOS
- Check GPU is in dedicated IOMMU group
- Verify vfio-pci driver loaded
- Check VM config has correct PCI address

### Fan Speed Alerts (Noctua Fans)

**Symptoms**: IPMI reports fan failures, fans cycling

**Resolution**:

See [IPMI Fan Control](#fan-control-noctua-fans) section above.

### Overheating

**Symptoms**: Thermal throttling, system shutdowns

**Diagnosis**:

```bash
# Check temperatures
sensors

# Check IPMI sensors
ipmitool sensor list
```

**Resolution**:
- Clean dust from heatsinks and fans
- Verify all fans spinning
- Check thermal paste on CPU
- Verify airflow is not blocked

---

## References

### Hardware Documentation

- [Supermicro X11 Motherboard Manual](https://www.supermicro.com/manuals/)
- [Broadcom HBA 9400-8i Documentation](https://docs.broadcom.com/doc/12354774)
- [NVIDIA Quadro P2200 Specs](https://www.nvidia.com/en-us/design-visualization/quadro/pascal/)

### Setup Guides

- [Proxmox GPU Passthrough Guide](https://pve.proxmox.com/wiki/PCI_Passthrough)
- [HBA IT Mode Flashing Guide](https://forums.servethehome.com/index.php?threads/lsi-raid-controller-and-hba-complete-listing-plus-oem-models.599/)
- [IPMI Fan Control Guide](https://calvin.me/quick-how-to-decrease-ipmi-fan-threshold/)

### Parts Lists

- [Google Sheets Parts List](https://docs.google.com/spreadsheets/d/19JLS5aV629NgUacsKQQx_2HI5iXPV7Kn0e5kuBvYOVQ/edit?gid=0#gid=0)

### Related Documentation

- [architecture.md](./architecture.md) - Architecture overview
- [disaster-recovery.md](./disaster-recovery.md) - Backup procedures
- [networking.md](./networking.md) - Network configuration

---

**Last Updated**: 2026-01-19
**Version**: 1.0
**Maintainer**: homelab team
