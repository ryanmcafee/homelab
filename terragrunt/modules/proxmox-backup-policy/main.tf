/**
 * Proxmox Backup Policy Module
 *
 * Configures automated backup schedules for Proxmox VMs with retention policies.
 * Supports snapshot-based backups with compression.
 */

terraform {
  required_version = ">= 1.7.0"
}

resource "proxmox_virtual_environment_backup_schedule" "this" {
  schedule_id = var.schedule_id
  enabled     = var.enabled
  schedule    = var.schedule
  storage     = var.storage
  mode        = var.mode
  compression = var.compression

  selection {
    include_all = var.include_all_vms
    vm_ids      = var.vm_ids
    tags        = var.tags
  }

  retention {
    keep_last   = var.keep_last
    keep_hourly = var.keep_hourly
    keep_daily  = var.keep_daily
    keep_weekly = var.keep_weekly
    keep_monthly = var.keep_monthly
    keep_yearly = var.keep_yearly
  }

  notification {
    enabled = var.notification_enabled
    mode    = var.notification_mode
    target  = var.notification_target
  }
}
