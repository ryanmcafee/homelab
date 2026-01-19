/**
 * Proxmox Backup Policy Module
 *
 * NOTE: The bpg/proxmox provider does not support backup schedules as of v0.93.0.
 * This module uses pvesh CLI via SSH to create backup schedules directly on the Proxmox host.
 */

terraform {
  required_version = ">= 1.7.0"
}

locals {
  # Build prune-backups parameter (comma-separated key=value pairs)
  retention_parts = compact([
    var.keep_last != null ? "keep-last=${var.keep_last}" : null,
    var.keep_hourly != null ? "keep-hourly=${var.keep_hourly}" : null,
    var.keep_daily != null ? "keep-daily=${var.keep_daily}" : null,
    var.keep_weekly != null ? "keep-weekly=${var.keep_weekly}" : null,
    var.keep_monthly != null ? "keep-monthly=${var.keep_monthly}" : null,
    var.keep_yearly != null ? "keep-yearly=${var.keep_yearly}" : null,
  ])
  prune_backups = length(local.retention_parts) > 0 ? join(",", local.retention_parts) : "keep-all=1"

  # Build VM selection parameters
  vmid_list = length(var.vm_ids) > 0 ? join(",", var.vm_ids) : null
  all_vms   = var.include_all_vms ? "1" : "0"

  # Build notification parameters
  mailnotification = var.notification_enabled ? var.notification_mode : null
  mailto          = var.notification_enabled && var.notification_target != null ? var.notification_target : null

  # SSH connection string
  ssh_cmd = "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${var.proxmox_ssh_private_key} -p ${var.proxmox_ssh_port} ${var.proxmox_ssh_user}@${var.proxmox_host}"

  # Build pvesh command parameters
  # Note: Proxmox backup jobs do not support VM tag filtering
  # Tags are ignored and only vmid/all selection is used
  pvesh_params = join(" ", compact([
    "--id ${var.schedule_id}",
    "--schedule '${var.schedule}'",
    "--storage ${var.storage}",
    "--mode ${var.mode}",
    "--compress ${var.compression}",
    "--enabled ${var.enabled ? 1 : 0}",
    "--prune-backups '${local.prune_backups}'",
    local.all_vms == "1" ? "--all 1" : null,
    local.vmid_list != null ? "--vmid ${local.vmid_list}" : null,
    local.mailnotification != null ? "--mailnotification ${local.mailnotification}" : null,
    local.mailto != null ? "--mailto ${local.mailto}" : null,
  ]))
}

# Create backup schedule via pvesh
resource "null_resource" "backup_schedule" {
  triggers = {
    schedule_id       = var.schedule_id
    schedule          = var.schedule
    storage           = var.storage
    mode              = var.mode
    compression       = var.compression
    enabled           = var.enabled
    prune_backups     = local.prune_backups
    all_vms           = local.all_vms
    vmid_list         = local.vmid_list
    tags              = join(",", var.tags)
    mailnotification  = local.mailnotification
    mailto            = local.mailto
    ssh_host          = var.proxmox_host
    ssh_user          = var.proxmox_ssh_user
    ssh_port          = var.proxmox_ssh_port
    ssh_key           = var.proxmox_ssh_private_key
  }

  # Create or update backup schedule
  provisioner "local-exec" {
    command = <<-EOT
      ${local.ssh_cmd} "pvesh get /cluster/backup/${var.schedule_id} >/dev/null 2>&1 && \
        pvesh set /cluster/backup/${var.schedule_id} ${local.pvesh_params} || \
        pvesh create /cluster/backup ${local.pvesh_params}"
    EOT
  }

  # Delete backup schedule on destroy
  provisioner "local-exec" {
    when    = destroy
    command = <<-EOT
      ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -i ${self.triggers.ssh_key} \
        -p ${self.triggers.ssh_port} \
        ${self.triggers.ssh_user}@${self.triggers.ssh_host} \
        "pvesh delete /cluster/backup/${self.triggers.schedule_id} || true"
    EOT
  }
}
