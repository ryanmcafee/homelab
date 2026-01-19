# Development - Proxmox Backup Policy
# Configures automated VM backup schedules

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}

terraform {
  source = "../../../modules//proxmox-backup-policy"
}

# Configure Proxmox provider
generate "provider_proxmox" {
  path      = "provider_proxmox.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "proxmox" {
  endpoint = "${include.env.locals.proxmox_endpoint}"
  insecure = ${include.env.locals.proxmox_insecure}
}
EOF
}

inputs = {
  schedule_id = "dev-daily-backup"
  enabled     = true
  schedule    = "03:00"  # 3 AM daily (systemd calendar event format)
  storage     = include.env.locals.vm_storage_pool
  mode        = "snapshot"
  compression = "zstd"

  # Backup all VMs (tags not supported by Proxmox backup API)
  include_all_vms = true
  tags            = []  # Tags not supported for backup job filtering

  # Retention policy (shorter for dev)
  keep_daily  = 3
  keep_weekly = 2

  # Notifications
  notification_enabled = false

  # Proxmox SSH connection
  proxmox_host            = include.env.locals.proxmox_host
  proxmox_ssh_user        = include.env.locals.proxmox_ssh_user
  proxmox_ssh_private_key = include.env.locals.proxmox_ssh_private_key
  proxmox_ssh_port        = include.env.locals.proxmox_ssh_port
}
