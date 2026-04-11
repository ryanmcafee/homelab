# Homelab Environment Configuration
# Consolidated single environment (previously dev/prod split)
# Full infrastructure deployment on Proxmox with ZFS storage

locals {
  # Inherit base configuration
  base_config = read_terragrunt_config(find_in_parent_folders("_env/env.hcl"))

  # Environment-specific settings
  environment = "homelab"

  # Proxmox configuration
  # API token is read from TF_VAR_proxmox_api_token_id and TF_VAR_proxmox_api_token_secret
  proxmox_api_token_id     = get_env("TF_VAR_proxmox_api_token_id", "")
  proxmox_api_token_secret = get_env("TF_VAR_proxmox_api_token_secret", "")
  proxmox_endpoint         = "https://172.16.100.250:8006"
  proxmox_node             = "proxmox"
  proxmox_insecure         = true
  proxmox_host             = "172.16.100.250"
  proxmox_ssh_user         = "root"
  proxmox_ssh_private_key  = "~/.ssh/id_ed25519"
  proxmox_ssh_port         = 22

  # Storage configuration
  vm_storage_pool  = "vm-storage" # ZFS pool managed by Terraform
  iso_storage_pool = "local"

  # Network configuration
  vlan_id     = 100
  subnet      = "172.16.100.0/24"
  gateway     = "172.16.100.1"
  dns_servers = ["172.16.100.1"]

  # MetalLB configuration
  metallb_enabled  = true
  metallb_ip_start = "172.16.100.100"
  metallb_ip_end   = "172.16.100.200"

  # BGP configuration
  bgp_asn_k8s   = 64512
  bgp_asn_unifi = 64513
  bgp_peer_ip   = "172.16.100.1"

  # Cluster configuration
  cluster_name     = "homelab"
  cluster_endpoint = "172.16.100.11"
  vip_endpoint     = "172.16.100.10"

  # Talos configuration (using latest stable versions)
  talos_version      = "v1.12.2"
  kubernetes_version = "v1.32.0"

  # Image Cache Configuration
  # Enables local caching of container images to prevent failures from flaky external registries
  # See: https://docs.siderolabs.com/talos/v1.12/configure-your-talos-cluster/images-container-runtime/image-cache-registry-mirror
  #
  # The image cache is deployed on TrueNAS via the truenas_storage Ansible role.
  # Run the Ansible playbook first to generate certificates and deploy the cache:
  #   cd ansible && ansible-playbook playbooks/truenas-full-setup.yml --tags image-cache
  #
  # After running the playbook, the CA certificate will be available at:
  #   ansible/certs/image-cache-ca.crt
  image_cache_endpoint   = "https://${local.truenas_ip}:5000"
  image_cache_ca_cert    = fileexists("${get_terragrunt_dir()}/../../../ansible/certs/image-cache-ca.crt") ? file("${get_terragrunt_dir()}/../../../ansible/certs/image-cache-ca.crt") : ""
  image_cache_registries = ["docker.io", "ghcr.io", "registry.k8s.io", "gcr.io", "quay.io"]

  # Spegel P2P Image Cache Configuration
  # Spegel provides stateless cluster-local OCI registry mirroring for P2P image distribution.
  # See: https://spegel.dev/docs/getting-started/#talos
  #
  # When enabled, this configures Talos to preserve unpacked image layers (required for Spegel)
  # and sets the containerd registry config path for Spegel's registry mirror.
  #
  # After enabling, deploy Spegel via Helm with these values:
  #   spegel:
  #     containerdRegistryConfigPath: /etc/cri/conf.d/hosts
  #
  # The spegel namespace requires privileged pod security:
  #   kubectl label namespace spegel pod-security.kubernetes.io/enforce=privileged
  spegel_enabled = true

  # TrueNAS configuration
  truenas_vm_id    = 150
  truenas_ip       = "172.16.100.150"
  truenas_nfs_path = "/mnt/storage/k8s"

  # Media NFS paths (granular storage)
  truenas_media_paths = {
    movies    = "/mnt/storage/movies"
    tv        = "/mnt/storage/tv"
    music     = "/mnt/storage/music"
    pictures  = "/mnt/storage/pictures"
    documents = "/mnt/storage/documents"
    downloads = "/mnt/storage/downloads"
  }

  # HBA devices for TrueNAS direct disk access
  # PCI passthrough for NVMe SSDs and SATA drives
  hba_devices = {
    "hba-nvme-ssds" = {
      pci_id       = "0000:c2:00.0"
      device_id    = "1000:00af" # Broadcom LSI vendor:device ID
      subsystem_id = "1000:3010" # Broadcom HBA 9400-8i subsystem ID
      iommu_group  = 12
      description  = "Broadcom LSI SAS3408 - 2x 1TB NVMe SSDs"
    }
    "sata-20tb-drives" = {
      pci_id       = "0000:49:00.0"
      device_id    = "1022:7901" # AMD vendor:device ID
      subsystem_id = "15d9:7901" # Supermicro subsystem ID
      iommu_group  = 58
      description  = "AMD FCH SATA Controller #1 - 8x 20TB SATA drives"
    }
    "sata-20tb-drives-2" = {
      pci_id       = "0000:48:00.0"
      device_id    = "1022:7901" # AMD vendor:device ID
      subsystem_id = "15d9:7901" # Supermicro subsystem ID
      iommu_group  = 57
      description  = "AMD FCH SATA Controller #2 - 3x 20TB SATA drives"
    }
  }

  # GPU vendor selection (matches configuration/environments/homelab.yaml GPU_VENDOR)
  # Phase 7 flips to "intel" after hardware bring-up verification
  gpu_vendor = "nvidia"

  # GPU passthrough (NVIDIA Quadro P2200)
  # Verified via: ssh root@172.16.100.250 'lspci -nn | grep -i nvidia'
  # c1:00.0 VGA compatible controller: NVIDIA Corporation GP106GL [Quadro P2200] [10de:1c31]
  gpu_pci_id = "0000:c1:00.0"

  # GPU device configuration for hardware mapping
  # Required for non-root API token PCI passthrough
  gpu_device = {
    device_id    = "10de:1c31" # NVIDIA Quadro P2200
    subsystem_id = "103c:131b" # HP subsystem
    iommu_group  = 11          # IOMMU group from /sys/kernel/iommu_groups
    description  = "NVIDIA Quadro P2200 for Plex transcoding"
  }

  # GPU passthrough - Intel Arc Pro B50
  # Verified via Phase 1 hardware spike:
  #   SPK-02: lspci -nn shows 0000:c3:00.0 [8086:e212]
  #   SPK-03: IOMMU group 14 (clean isolation)
  #   SPK-04: subsystem 8086:1114
  gpu_intel_pci_id = "0000:c3:00.0"

  gpu_intel_device = {
    device_id    = "8086:e212" # Intel Arc Pro B50 (Battlemage)
    subsystem_id = "8086:1114" # Intel subsystem
    iommu_group  = 14          # IOMMU group from /sys/kernel/iommu_groups (clean isolation)
    description  = "Intel Arc Pro B50 for Plex transcoding"
  }

  # Git repository
  repo_url        = "https://github.com/ryanmcafee/homelab"
  target_revision = "main"

  # Base FQDN
  base_fqdn = "ryanmcafee.com"

  # TrueNAS hostname for DNS and certificates
  truenas_hostname = "truenas.${local.base_fqdn}"

  # UniFi configuration (credentials via environment variables)
  unifi_api_url  = get_env("UNIFI_API", "")
  unifi_username = get_env("UNIFI_USERNAME", "")
  unifi_password = get_env("UNIFI_PASSWORD", "")
  unifi_insecure = true
  unifi_site     = get_env("UNIFI_SITE", "default")

  # Resource allocation
  # Control plane: 3 nodes x 8GB = 24GB total
  # Workers: 3 nodes x 50GB = 150GB total
  # Total cluster memory: 174GB

  control_plane_nodes = {
    "cp-1" = {
      ip        = "172.16.100.11"
      host_node = "proxmox"
      cores     = 2
      memory    = 8192 # 8GB
      disk_size = 50
    }
    "cp-2" = {
      ip        = "172.16.100.12"
      host_node = "proxmox"
      cores     = 2
      memory    = 8192 # 8GB
      disk_size = 50
    }
    "cp-3" = {
      ip        = "172.16.100.13"
      host_node = "proxmox"
      cores     = 2
      memory    = 8192 # 8GB
      disk_size = 50
    }
  }

  worker_nodes = {
    "worker-1" = {
      ip        = "172.16.100.21"
      host_node = "proxmox"
      cores     = 8
      memory    = 51200 # 50GB
      disk_size = 100
      gpu       = true # NVIDIA Quadro P2200 for Plex transcoding
    }
    "worker-2" = {
      ip        = "172.16.100.22"
      host_node = "proxmox"
      cores     = 4
      memory    = 51200 # 50GB
      disk_size = 100
      gpu       = false
    }
    "worker-3" = {
      ip        = "172.16.100.23"
      host_node = "proxmox"
      cores     = 4
      memory    = 51200 # 50GB
      disk_size = 100
      gpu       = false
    }
  }
}
