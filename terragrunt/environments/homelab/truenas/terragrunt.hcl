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

# Configure UniFi provider for DNS records
generate "provider_unifi" {
  path      = "provider_unifi.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "unifi" {
  api_url        = "${include.env.locals.unifi_api_url}"
  username       = "${include.env.locals.unifi_username}"
  password       = "${include.env.locals.unifi_password}"
  allow_insecure = ${include.env.locals.unifi_insecure}
  site           = "${include.env.locals.unifi_site}"
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
  network_vlan_id = null

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

  # Template cloning (Phase 2 automation)
  use_template    = true
  template_vm_id  = 9000

  # Network for Ansible configuration
  truenas_static_ip = "172.16.100.150/24"
  truenas_gateway   = include.env.locals.gateway
  truenas_hostname  = "truenas.${include.env.locals.base_fqdn}"

  # Ansible setup (runs after VM is up)
  run_ansible_setup      = true
  ansible_working_dir    = "${get_terragrunt_dir()}/../../../../ansible"
  truenas_admin_password = get_env("TRUENAS_ADMIN_PASSWORD", "")
  cloudflare_api_token   = get_env("CLOUDFLARE_API_TOKEN", "")

  # DNS records for TrueNAS
  dns_entries = [
    { fqdn = "truenas.home.lab", type = "A", host = include.env.locals.truenas_ip },
    { fqdn = "truenas.${include.env.locals.base_fqdn}", type = "A", host = include.env.locals.truenas_ip },
    { fqdn = "nas.home.lab", type = "A", host = include.env.locals.truenas_ip },
    { fqdn = "nas.${include.env.locals.base_fqdn}", type = "A", host = include.env.locals.truenas_ip }
  ]
}
