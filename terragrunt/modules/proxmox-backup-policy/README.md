# Proxmox Backup Policy Module

This module configures automated backup schedules for Proxmox VMs with flexible retention policies.

## Overview

The module creates backup schedules using Proxmox's native backup functionality. It supports:

- Cron-based scheduling
- Multiple backup modes (snapshot, suspend, stop)
- Compression options (zstd recommended)
- Flexible retention policies
- Tag-based or ID-based VM selection
- Optional notifications

## Usage

### Basic Daily Backup

```hcl
module "daily_backup" {
  source = "../../modules/proxmox-backup-policy"

  schedule_id = "daily-backup"
  schedule    = "0 2 * * *"  # 2 AM daily
  storage     = "backup-storage"
  mode        = "snapshot"
  compression = "zstd"

  # Backup all VMs
  include_all_vms = true

  # Retention: 7 daily, 4 weekly
  keep_daily  = 7
  keep_weekly = 4
}
```

### Selective Backup by Tags

```hcl
module "critical_backup" {
  source = "../../modules/proxmox-backup-policy"

  schedule_id = "critical-hourly"
  schedule    = "0 * * * *"  # Every hour
  storage     = "backup-storage"

  # Only backup VMs with 'critical' tag
  tags = ["critical"]

  # Extended retention for critical systems
  keep_hourly  = 24
  keep_daily   = 30
  keep_weekly  = 12
  keep_monthly = 6
}
```

### Backup Specific VMs

```hcl
module "infrastructure_backup" {
  source = "../../modules/proxmox-backup-policy"

  schedule_id = "infra-backup"
  schedule    = "0 3 * * *"  # 3 AM daily
  storage     = "backup-storage"

  # Specific VM IDs
  vm_ids = [100, 101, 102]  # TrueNAS, Talos CPs

  keep_daily  = 7
  keep_weekly = 4
}
```

## Variables

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| schedule_id | Unique identifier for the backup schedule | `string` | "daily-backup" | no |
| enabled | Whether the schedule is enabled | `bool` | true | no |
| schedule | Cron schedule (e.g., '0 2 * * *') | `string` | "0 2 * * *" | no |
| storage | Target storage for backups | `string` | n/a | yes |
| mode | Backup mode (snapshot/suspend/stop) | `string` | "snapshot" | no |
| compression | Compression algorithm | `string` | "zstd" | no |
| include_all_vms | Backup all VMs | `bool` | false | no |
| vm_ids | Specific VM IDs to backup | `list(number)` | [] | no |
| tags | Tags to filter VMs | `list(string)` | [] | no |
| keep_last | Keep last N backups | `number` | null | no |
| keep_hourly | Keep N hourly backups | `number` | null | no |
| keep_daily | Keep N daily backups | `number` | 7 | no |
| keep_weekly | Keep N weekly backups | `number` | 4 | no |
| keep_monthly | Keep N monthly backups | `number` | null | no |
| keep_yearly | Keep N yearly backups | `number` | null | no |
| notification_enabled | Enable notifications | `bool` | false | no |
| notification_mode | When to notify (always/on-failure) | `string` | "on-failure" | no |
| notification_target | Notification target | `string` | null | no |

## Outputs

| Name | Description |
|------|-------------|
| schedule_id | The backup schedule ID |
| schedule | The cron schedule |
| storage | The backup storage location |
| retention_policy | The retention policy configuration |

## Backup Modes

- **snapshot**: Creates a snapshot without stopping the VM (recommended for most cases)
- **suspend**: Suspends the VM during backup (ensures consistency)
- **stop**: Stops the VM before backup (maximum consistency, causes downtime)

## Compression Options

- **zstd**: Best compression ratio with good performance (recommended)
- **gzip**: Good compression, moderate CPU usage
- **lzo**: Fast, lower compression ratio
- **none**: No compression (fastest, largest backups)

## Retention Strategy

The retention policy follows a GFS (Grandfather-Father-Son) approach:

- **Hourly**: Short-term recovery (same day)
- **Daily**: Recent changes (last week)
- **Weekly**: Medium-term recovery (last month)
- **Monthly**: Long-term recovery (last year)
- **Yearly**: Compliance and archival

Example retention for production systems:
```hcl
keep_hourly  = 24    # Last 24 hours
keep_daily   = 7     # Last week
keep_weekly  = 4     # Last month
keep_monthly = 12    # Last year
keep_yearly  = 3     # 3 years of annual backups
```

## Storage Requirements

Estimate backup storage needs:
```
Total Storage = (VM Size × Retention Count × Compression Ratio)

Example for 100GB VM:
- Daily (7):   700GB × 0.5 (zstd) = 350GB
- Weekly (4):  400GB × 0.5 = 200GB
- Total: ~550GB for one VM
```

## Notes

- Backups run on the Proxmox host, not in the VM
- Snapshot mode requires qemu-guest-agent for best results
- Schedule times should avoid peak usage periods
- Test restore procedures regularly
- Monitor backup storage capacity
- Consider offsite backup replication for DR

## Related Documentation

- [Proxmox Backup Documentation](https://pve.proxmox.com/wiki/Backup_and_Restore)
- [Vzdump Tool](https://pve.proxmox.com/wiki/Vzdump)
