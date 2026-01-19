output "schedule_id" {
  description = "The ID of the backup schedule"
  value       = proxmox_virtual_environment_backup_schedule.this.schedule_id
}

output "schedule" {
  description = "The cron schedule for backups"
  value       = proxmox_virtual_environment_backup_schedule.this.schedule
}

output "storage" {
  description = "The storage location for backups"
  value       = proxmox_virtual_environment_backup_schedule.this.storage
}

output "retention_policy" {
  description = "The retention policy configuration"
  value = {
    keep_last    = var.keep_last
    keep_hourly  = var.keep_hourly
    keep_daily   = var.keep_daily
    keep_weekly  = var.keep_weekly
    keep_monthly = var.keep_monthly
    keep_yearly  = var.keep_yearly
  }
}
