# Homelab - TrueNAS VM
# Provisions TrueNAS Scale VM with HBA passthrough for direct disk access

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}

terraform {
  source = "../../../modules//truenas"
}

dependency "zfs_pool" {
  config_path = "../proxmox-zfs-pool"
}

# Configure Proxmox provider
# API token is read from TF_VAR_proxmox_api_token_id and TF_VAR_proxmox_api_token_secret via env.hcl
generate "provider_proxmox" {
  path      = "provider_proxmox.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "proxmox" {
  endpoint  = "${include.env.locals.proxmox_endpoint}"
  api_token = "${include.env.locals.proxmox_api_token_id}=${include.env.locals.proxmox_api_token_secret}"
  insecure  = ${include.env.locals.proxmox_insecure}

  ssh {
    agent       = false
    username    = "${include.env.locals.proxmox_ssh_user}"
    private_key = file("${include.env.locals.proxmox_ssh_private_key}")
  }
}
EOF
}

inputs = {
  vm_name   = "truenas"
  vm_id     = include.env.locals.truenas_vm_id
  node_name = include.env.locals.proxmox_node
  pool_id   = dependency.zfs_pool.outputs.pool_id

  # Resources - 32GB for ZFS ARC cache
  cpu_cores = 4
  memory_mb = 32768

  # Storage
  boot_disk_datastore = include.env.locals.vm_storage_pool
  boot_disk_size      = 32

  # HBA Passthrough for direct disk access
  # Pass through both storage controllers (NVMe SSDs and SATA drives)
  hba_passthrough_enabled = true
  hba_devices             = include.env.locals.hba_devices

  # Network
  network_bridge  = "vmbr0"
  network_vlan_id = include.env.locals.vlan_id

  # TrueNAS ISO
  iso_storage          = include.env.locals.iso_storage_pool
  truenas_iso_url      = "https://download.sys.truenas.net/TrueNAS-SCALE-Goldeye/25.10.1/TrueNAS-SCALE-25.10.1.iso"
  truenas_iso_filename = "truenas-scale-25.10.1.iso"

  # Boot order - Disk first, ISO second (for post-installation)
  boot_order = ["virtio0", "ide2"]

  # Post-installation
  # TrueNAS configuration is handled by Ansible playbooks
  wait_for_api    = false
  truenas_api_url = "https://${include.env.locals.truenas_ip}"

  tags = ["homelab", "storage", "truenas"]
}
