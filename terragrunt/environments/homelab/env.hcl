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
  talos_version      = "v1.13.11"
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
    downloads = "${local.config.NFS_SSD_BASE_PATH}/downloads"
  }

  # PCI passthrough describes one physical host, so it lives in the optional,
  # gitignored hardware.hcl; without it nothing is passed through.
  # docs/hardware.md#pci-passthrough lists how to read each value on the host.
  hardware_file = "${get_repo_root()}/terragrunt/environments/homelab/hardware.hcl"
  hardware = fileexists(local.hardware_file) ? read_terragrunt_config(local.hardware_file).locals : {
    gpu_devices = {}
    hba_devices = {}
  }

  # TrueNAS direct disk access; the truenas module skips an empty map.
  hba_devices = local.hardware.hba_devices

  # GPU vendor selection; "none" skips GPU passthrough on every worker.
  gpu_vendor = local.config.GPU_VENDOR

  # One entry per vendor; talos-cluster passes the GPU_VENDOR one through to the gpu worker.
  gpu_pci_id       = try(local.hardware.gpu_devices.nvidia.pci_id, "")
  gpu_device       = try({ for k, v in local.hardware.gpu_devices.nvidia : k => v if k != "pci_id" }, null)
  gpu_intel_pci_id = try(local.hardware.gpu_devices.intel.pci_id, "")
  gpu_intel_device = try({ for k, v in local.hardware.gpu_devices.intel : k => v if k != "pci_id" }, null)

  # Git repository ArgoCD reconciles from — a fork's own remote, not upstream.
  repo_url        = local.config.GITOPS_REPO_URL
  target_revision = "main"

  # Base FQDN. The root terragrunt.hcl deliberately has no default for this, so
  # an environment that fails to resolve it stops rather than inheriting one.
  base_fqdn = local.config.DOMAIN

  argocd_notifications_github_1p_path = local.config.ARGOCD_NOTIFICATIONS_GITHUB_1P_PATH
  environment_config_1p_path          = local.config.HOMELAB_ENVIRONMENT_CONFIG_1P_PATH

  # Optional split-horizon zone for extra A records; empty publishes none.
  local_dns_domain = try(local.config.LOCAL_DNS_DOMAIN, "")

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

  # Per-ordinal attributes a worker carries only when its address key exists.
  worker_node_extras = {
    "1" = { node_taints = { "intel.com/gpu" = "true:PreferNoSchedule" } }
    "3" = { node_labels = { "paperclip.homelab/pin" = "true" } }
  }

  # Worker 1 is this repository's GPU node: the schema describes WORKER1_IP that
  # way and `homelab verify gpu` resolves the GPU node by that key. Sizing
  # follows the same split — the GPU worker gets the extra cores.
  worker_nodes = {
    for ordinal, ip in local.worker_ips : "worker-${ordinal}" => merge({
      ip        = ip
      host_node = local.config.PROXMOX_NODE
      cores     = ordinal == "1" ? 8 : 4
      memory    = 51200 # 50GB
      disk_size = 100
      # GPU worker: Intel Arc (gpu_vendor); the NVIDIA Quadro P2200 is installed but unused
      gpu = ordinal == "1"
    }, try(local.worker_node_extras[ordinal], {}))
  }
}
