output "schedule_id" {
  description = "The ID of the backup schedule"
  value       = var.schedule_id
}

output "schedule" {
  description = "The cron schedule for backups"
  value       = var.schedule
}

output "storage" {
  description = "The storage location for backups"
  value       = var.storage
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

output "prune_backups" {
  description = "The prune-backups parameter used for the backup schedule"
  value       = local.prune_backups
}

output "pvesh_command" {
  description = "The pvesh command that will be executed"
  value       = "pvesh create /cluster/backup ${local.pvesh_params}"
  sensitive   = false
}
