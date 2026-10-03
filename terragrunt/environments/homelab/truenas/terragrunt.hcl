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

  # Placeholder so `terraform validate` runs without applied state (CI).
  mock_outputs = {
    pool_id = "mock-pool"
  }
  mock_outputs_allowed_terraform_commands = ["validate"]
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

  # Secondary NIC for VLAN 10
  lan_network_enabled = true
  lan_network_bridge  = "vmbr0"
  lan_network_vlan_id = 10

  # TrueNAS ISO — only consumed when use_template = false (the VM is cloned
  # from template 9000 below, so no ISO is downloaded or attached today)
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
  use_template   = true
  template_vm_id = 9000

  # Network for Ansible configuration
  # Prefix length comes from LAN_CIDR rather than a hard-coded /24: a fork on a
  # /23 or /16 would otherwise get a netmask that does not match its own LAN.
  truenas_static_ip = "${include.env.locals.truenas_ip}/${split("/", include.env.locals.subnet)[1]}"
  truenas_gateway   = include.env.locals.gateway
  truenas_hostname  = include.env.locals.truenas_hostname
  # TRUENAS_LAN_IP is optional in the schema — not every fork has a separate
  # storage VLAN — and the module's default for this variable is "".
  truenas_lan_static_ip = try(include.env.locals.config.TRUENAS_LAN_IP, "")

  # Ansible setup (runs after VM is up)
  run_ansible_setup      = true
  ansible_working_dir    = "${get_terragrunt_dir()}/../../../../ansible"
  truenas_admin_password = get_env("TRUENAS_ADMIN_PASSWORD", "")
  cloudflare_api_token   = get_env("CLOUDFLARE_API_TOKEN", "")

  # DNS records for TrueNAS
  dns_entries = flatten([
    for domain in compact([include.env.locals.local_dns_domain, include.env.locals.base_fqdn]) : [
      { fqdn = "truenas.${domain}", type = "A", host = include.env.locals.truenas_ip },
      { fqdn = "nas.${domain}", type = "A", host = include.env.locals.truenas_ip }
    ]
  ])
}
