# Development - TrueNAS VM
# Provisions TrueNAS Scale VM with HBA passthrough

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
  vm_name  = "truenas-dev"
  vm_id    = include.env.locals.truenas_vm_id
  node_name = include.env.locals.proxmox_node
  pool_id   = dependency.zfs_pool.outputs.pool_id

  # Resources
  cpu_cores = 4
  memory_mb = 32768  # 32GB for ZFS ARC

  # Storage
  boot_disk_datastore = include.env.locals.vm_storage_pool
  boot_disk_size      = 32

  # HBA Passthrough (Broadcom 9400-8i)
  hba_passthrough_enabled = true
  hba_pci_id              = include.env.locals.hba_pci_id

  # Network
  network_bridge  = "vmbr0"
  network_vlan_id = include.env.locals.vlan_id

  # TrueNAS ISO
  iso_storage          = include.env.locals.iso_storage_pool
  truenas_iso_url      = "https://download.truenas.com/TrueNAS-SCALE-Dragonfish/23.10.1/TrueNAS-SCALE-23.10.1.iso"
  truenas_iso_filename = "truenas-scale-23.10.1.iso"

  # Post-installation
  wait_for_api    = false
  truenas_api_url = "https://${include.env.locals.truenas_ip}"

  tags = ["homelab", "dev", "storage"]
}
