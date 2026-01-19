# Proxmox Disaster Recovery Runbook

This runbook provides step-by-step procedures for recovering from Proxmox failures, including configuration restore, VM recovery, and complete system rebuild.

## Table of Contents

- [Overview](#overview)
- [Pre-Incident Preparation](#pre-incident-preparation)
- [Incident Response](#incident-response)
- [Recovery Procedures](#recovery-procedures)
- [Validation](#validation)
- [Post-Recovery](#post-recovery)
- [References](#references)

---

## Overview

### Recovery Time Objectives (RTO)

| Scenario | RTO | Impact | Procedure |
|----------|-----|--------|-----------|
| Configuration drift | 30 min | None | Ansible re-run |
| Single VM failure | 1 hour | Single service | VM restore from backup |
| Proxmox crash | 2 hours | All VMs down | Proxmox reinstall + VM restore |
| Complete hardware failure | 4-8 hours | Everything down | Hardware replacement + full rebuild |

### Prerequisites

Before any incident, ensure you have:
- [ ] Access to IPMI (172.16.100.26)
- [ ] Proxmox installation media (USB)
- [ ] Backup storage accessible (TrueNAS or external)
- [ ] Git repository access (infrastructure code)
- [ ] Root password or SSH key
- [ ] Network access to VLAN 100

---

## Pre-Incident Preparation

### Regular Backups

**Configuration Backup** (Weekly):

```bash
# SSH to Proxmox
ssh root@172.16.100.250

# Backup Proxmox configuration
tar -czf /root/proxmox-config-$(date +%Y%m%d).tar.gz \
  /etc/pve/ \
  /etc/network/interfaces \
  /etc/hosts \
  /etc/resolv.conf

# Copy to TrueNAS
scp /root/proxmox-config-*.tar.gz root@truenas:/mnt/tank/backups/proxmox/

# Or upload to cloud
rclone copy /root/proxmox-config-*.tar.gz b2:homelab-backups/proxmox/
```

**VM Backup** (Daily, automated via Proxmox):

```bash
# Verify backup schedule
pvesh get /cluster/backup

# Manual backup of all VMs
vzdump --all --storage backup-local --mode snapshot --compress zstd

# Check backup status
ls -lh /mnt/backups/dump/
```

**Ansible Playbook Backup**:

All Ansible configuration is in Git:

```bash
cd homelab/ansible
git pull
git log  # Verify latest changes
```

### Document Current State

**Before any major change**, document:

```bash
# List all VMs
qm list

# List storage
pvesm status

# List network config
cat /etc/network/interfaces

# List ZFS pools
zpool list
zfs list

# Save to file
qm list > /tmp/pre-change-vms.txt
```

---

## Incident Response

### Step 1: Assess the Situation

**Check Proxmox Status**:

```bash
# Via IPMI or physical console
# Check if Proxmox is responsive

# Via network
ping 172.16.100.250

# SSH test
ssh root@172.16.100.250

# Web UI test
# https://172.16.100.250:8006
```

**Determine Impact**:

- [ ] Can access Proxmox web UI?
- [ ] Can SSH to Proxmox?
- [ ] Are VMs running?
- [ ] Is storage accessible?
- [ ] What triggered the incident?

### Step 2: Triage

| Symptom | Likely Cause | Immediate Action |
|---------|--------------|------------------|
| Web UI down, SSH works | pveproxy crashed | Restart service: `systemctl restart pveproxy` |
| Cannot SSH, IPMI works | Network misconfiguration | Fix via IPMI console |
| Kernel panic | Hardware/driver issue | Reboot via IPMI |
| Storage errors | Disk failure | Check `zpool status`, prepare for recovery |
| VMs not starting | Resource exhaustion | Check `free -h`, `df -h` |

### Step 3: Communicate

**Notify stakeholders**:
- Family members (if services are down)
- Document incident start time
- Take screenshots/photos of errors

---

## Recovery Procedures

### Procedure 1: Restart Proxmox Services

**Symptom**: Web UI down, SSH accessible

**Recovery**:

```bash
# SSH to Proxmox
ssh root@172.16.100.250

# Restart Proxmox services
systemctl restart pveproxy
systemctl restart pvedaemon
systemctl restart pvestatd

# Check service status
systemctl status pveproxy
systemctl status pvedaemon

# Check logs
journalctl -u pveproxy -n 50 --no-pager
```

**RTO**: 5 minutes

---

### Procedure 2: Restore VM from Backup

**Symptom**: VM won't start or is corrupted

**Recovery**:

```bash
# List available backups
ls -lh /mnt/backups/dump/ | grep <vmid>

# Example: Restore VM 101 (TrueNAS)
# vzdump-qemu-101-2026_01_19-02_00_00.vma.zst

# Option A: Restore to same VM ID (overwrites existing)
qmrestore /mnt/backups/dump/vzdump-qemu-101-2026_01_19-02_00_00.vma.zst 101

# Option B: Restore to new VM ID (keeps old VM)
qmrestore /mnt/backups/dump/vzdump-qemu-101-2026_01_19-02_00_00.vma.zst 201 --storage local-zfs

# Start VM
qm start 101

# Verify
qm status 101
```

**RTO**: 30-60 minutes (depends on VM size)

---

### Procedure 3: Restore Proxmox Configuration

**Symptom**: Proxmox configuration corrupted or lost

**Recovery**:

```bash
# Download backup from TrueNAS
scp root@truenas:/mnt/tank/backups/proxmox/proxmox-config-20260119.tar.gz /tmp/

# Extract configuration
cd /
tar -xzf /tmp/proxmox-config-20260119.tar.gz

# Restart services
systemctl restart pveproxy pvedaemon pvestatd

# Verify
pvesh get /nodes/$(hostname)/status
```

**Alternative: Re-apply via Ansible**:

```bash
# From workstation
cd homelab/ansible

# Run Proxmox configuration playbook
ansible-playbook -i inventory/hosts.yml playbooks/proxmox-post-install.yml
```

**RTO**: 30 minutes

---

### Procedure 4: Reinstall Proxmox

**Symptom**: Proxmox OS corrupted, cannot boot

**Prerequisites**:
- Proxmox installation USB
- Access to IPMI or physical console
- VM backups accessible

**Recovery Steps**:

**Step 1: Prepare Installation Media**

```bash
# Download Proxmox ISO
wget https://www.proxmox.com/en/downloads/category/iso-images-pve

# Write to USB (macOS/Linux)
sudo dd if=proxmox-ve_*.iso of=/dev/sdX bs=1M status=progress

# Eject USB
sync
eject /dev/sdX
```

**Step 2: Boot from USB**

1. Connect to IPMI: https://172.16.100.26
2. Insert USB drive (or mount ISO via IPMI virtual media)
3. Reboot server
4. Enter boot menu (F11 on Supermicro)
5. Select USB drive

**Step 3: Install Proxmox**

1. Select "Install Proxmox VE"
2. Accept EULA
3. **Target Harddisk**: Select 250GB NVMe (OS drive)
   - **WARNING**: This will erase the OS drive
4. **Country/Timezone**: Select appropriate values
5. **Administration Password**: Set root password
6. **Network Configuration**:
   - Management Interface: `enp1s0`
   - Hostname (FQDN): `proxmox.ryanmcafee.com`
   - IP Address: `172.16.100.250/24`
   - Gateway: `172.16.100.1`
   - DNS Server: `1.1.1.1`
7. Confirm installation
8. Reboot after installation

**Step 4: Post-Install Configuration**

```bash
# SSH to new Proxmox installation
ssh root@172.16.100.250

# Update system
apt update
apt dist-upgrade -y

# Configure repositories (remove subscription repo)
rm /etc/apt/sources.list.d/pve-enterprise.list

# Add no-subscription repo
echo "deb http://download.proxmox.com/debian/pve bookworm pve-no-subscription" > /etc/apt/sources.list.d/pve-no-subscription.list

apt update
```

**Step 5: Run Ansible Playbook**

```bash
# From workstation
cd homelab/ansible

# Run complete Proxmox setup
ansible-playbook -i inventory/hosts.yml playbooks/site.yml

# This configures:
# - ZFS pools
# - Backup schedules
# - IPMI fan thresholds
# - HBA passthrough
# - GPU passthrough
# - Network bridges
```

**Step 6: Restore VMs**

```bash
# Import VM backups from TrueNAS or external storage
# Mount backup storage
mkdir -p /mnt/restore
mount -t nfs truenas:/mnt/tank/backups/proxmox /mnt/restore

# Restore each VM
qmrestore /mnt/restore/dump/vzdump-qemu-101-*.vma.zst 101  # TrueNAS
qmrestore /mnt/restore/dump/vzdump-qemu-102-*.vma.zst 102  # Talos CP-1
qmrestore /mnt/restore/dump/vzdump-qemu-103-*.vma.zst 103  # Talos CP-2
qmrestore /mnt/restore/dump/vzdump-qemu-104-*.vma.zst 104  # Talos Worker-1
qmrestore /mnt/restore/dump/vzdump-qemu-105-*.vma.zst 105  # Talos Worker-2
qmrestore /mnt/restore/dump/vzdump-qemu-106-*.vma.zst 106  # Talos Worker-3

# Start VMs in order
qm start 101  # TrueNAS first
sleep 60

qm start 102  # Talos control plane
qm start 103
sleep 120

qm start 104  # Talos workers
qm start 105
qm start 106
```

**RTO**: 2-4 hours

---

### Procedure 5: Complete Hardware Rebuild

**Symptom**: Hardware failure, new server required

**Prerequisites**:
- New server hardware
- Proxmox installation media
- VM backups from off-site storage
- Infrastructure Git repository

**Recovery Steps**:

**Step 1: Hardware Setup**

See [hardware-setup.md](../hardware-setup.md) for complete instructions:

1. Install CPU, RAM, storage devices
2. Install PCIe cards (HBAs, GPU)
3. Connect network cables
4. Configure BIOS settings
5. Flash HBA firmware

**Step 2: Install Proxmox**

Follow **Procedure 4** above

**Step 3: Configure Infrastructure**

```bash
# Clone infrastructure repository
git clone https://github.com/username/homelab.git
cd homelab

# Run Ansible playbooks
cd ansible
ansible-playbook -i inventory/hosts.yml playbooks/site.yml
```

**Step 4: Provision VMs via Terragrunt**

```bash
# Provision infrastructure
cd terragrunt/environments/prod

# Create ZFS pool
cd proxmox-zfs-pool
terragrunt apply

# Provision TrueNAS VM
cd ../truenas
terragrunt apply

# Restore TrueNAS configuration
# (via TrueNAS web UI or backup restore)

# Provision Talos cluster
cd ../talos-cluster
terragrunt apply

# Bootstrap GitOps
cd ../gitops-bootstrap
terragrunt apply
```

**Step 5: Restore Application Data**

See [disaster-recovery.md](../disaster-recovery.md#scenario-6-complete-homelab-loss) for complete procedure.

**RTO**: 6-8 hours

---

## Validation

### Post-Recovery Checklist

After any recovery procedure:

**Proxmox**:
- [ ] Can access web UI (https://172.16.100.250:8006)
- [ ] Can SSH to Proxmox
- [ ] All VMs are listed in web UI
- [ ] ZFS pools are healthy: `zpool status`
- [ ] Network configured correctly: `ip addr`, `ip route`
- [ ] Backup schedule active: `pvesh get /cluster/backup`

**VMs**:
- [ ] All VMs are running: `qm list`
- [ ] Can SSH to VMs
- [ ] TrueNAS accessible
- [ ] Talos cluster healthy: `talosctl health`
- [ ] Kubernetes API accessible: `kubectl get nodes`

**Services**:
- [ ] Plex accessible
- [ ] Home Assistant accessible
- [ ] ArgoCD syncing applications
- [ ] Monitoring dashboards showing data

**Network**:
- [ ] Can access VMs from workstation
- [ ] VMs can access internet
- [ ] BGP peering established (if MetalLB)
- [ ] DNS resolving correctly

### Validation Commands

```bash
# Proxmox health
pvesh get /nodes/$(hostname)/status
pvesh get /cluster/resources

# ZFS health
zpool status
zpool list

# VM status
qm list
qm status <vmid>

# Network
ip addr show vmbr0
ping 172.16.100.1
ping 8.8.8.8

# Kubernetes (if Talos cluster running)
talosctl -n <cp-ip> health
kubectl get nodes
kubectl get pods -A
```

---

## Post-Recovery

### Document Incident

**Create Incident Report**:

```markdown
# Incident Report: YYYY-MM-DD

## Summary
Brief description of what happened

## Timeline
- HH:MM - Incident detected
- HH:MM - Recovery started
- HH:MM - Services restored
- HH:MM - Validation completed

## Root Cause
What caused the incident

## Recovery Steps
What was done to recover

## Lessons Learned
What can be improved

## Action Items
- [ ] Update documentation
- [ ] Improve monitoring
- [ ] Test backups more frequently
```

### Update Documentation

- [ ] Update this runbook if procedures changed
- [ ] Document any new configurations
- [ ] Update network diagrams if changed
- [ ] Commit changes to Git

### Improve Processes

**Questions to Ask**:
- Could this have been prevented?
- Was the backup adequate?
- Were recovery procedures clear?
- What took longer than expected?
- What can be automated?

**Action Items**:
- Add monitoring alerts if applicable
- Update backup schedule if needed
- Improve documentation
- Test recovery procedures regularly

### Test Recovery Plan

**Schedule Regular Tests**:

| Test | Frequency | Procedure |
|------|-----------|-----------|
| VM restore | Monthly | Restore one VM to test namespace |
| Proxmox config restore | Quarterly | Restore config on test system |
| Full rebuild | Annually | Build dev environment from scratch |

---

## References

### Proxmox Documentation

- [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- [Backup and Restore](https://pve.proxmox.com/wiki/Backup_and_Restore)
- [ZFS on Linux](https://pve.proxmox.com/wiki/ZFS_on_Linux)

### Related Runbooks

- [talos-upgrade.md](./talos-upgrade.md) - Talos cluster recovery
- [truenas-maintenance.md](./truenas-maintenance.md) - TrueNAS recovery

### Related Documentation

- [architecture.md](../architecture.md) - Architecture overview
- [disaster-recovery.md](../disaster-recovery.md) - Complete DR strategy
- [hardware-setup.md](../hardware-setup.md) - Hardware configuration

---

**Last Updated**: 2026-01-19
**Version**: 1.0
**Maintainer**: homelab team

---

## Appendix: Quick Reference Commands

### VM Management

```bash
# List VMs
qm list

# Start VM
qm start <vmid>

# Stop VM
qm stop <vmid>

# Shutdown VM (graceful)
qm shutdown <vmid>

# Delete VM
qm destroy <vmid>

# Clone VM
qm clone <vmid> <newid> --name <newname>
```

### Backup/Restore

```bash
# Manual backup
vzdump <vmid> --storage backup-local --mode snapshot --compress zstd

# Restore backup
qmrestore /path/to/backup.vma.zst <vmid>

# List backups
ls -lh /mnt/backups/dump/
```

### ZFS

```bash
# Check pool health
zpool status
zpool list

# Scrub pool
zpool scrub <pool>

# List snapshots
zfs list -t snapshot

# Rollback snapshot
zfs rollback <pool>/<dataset>@<snapshot>
```

### Networking

```bash
# Show network config
cat /etc/network/interfaces

# Restart networking
systemctl restart networking

# Test connectivity
ping 172.16.100.1
ping 8.8.8.8
```
