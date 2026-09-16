# Homelab - Control-Plane ZFS Pool (cp-storage)
#
# WHY THIS EXISTS
# ---------------
# A dedicated datastore for the control-plane system disks so etcd's fsync path
# never shares a device with worker I/O. Before this pool, cp-1/2/3 and every
# worker VM disk lived on the same `vm-storage` ZFS mirror: a single large write
# burst from a worker (a 1.6 GB image pull expands to ~6.5 GB written because
# Talos keeps compressed + unpacked layers for Spegel) saturated the pool, etcd
# fdatasync went from ~1 ms to 2.5-48 s on all three control planes at once,
# raft heartbeats were missed, and the Talos layer-2 VIP was removed and
# re-elected — the client-visible "the API is gone". See ADR-016.
#
# TRADE-OFF: SINGLE DEVICE, NO REDUNDANCY
# ---------------------------------------
# `zfs_pool_type = "stripe"` over one NVMe device means this pool has no
# redundancy. That is deliberate: etcd is already replicated across the three
# control-plane nodes, so the failure domain that matters is the cluster, not
# the disk, and isolating the fsync path is worth more than a second copy of a
# replicated database. The trade-off (and the follow-up of adding a second NVMe
# to mirror it, plus regular `talosctl etcd snapshot`) is recorded in ADR-016.
#
# DESTRUCTIVE: THE MODULE RUNS `zpool create -f`
# ----------------------------------------------
# `create_zfs_pool = true` makes the module run `zpool create -f` over SSH,
# which WIPES the device. `/dev/disk/by-id/nvme-Samsung_SSD_990_PRO_1TB_S6Z1NU0XC45503Z`
# was verified unused (no partitions, no LVM PV, no ZFS label) before this file
# was written. `docs/runbooks/control-plane-storage.md` requires confirming the
# device is still unused before the first apply, and covers the disk migration
# and rollback.
#
# NOTE: this instance is storage-only — `create_resource_pool = false`. The
# `homelab` resource pool is owned by ../proxmox-zfs-pool; `output "pool_id"` is
# null here, so talos-cluster still takes `pool_id` from that unit.

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}

terraform {
  source = "../../../modules//proxmox-zfs-pool"
}

dependency "proxmox_cluster" {
  config_path = "../proxmox-cluster"

  mock_outputs = {
    dns_records = {}
  }
  mock_outputs_allowed_terraform_commands = ["validate", "plan"]
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
  # Storage-only instance: the `homelab` resource pool belongs to ../proxmox-zfs-pool
  create_resource_pool = false
  proxmox_node         = include.env.locals.proxmox_node

  # SSH configuration for ZFS pool creation
  proxmox_host    = include.env.locals.proxmox_host
  ssh_user        = include.env.locals.proxmox_ssh_user
  ssh_private_key = include.env.locals.proxmox_ssh_private_key

  # ZFS pool creation
  # DESTRUCTIVE: runs `zpool create -f` over SSH, which wipes the device.
  # Confirm the device is unused first (see runbook / header comment above).
  create_zfs_pool = true
  zfs_pool_name   = "cp-storage"
  zfs_pool_type   = "stripe" # single device: no redundancy, etcd is replicated x3 (ADR-016)

  # Unused Samsung 990 PRO 1 TB (TLC, PCIe 4.0) dedicated to the control planes.
  # by-id path so the pool survives NVMe enumeration order changes.
  zfs_devices = [
    "/dev/disk/by-id/nvme-Samsung_SSD_990_PRO_1TB_S6Z1NU0XC45503Z",
  ]

  # ZFS pool properties
  zfs_ashift      = 12     # 12 for 4K sector drives
  zfs_compression = "lz4"  # Fast compression with minimal CPU impact
  zfs_atime       = "off"  # Disable access time updates
  zfs_recordsize  = "128k" # Good default for VM storage

  # Proxmox storage configuration
  create_storage_config = true
  storage_id            = include.env.locals.cp_storage_pool
  thin_provisioning     = true

  # VM system disks only — no `rootdir` (containers) and no ISOs/backups, so
  # nothing else can be placed on the disk etcd fsyncs to.
  content_types = ["images"]
}
