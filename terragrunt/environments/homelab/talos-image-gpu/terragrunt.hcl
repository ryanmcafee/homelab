# Homelab - Talos GPU Image Factory
# Downloads custom Talos image with NVIDIA GPU extensions
# NOTE: This image is separate from base image due to nvidia-container-toolkit
# incompatibility with nfs-utils/rpc-statd

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}

terraform {
  source = "../../../modules//talos-image"
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
  talos_version = include.env.locals.talos_version
  node_name     = include.env.locals.proxmox_node
  datastore_id  = include.env.locals.iso_storage_pool

  # GPU-specific system extensions
  # NOTE: nvidia-container-toolkit conflicts with nfs-utils (glibc incompatibility)
  # GPU nodes don't need NFS client - storage is provided via network
  system_extensions = [
    "siderolabs/qemu-guest-agent",         # Better VM integration with Proxmox
    "siderolabs/intel-ucode",              # Intel CPU microcode updates
    "siderolabs/i915-ucode",               # Intel GPU firmware
    "siderolabs/nonfree-kmod-nvidia",      # NVIDIA proprietary kernel driver
    "siderolabs/nvidia-container-toolkit", # NVIDIA container runtime for GPU workloads
    "siderolabs/iscsi-tools",              # iSCSI client for democratic-csi block storage
  ]

  # Checksum verification
  verify_checksum = false
  save_schematic  = true
}
