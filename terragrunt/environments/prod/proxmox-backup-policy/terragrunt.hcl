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
  schedule    = "0 3 * * *"  # 3 AM daily
  storage     = include.env.locals.vm_storage_pool
  mode        = "snapshot"
  compression = "zstd"

  # Backup all VMs with 'homelab' tag
  include_all_vms = false
  tags            = ["homelab", "dev"]

  # Retention policy (shorter for dev)
  keep_daily  = 3
  keep_weekly = 2

  # Notifications
  notification_enabled = false
}
