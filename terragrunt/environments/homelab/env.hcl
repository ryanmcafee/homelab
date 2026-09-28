# Homelab Environment Configuration
# Consolidated single environment (previously dev/prod split)
# Full infrastructure deployment on Proxmox with ZFS storage

locals {

  # Every operator-specific value — the domain, every address, the LAN CIDR, the
  # cluster and Proxmox node names, the git remote — is resolved from the
  # ConfigSet and never written into this file.
  # configuration/environments/homelab.yaml is gitignored; homelab.yaml.example
  # is a fork's starting point.
  #
  # Every `task tf:*` target exports this file first. By hand:
  #   task config:export:format FORMAT=json
  # A key the ConfigSet is missing stops the export instead of rendering
  # somebody else's topology (ADR-028, docs/contracts/fork-ability.md).
  config = jsondecode(file("${get_repo_root()}/configuration/resolved.json")).values

  # Environment-specific settings
  environment = "homelab"

  # Proxmox configuration
  # API token is read from TF_VAR_proxmox_api_token_id and TF_VAR_proxmox_api_token_secret
  proxmox_api_token_id     = get_env("TF_VAR_proxmox_api_token_id", "")
  proxmox_api_token_secret = get_env("TF_VAR_proxmox_api_token_secret", "")
  proxmox_endpoint         = "https://${local.config.PROXMOX_IP}:8006"
  proxmox_node             = local.config.PROXMOX_NODE
  proxmox_insecure         = true
  proxmox_host             = local.config.PROXMOX_IP
  proxmox_ssh_user         = "root"
  proxmox_ssh_private_key  = "~/.ssh/id_ed25519"
  proxmox_ssh_port         = 22

  # Storage configuration
  vm_storage_pool  = "vm-storage" # ZFS pool managed by Terraform
  cp_storage_pool  = "cp-storage" # Dedicated NVMe datastore for control-plane (etcd) system disks
  iso_storage_pool = "local"

  # Network configuration. vlan_id stays a literal: it is a tagging choice, not
  # an identity, and it names no host, network or person.
  vlan_id     = 100
  subnet      = local.config.LAN_CIDR
  gateway     = local.config.GATEWAY_IP
  dns_servers = [local.config.DNS_SERVER_IP]

  # LoadBalancer pool (Cilium LB IPAM + BGP); gitops-bootstrap writes the range
  # into the informational gitops-metadata ConfigMap
  lb_ipam_enabled = true
  lb_pool_start   = local.config.LB_POOL_START
  lb_pool_end     = local.config.LB_POOL_END

  # BGP configuration. ConfigSet values are strings; these are numbers to the
  # unifi provider and the Cilium templates.
  bgp_asn_k8s   = tonumber(local.config.BGP_K8S_ASN)
  bgp_asn_unifi = tonumber(local.config.BGP_ROUTER_ASN)
  bgp_peer_ip   = local.config.BGP_PEER_IP

  # Cluster configuration
  cluster_name     = local.config.CLUSTER_NAME
  cluster_endpoint = local.config.CP1_IP
  vip_endpoint     = local.config.CP_VIP

  # Talos configuration (using latest stable versions)
  talos_version      = "v1.12.2"
  kubernetes_version = "v1.32.0"

  # Image Cache Configuration
  # Enables local caching of container images to prevent failures from flaky external registries
  # See: https://docs.siderolabs.com/talos/v1.12/configure-your-talos-cluster/images-container-runtime/image-cache-registry-mirror
  #
  # The image cache is deployed on TrueNAS via the truenas_storage Ansible role.
  # Run the Ansible playbook first to generate certificates and deploy the cache:
  #   task truenas:image-cache   (truenas-setup.yml --tags image-cache)
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
  truenas_ip       = local.config.TRUENAS_IP
  truenas_nfs_path = "${local.config.NFS_BASE_PATH}/k8s"

  # Media NFS paths (granular storage)
  truenas_media_paths = {
    movies    = "${local.config.NFS_BASE_PATH}/movies"
    tv        = "${local.config.NFS_BASE_PATH}/tv"
    music     = "${local.config.NFS_BASE_PATH}/music"
    pictures  = "${local.config.NFS_BASE_PATH}/pictures"
    documents = "${local.config.NFS_BASE_PATH}/documents"
    downloads = "${local.config.NFS_BASE_PATH}/downloads"
  }

  # HBA devices for TrueNAS direct disk access
  # PCI passthrough for NVMe SSDs and SATA drives
  hba_devices = {
    "hba-nvme-ssds" = {
      pci_id       = "0000:c5:00.0"
      device_id    = "1000:00af" # Broadcom LSI vendor:device ID
      subsystem_id = "1000:3010" # Broadcom HBA 9400-8i subsystem ID
      iommu_group  = 16
      description  = "Broadcom LSI SAS3408 - 2x 1TB NVMe SSDs"
    }
    "sata-20tb-drives" = {
      pci_id       = "0000:49:00.0"
      device_id    = "1022:7901" # AMD vendor:device ID
      subsystem_id = "15d9:7901" # Supermicro subsystem ID
      iommu_group  = 62
      description  = "AMD FCH SATA Controller #1 - 8x 20TB SATA drives"
    }
    "sata-20tb-drives-2" = {
      pci_id       = "0000:48:00.0"
      device_id    = "1022:7901" # AMD vendor:device ID
      subsystem_id = "15d9:7901" # Supermicro subsystem ID
      iommu_group  = 61
      description  = "AMD FCH SATA Controller #2 - 3x 20TB SATA drives"
    }
  }

  # GPU vendor selection (matches configuration/environments/homelab.yaml GPU_VENDOR)
  # Phase 7 flipped to "intel" 2026-04-11T04:31:32Z after hardware bring-up verification
  gpu_vendor = "intel"

  # GPU passthrough (NVIDIA Quadro P2200)
  # Verified via: ssh root@<PROXMOX_IP> 'lspci -nn | grep -i nvidia'
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

  # GPU passthrough — Intel Arc Pro B50 (Battlemage G21)
  # Values read on the Proxmox host: PCI bus address and IDs from `lspci -nnk`, the
  # IOMMU group from /sys/bus/pci/devices/<addr>/iommu_group (AMD-Vi active, no
  # intel_iommu kernel flag needed).
  # Kernel driver currently bound to `xe`; Talos machine patch for Intel GPU loads `xe` + `mei` modules.
  # Active: gpu_vendor above is "intel"; talos-cluster passes this through to worker-1.
  gpu_intel_pci_id = "0000:c3:00.0"

  gpu_intel_device = {
    device_id    = "8086:e212" # Intel Arc Pro B50 (Battlemage G21)
    subsystem_id = "8086:1114" # Intel subsystem
    iommu_group  = 14          # Clean isolation (1 device in group)
    description  = "Intel Arc Pro B50 for Plex transcoding"
  }

  # Git repository ArgoCD reconciles from — a fork's own remote, not upstream.
  repo_url        = local.config.GITOPS_REPO_URL
  target_revision = "main"

  # Base FQDN. The root terragrunt.hcl deliberately has no default for this, so
  # an environment that fails to resolve it stops rather than inheriting one.
  base_fqdn = local.config.DOMAIN

  # TrueNAS hostname for DNS and certificates (a ConfigSet const key derived from DOMAIN)
  truenas_hostname = local.config.TRUENAS_HOSTNAME

  # UniFi configuration (credentials via environment variables)
  unifi_api_url  = get_env("UNIFI_API", "")
  unifi_username = get_env("UNIFI_USERNAME", "")
  unifi_password = get_env("UNIFI_PASSWORD", "")
  unifi_insecure = true
  unifi_site     = get_env("UNIFI_SITE", "default")

  # Resource allocation, per node. At this cluster's shape — three control
  # planes, three workers — that is 24GB of control plane and 150GB of worker.
  # The totals are a consequence of how many addresses the ConfigSet lists, so
  # they are not stated here as facts a fork would inherit wrongly.

  # NODE KEY PATTERNS. These must equal the schema's keyPatterns entries in
  # configuration/schema/network.schema.yaml, and the control-plane one must
  # equal contracts/cluster/topology.v1.yaml controlPlane.countKeyPattern.
  # TestTerragruntNodeMapsDeriveFromKeyPatterns fails if either drifts.
  cp_key_pattern     = "^CP([0-9]+)_IP$"
  worker_key_pattern = "^WORKER([0-9]+)_IP$"

  # Addresses and the hosting node come from the ConfigSet; the sizes stay here
  # because they are a capacity choice, not the operator's identity.
  #
  # The node maps are DERIVED from the ConfigSet's address keys rather than
  # enumerated. Three literal cp-N entries stated this cluster's topology as
  # firmly as a count would, and a fork editing terragrunt to add a fourth node
  # is a fork editing the repository — the thing ADR-035 removed one layer up.
  #
  # Ordinal -> address, keyed through tonumber so a CP01_IP key lands on cp-1,
  # the same node the ansible inventory names from the resolver's integer
  # .Ordinal. Two keys claiming one ordinal is refused by the resolver before
  # terragrunt ever reads the export.
  cp_ips = {
    for key, ip in local.config : tonumber(regex(local.cp_key_pattern, key)[0]) => ip
    if length(regexall(local.cp_key_pattern, key)) > 0
  }
  worker_ips = {
    for key, ip in local.config : tonumber(regex(local.worker_key_pattern, key)[0]) => ip
    if length(regexall(local.worker_key_pattern, key)) > 0
  }

  control_plane_nodes = {
    for ordinal, ip in local.cp_ips : "cp-${ordinal}" => {
      ip        = ip
      host_node = local.config.PROXMOX_NODE
      cores     = 2
      memory    = 8192 # 8GB
      disk_size = 50
    }
  }

  # Worker 1 is this repository's GPU node: the schema describes WORKER1_IP that
  # way and `homelab verify gpu` resolves the GPU node by that key. Sizing
  # follows the same split — the GPU worker gets the extra cores.
  worker_nodes = {
    for ordinal, ip in local.worker_ips : "worker-${ordinal}" => {
      ip        = ip
      host_node = local.config.PROXMOX_NODE
      cores     = ordinal == "1" ? 8 : 4
      memory    = 51200 # 50GB
      disk_size = 100
      # GPU worker: Intel Arc (gpu_vendor); the NVIDIA Quadro P2200 is installed but unused
      gpu = ordinal == "1"
    }
  }

  # A cluster with no workers has nowhere to run a pod unless the control plane
  # accepts them, so the two facts are one fact and come from one place — the
  # same worker address keys the node map is built from (ADR-035, MCAA-423).
  #
  # Deliberately not a ConfigSet key. A key would be a second statement of "does
  # this fork have workers", free to disagree with the address list, and the
  # disagreement is silent in the worst direction: a workerless ConfigSet that
  # left it false provisions a healthy cluster that schedules nothing. Wanting a
  # schedulable control plane ALONGSIDE workers is a real preference this does
  # not serve; that is a separate key on top of this floor, not a reason to
  # leave the floor unstated.
  #
  # TestTerragruntSchedulesOnControlPlanesWhenWorkerless pins this expression.
  allow_scheduling_on_control_planes = length(local.worker_ips) == 0
}
