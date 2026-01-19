# TrueNAS Maintenance and ZFS Operations Runbook

This runbook provides comprehensive procedures for TrueNAS maintenance, ZFS operations, disaster recovery, and troubleshooting.

## Table of Contents

- [Overview](#overview)
- [Regular Maintenance](#regular-maintenance)
- [ZFS Operations](#zfs-operations)
- [Storage Expansion](#storage-expansion)
- [Performance Tuning](#performance-tuning)
- [Disaster Recovery](#disaster-recovery)
- [Troubleshooting](#troubleshooting)
- [References](#references)

---

## Overview

### TrueNAS Role

TrueNAS provides network-attached storage (NAS) for the homelab:
- **Kubernetes PVCs**: Dynamic provisioning via democratic-csi
- **Media Storage**: Plex, Sonarr, Radarr libraries
- **Backups**: Proxmox VM backups, etcd snapshots
- **Archive**: Long-term data storage

### Storage Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TrueNAS Scale VM                          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  ZFS Pool: tank                                        │ │
│  │                                                        │ │
│  │  ┌──────────────────────────────────────────────────┐ │ │
│  │  │  Data vDev (RAIDZ3)                              │ │ │
│  │  │  - 8x 20TB HDDs                                  │ │ │
│  │  │  - Usable: ~120TB                                │ │ │
│  │  │  - 2-disk fault tolerance                        │ │ │
│  │  └──────────────────────────────────────────────────┘ │ │
│  │                                                        │ │
│  │  ┌──────────────────────────────────────────────────┐ │ │
│  │  │  Special vDev (Metadata + Small Blocks)          │ │ │
│  │  │  - 2x 1TB NVMe (RAID-1 mirror)                   │ │ │
│  │  │  - Stores: Metadata, blocks < 128KB              │ │ │
│  │  └──────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  NFS Shares:                                                 │
│  - /mnt/tank/kubernetes (K8s PVCs)                           │
│  - /mnt/tank/media (Plex libraries)                          │
│  - /mnt/tank/backups (VM backups, etcd)                      │
└─────────────────────────────────────────────────────────────┘
```

### Maintenance Schedule

| Task | Frequency | Duration | Downtime |
|------|-----------|----------|----------|
| ZFS scrub | Monthly | 12-24 hours | None |
| Snapshot cleanup | Weekly | 5 minutes | None |
| Pool capacity check | Weekly | 1 minute | None |
| SMART tests | Monthly | 2-4 hours | None |
| TrueNAS updates | Quarterly | 30 minutes | Brief (5 min) |
| Configuration backup | Weekly | 5 minutes | None |

---

## Regular Maintenance

### Task 1: ZFS Scrub

**Purpose**: Verify data integrity, detect silent corruption

**Frequency**: Monthly (first Sunday of month, 2 AM)

**Procedure**:

**Via Web UI**:
1. Navigate to **Storage** → **Pools**
2. Click **tank** → **Scrub Pool**
3. Confirm scrub start

**Via CLI**:

```bash
# SSH to TrueNAS
ssh root@truenas.local

# Start scrub
zpool scrub tank

# Check scrub status
zpool status tank

# Expected output:
# scan: scrub in progress since Sun Jan 19 02:00:00 2026
#       123G scanned at 2.5G/s, 45G issued at 1.2G/s
#       0 repaired, 36.59% done, 12h34m to go
```

**Automated via Cron**:

```bash
# Edit crontab
crontab -e

# Add scrub schedule (first Sunday, 2 AM)
0 2 1-7 * 0 [ $(date +\%u) -eq 7 ] && /usr/sbin/zpool scrub tank
```

**What to Check After Scrub**:

```bash
# Check for errors
zpool status tank | grep -i error

# No errors should show:
# errors: No known data errors

# If errors found:
# - Review /var/log/messages
# - Run SMART tests on drives
# - Plan drive replacement if needed
```

**Duration**: 12-24 hours (depending on data size)

---

### Task 2: Snapshot Management

**Purpose**: Create point-in-time backups, manage retention

**Frequency**: Hourly (snapshots), Weekly (cleanup)

**Automated Snapshots (via TrueNAS UI)**:

1. Navigate to **Tasks** → **Periodic Snapshot Tasks**
2. Click **Add**
3. Configure:
   - Dataset: `tank/kubernetes`
   - Recursive: Yes
   - Lifetime: `7d` (7 days)
   - Schedule: Hourly
4. Save

**Manual Snapshot**:

```bash
# Create snapshot
zfs snapshot -r tank/kubernetes@manual-$(date +%Y%m%d-%H%M%S)

# List snapshots
zfs list -t snapshot

# List snapshots for specific dataset
zfs list -t snapshot tank/kubernetes
```

**Cleanup Old Snapshots**:

```bash
# List snapshots older than 7 days
zfs list -t snapshot -o name,creation | grep "tank/kubernetes" | awk '$2 < systime() - 604800'

# Delete snapshots older than 7 days
for snap in $(zfs list -H -t snapshot -o name tank/kubernetes | awk ''); do
    age=$(zfs get -H -o value creation "$snap")
    age_sec=$(date -d "$age" +%s)
    now_sec=$(date +%s)
    if [ $((now_sec - age_sec)) -gt 604800 ]; then
        echo "Deleting old snapshot: $snap"
        zfs destroy "$snap"
    fi
done
```

**Automated Cleanup**:

TrueNAS automatically deletes snapshots based on retention policy set in UI.

---

### Task 3: Capacity Monitoring

**Purpose**: Prevent pool from running out of space

**Frequency**: Weekly

**Check Capacity**:

```bash
# Via CLI
zpool list tank
zfs list -o space tank

# Expected output:
# NAME   SIZE   ALLOC   FREE   CKPOINT  EXPANDSZ   FRAG   CAP  DEDUP  HEALTH  ALTROOT
# tank  140T   45.2T  94.8T         -         -    12%    32%  1.00x  ONLINE  -

# Alert threshold: 80% capacity
```

**Capacity Planning**:

```bash
# Check dataset usage
zfs list -o name,used,avail,refer,mountpoint

# Check snapshot usage
zfs list -t snapshot -o name,used

# Identify large files (top 20)
find /mnt/tank -type f -exec du -h {} + | sort -rh | head -n 20
```

**Automated Alerts** (via TrueNAS):
1. Navigate to **System** → **Alert Services**
2. Configure email/Slack for storage alerts
3. Default: Alert at 80% capacity

---

### Task 4: SMART Monitoring

**Purpose**: Detect drive failures early

**Frequency**: Automatic (daily), manual checks monthly

**View SMART Status**:

```bash
# List all drives
camcontrol devlist

# Check SMART status
smartctl -a /dev/da0  # Repeat for each drive

# Key metrics:
# - Reallocated Sectors: Should be 0
# - Current Pending Sectors: Should be 0
# - Offline Uncorrectable: Should be 0
# - SMART Health Status: PASSED
```

**Via TrueNAS UI**:
1. Navigate to **Storage** → **Disks**
2. Click on drive → **S.M.A.R.T. Test Results**

**Schedule SMART Tests**:
1. Navigate to **Tasks** → **S.M.A.R.T. Tests**
2. Add test:
   - Type: Long
   - Disks: All
   - Schedule: Monthly (first Sunday, 1 AM)

**Interpreting Results**:

| Metric | Threshold | Action |
|--------|-----------|--------|
| Reallocated Sectors | > 0 | Monitor, plan replacement |
| Reallocated Sectors | > 100 | Replace drive immediately |
| Current Pending | > 0 | Run scrub, monitor |
| Temperature | > 50°C | Check cooling |
| Power-On Hours | > 40,000 | Plan replacement |

---

### Task 5: Configuration Backup

**Purpose**: Backup TrueNAS configuration for disaster recovery

**Frequency**: Weekly, before any changes

**Via Web UI**:
1. Navigate to **System** → **Advanced** → **Save Debug**
2. Check **Include Password Secret Seed**
3. Click **Save Debug**
4. Download file: `truenas-config-YYYYMMDD.tar`

**Via CLI**:

```bash
# Export configuration
midclt call system.general.config_save /tmp/truenas-config-$(date +%Y%m%d).tar

# Copy to backup location
scp /tmp/truenas-config-*.tar root@backuphost:/mnt/backups/truenas/
```

**Restore Configuration**:

```bash
# Via Web UI:
# System → Advanced → Upload Config

# Via CLI:
midclt call system.general.config_upload /path/to/truenas-config.tar
```

---

## ZFS Operations

### Operation 1: Rollback to Snapshot

**Use Case**: Restore data after accidental deletion or corruption

**Procedure**:

```bash
# 1. List available snapshots
zfs list -t snapshot tank/kubernetes

# 2. Preview snapshot contents (read-only mount)
zfs clone tank/kubernetes@20260119-020000 tank/preview
ls /mnt/tank/preview
zfs destroy tank/preview  # Cleanup after preview

# 3. Rollback to snapshot
# WARNING: This destroys all changes after snapshot!
zfs rollback tank/kubernetes@20260119-020000

# 4. Verify
ls /mnt/tank/kubernetes
```

**Note**: Rollback destroys newer snapshots. Use `zfs rollback -r` to recursively destroy child snapshots.

---

### Operation 2: Send/Receive (Replication)

**Use Case**: Replicate data to external backup drive

**Procedure**:

```bash
# 1. Attach external drive
# Plug in USB drive, check device name
camcontrol devlist

# Create pool on external drive
zpool create backup /dev/da9

# 2. Initial full send
zfs snapshot -r tank/kubernetes@backup-full
zfs send -R tank/kubernetes@backup-full | zfs receive backup/kubernetes

# 3. Incremental send (subsequent backups)
zfs snapshot -r tank/kubernetes@backup-$(date +%Y%m%d)
zfs send -R -i tank/kubernetes@backup-full tank/kubernetes@backup-$(date +%Y%m%d) | \
  zfs receive backup/kubernetes

# 4. Verify
zfs list backup/kubernetes
```

**Automated Replication** (via TrueNAS UI):
1. Navigate to **Tasks** → **Replication Tasks**
2. Click **Add**
3. Configure source/destination
4. Set schedule

---

### Operation 3: Replace Failed Drive

**Scenario**: Drive failure detected

**Procedure**:

```bash
# 1. Identify failed drive
zpool status tank

# Example output:
#   NAME        STATE     READ WRITE CKSUM
#   tank        DEGRADED     0     0     0
#     RAIDZ3-0  DEGRADED     0     0     0
#       da0     ONLINE       0     0     0
#       da1     FAULTED      0     0     0  <-- Failed drive
#       da2     ONLINE       0     0     0

# 2. Take drive offline (if not already)
zpool offline tank da1

# 3. Physically replace drive
# - Shut down TrueNAS (or use hot-swap if available)
# - Replace failed drive with new drive
# - Power on

# 4. Identify new drive device
camcontrol devlist

# 5. Replace in ZFS pool
zpool replace tank da1 da9  # da9 is new drive

# 6. Monitor resilver (rebuild)
zpool status tank

# Resilver progress:
#   scan: resilver in progress since ...
#         5.2T scanned at 1.5G/s, 3.1T issued at 950M/s
#         3.1T resilvered, 59.62% done, 1h23m to go

# 7. Verify after completion
zpool status tank
# All drives should show ONLINE
```

**Duration**: 4-12 hours (depends on drive size and data amount)

---

### Operation 4: Add vDev to Pool

**WARNING**: vDevs cannot be removed, only added!

**Use Case**: Expand storage capacity

**Procedure**:

```bash
# 1. Identify new drives
camcontrol devlist

# 2. Add new RAIDZ3 vDev to pool
# Example: Add 8x new 20TB drives
zpool add tank RAIDZ3 da9 da10 da11 da12 da13 da14 da15 da16

# 3. Verify
zpool status tank
zpool list tank

# New capacity should reflect added drives
```

**Important**:
- New vDev should match existing vDev type (RAIDZ3)
- Data will NOT rebalance automatically (new writes go to both vDevs)
- Cannot remove vDev once added

---

### Operation 5: Optimize Pool Performance

**Use Case**: Improve performance after adding drives or heavy writes

**Defragmentation** (not applicable to ZFS):
- ZFS does not require defragmentation
- Copy-on-write (COW) prevents fragmentation

**Rebalance Data**:

ZFS does not automatically rebalance data across vDevs. To distribute data:

```bash
# Option 1: Copy data to new location, delete old
cp -a /mnt/tank/dataset /mnt/tank/dataset-new
rm -rf /mnt/tank/dataset
mv /mnt/tank/dataset-new /mnt/tank/dataset

# Option 2: Use zfs send/receive
zfs snapshot tank/dataset@rebalance
zfs send tank/dataset@rebalance | zfs receive tank/dataset-new
# Swap datasets
zfs rename tank/dataset tank/dataset-old
zfs rename tank/dataset-new tank/dataset
zfs destroy -r tank/dataset-old
```

**Adjust Record Size**:

```bash
# Check current recordsize
zfs get recordsize tank/kubernetes

# Set recordsize for large files (media)
zfs set recordsize=1M tank/media

# Set recordsize for small files (databases)
zfs set recordsize=16K tank/databases
```

---

## Storage Expansion

### Expansion Strategy

ZFS pools can be expanded by:
1. **Replacing drives with larger capacity** (one at a time)
2. **Adding new vDevs** (cannot remove)

### Procedure: Replace Drives with Larger Capacity

**Scenario**: Upgrade 8x 20TB drives to 8x 30TB drives

**Procedure**:

```bash
# 1. Replace drives ONE AT A TIME
# Replace first drive
zpool offline tank da0
# Physically swap drive
zpool replace tank da0 da0  # New drive takes same device ID

# Wait for resilver to complete
zpool status tank

# 2. Repeat for all drives in vDev

# 3. After ALL drives replaced, expand pool
zpool online -e tank da0 da1 da2 da3 da4 da5 da6 da7

# 4. Verify new capacity
zpool list tank
```

**Duration**: 1-2 weeks (resilver after each drive replacement)

---

## Performance Tuning

### Tuning Parameters

**ARC (Adaptive Replacement Cache)**:

```bash
# Check current ARC size
arc_summary

# Set max ARC size (in bytes) - 50% of RAM
# For 32GB RAM: 16GB = 17179869184 bytes
echo "17179869184" > /sys/module/zfs/parameters/zfs_arc_max
```

**ZFS Prefetch**:

```bash
# Enable/disable prefetch
zfs set primarycache=all tank  # Enable (default)
zfs set primarycache=metadata tank  # Disable for data
```

**Compression**:

```bash
# Check compression
zfs get compression tank

# Set compression algorithm
zfs set compression=lz4 tank  # Fast, recommended
zfs set compression=zstd tank  # Better ratio, slower
zfs set compression=off tank  # No compression
```

**Deduplication** (NOT recommended):

```bash
# DO NOT enable unless you have massive RAM (2GB RAM per 1TB data)
zfs get dedup tank
# dedup should be "off"
```

### Monitoring Performance

```bash
# I/O statistics
zpool iostat tank 5  # Update every 5 seconds

# Latency histogram
zpool iostat -l tank

# Check ARC hit ratio
arc_summary | grep "Hit Rate"
# Should be > 80%

# Check fragmentation
zpool list tank
# FRAG should be < 30%
```

---

## Disaster Recovery

### Scenario 1: TrueNAS VM Corrupted

**Recovery**:

See [proxmox-recovery.md](./proxmox-recovery.md#procedure-2-restore-vm-from-backup)

**Summary**:
1. Restore TrueNAS VM from Proxmox backup
2. Boot VM
3. Verify ZFS pools auto-import
4. Verify NFS shares available

**RTO**: 1-2 hours

---

### Scenario 2: ZFS Pool Import Failure

**Symptoms**: Pool not available after reboot

**Recovery**:

```bash
# 1. Check pool status
zpool status

# 2. List importable pools
zpool import

# 3. Force import pool
zpool import -f tank

# 4. If import fails, import read-only to recover data
zpool import -f -o readonly=on tank

# 5. Copy critical data to backup
rsync -av /mnt/tank/ /mnt/backup/

# 6. Export pool
zpool export tank

# 7. Reimport normally
zpool import tank
```

---

### Scenario 3: Complete Data Loss

**Recovery**:

**Prerequisites**:
- External backup drive (ZFS replication)
- OR cloud backup (rclone)

**Procedure**:

```bash
# 1. Recreate pool
zpool create tank RAIDZ3 da0 da1 da2 da3 da4 da5 da6 da7
zpool add tank special mirror da8 da9

# 2. Restore from backup
# Option A: ZFS replication
zfs send -R backup/kubernetes | zfs receive tank/kubernetes

# Option B: rclone from cloud
rclone copy b2:homelab-backups/tank /mnt/tank/

# 3. Recreate NFS shares
# Via TrueNAS UI or:
midclt call sharing.nfs.create '{"path": "/mnt/tank/kubernetes", "networks": ["172.16.100.0/24"]}'

# 4. Restart NFS
service nfsd restart
```

**RTO**: 4-8 hours (depends on data size and backup location)

---

## Troubleshooting

### Issue: High I/O Wait

**Symptoms**: Slow performance, high latency

**Diagnosis**:

```bash
# Check I/O statistics
zpool iostat tank 1 10

# Check pool status
zpool status tank

# Check ARC hit rate
arc_summary | grep "Hit Rate"

# Check fragmentation
zpool list tank
```

**Resolution**:

```bash
# If fragmentation > 30%:
# Run scrub
zpool scrub tank

# If ARC hit rate < 80%:
# Increase ARC size (see Performance Tuning)

# If pool is degraded:
# Replace failed drives
```

---

### Issue: Out of Space

**Symptoms**: Write operations failing, pool at 100%

**Diagnosis**:

```bash
# Check capacity
zpool list tank
zfs list -o space

# Find largest datasets
zfs list -o name,used,avail,refer | sort -k2 -h
```

**Resolution**:

```bash
# Delete old snapshots
zfs destroy tank/kubernetes@old-snapshot

# Delete unused data
rm -rf /mnt/tank/unused/

# Expand pool (add drives or replace with larger)
```

---

### Issue: Cannot Access NFS Share

**Symptoms**: Kubernetes PVCs stuck in Pending

**Diagnosis**:

```bash
# Check NFS service
service nfsd status

# Check exports
showmount -e localhost

# Check permissions
ls -ld /mnt/tank/kubernetes
```

**Resolution**:

```bash
# Restart NFS
service nfsd restart

# Recreate export
midclt call sharing.nfs.query
midclt call sharing.nfs.create '{"path": "/mnt/tank/kubernetes", "networks": ["172.16.100.0/24"]}'

# Fix permissions
chmod 755 /mnt/tank/kubernetes
```

---

### Issue: Slow Scrub/Resilver

**Symptoms**: Scrub taking longer than expected

**Diagnosis**:

```bash
# Check scrub status
zpool status tank

# Check I/O priority
cat /sys/module/zfs/parameters/zfs_resilver_delay
```

**Resolution**:

```bash
# Increase scrub/resilver priority
echo 0 > /sys/module/zfs/parameters/zfs_resilver_delay
echo 0 > /sys/module/zfs/parameters/zfs_scrub_delay

# Increase I/O limit
echo 5000 > /sys/module/zfs/parameters/zfs_resilver_min_time_ms
```

---

## References

### Official Documentation

- [TrueNAS Scale Documentation](https://www.truenas.com/docs/scale/)
- [OpenZFS Documentation](https://openzfs.github.io/openzfs-docs/)
- [ZFS Administration Guide](https://docs.oracle.com/cd/E19253-01/819-5461/6n7ht6r00/index.html)

### Guides

- [ZFS Best Practices](https://wiki.archlinux.org/title/ZFS#Best_practices)
- [TrueNAS Hardware Guide](https://www.truenas.com/docs/scale/gettingstarted/scalehardwareguide/)
- [ZFS Tuning Guide](https://openzfs.github.io/openzfs-docs/Performance%20and%20Tuning/Workload%20Tuning.html)

### Related Runbooks

- [proxmox-recovery.md](./proxmox-recovery.md) - Proxmox recovery procedures
- [talos-upgrade.md](./talos-upgrade.md) - Talos cluster upgrades

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

### ZFS Pool Commands

```bash
# List pools
zpool list

# Pool status
zpool status tank

# Pool I/O stats
zpool iostat tank

# Scrub pool
zpool scrub tank

# Import pool
zpool import tank

# Export pool
zpool export tank

# Upgrade pool
zpool upgrade tank
```

### ZFS Dataset Commands

```bash
# List datasets
zfs list

# Create dataset
zfs create tank/newdataset

# Delete dataset
zfs destroy tank/dataset

# Snapshot
zfs snapshot tank/dataset@snapshot-name

# Rollback
zfs rollback tank/dataset@snapshot-name

# Clone
zfs clone tank/dataset@snapshot tank/clone

# Send/receive
zfs send tank/dataset@snap | zfs receive backup/dataset
```

### ZFS Properties

```bash
# Get property
zfs get all tank/dataset

# Set property
zfs set compression=lz4 tank/dataset
zfs set recordsize=1M tank/dataset
zfs set atime=off tank/dataset

# Inherit property
zfs inherit compression tank/dataset
```

### TrueNAS CLI (midclt)

```bash
# Query configuration
midclt call system.general.config

# Query pools
midclt call pool.query

# Query datasets
midclt call pool.dataset.query

# Query NFS shares
midclt call sharing.nfs.query

# Create NFS share
midclt call sharing.nfs.create '{"path": "/mnt/tank/share"}'
```
