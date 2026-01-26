# Homelab - Talos Kubernetes Cluster
# Provisions Talos Linux cluster (2 control plane + 3 workers)

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}

terraform {
  source = "../../../modules//talos-cluster"
}

dependency "zfs_pool" {
  config_path = "../proxmox-zfs-pool"
}

dependency "talos_image" {
  config_path = "../talos-image"

  mock_outputs = {
    image_id      = "local:iso/talos-mock.img"
    schematic_id  = "mock-schematic-id"
    talos_version = "v1.12.2"
  }
}

dependency "truenas" {
  config_path = "../truenas"

  mock_outputs = {
    vm_id = 100
  }
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
  cluster_name     = include.env.locals.cluster_name
  cluster_endpoint = include.env.locals.cluster_endpoint
  vip_endpoint     = include.env.locals.vip_endpoint

  talos_version      = include.env.locals.talos_version
  kubernetes_version = include.env.locals.kubernetes_version

  # Node configurations from env.hcl
  control_plane_nodes = include.env.locals.control_plane_nodes
  worker_nodes        = include.env.locals.worker_nodes

  # Proxmox configuration
  pool_id        = dependency.zfs_pool.outputs.pool_id
  talos_image_id = dependency.talos_image.outputs.image_id
  datastore_id   = include.env.locals.vm_storage_pool

  # Image Factory installer with system extensions (qemu-guest-agent, nfs-utils, etc.)
  installer_image = "factory.talos.dev/installer/${dependency.talos_image.outputs.schematic_id}:${dependency.talos_image.outputs.talos_version}"

  # Network configuration
  network_bridge  = "vmbr0"
  network_vlan_id = include.env.locals.vlan_id
  network_gateway = include.env.locals.gateway
  network_cidr    = include.env.locals.subnet
  dns_servers     = include.env.locals.dns_servers

  # GPU configuration for worker-1 (NVIDIA Quadro P2200)
  gpu_pci_id       = include.env.locals.gpu_pci_id
  gpu_device       = include.env.locals.gpu_device
  gpu_mapping_name = "gpu-nvidia-p2200"
  proxmox_node     = include.env.locals.proxmox_node
  gpu_config_patch = yamlencode({
    machine = {
      kernel = {
        modules = [
          { name = "nvidia" },
          { name = "nvidia_uvm" },
          { name = "nvidia_drm" }
        ]
      }
      nodeLabels = {
        "nvidia.com/gpu"                              = "true"
        "feature.node.kubernetes.io/pci-10de.present" = "true"
      }
    }
  })

  # Talos configuration patches
  common_config_patches = [
    yamlencode({
      machine = {
        time = {
          servers = ["time.cloudflare.com"]
        }
        kubelet = {
          extraArgs = {
            "rotate-server-certificates" = "true"
          }
          # Disable default seccomp profile to avoid startup delays
          defaultRuntimeSeccompProfileEnabled = true
          # Disable manifests directory which can cause delays
          disableManifestsDirectory = true
        }
        features = {
          # Enable disk quota support for local storage
          diskQuotaSupport = true
          # Enable KubePrism for HA API access during bootstrap
          kubePrism = {
            enabled = true
            port    = 7445
          }
        }
        # Registry mirrors to avoid rate limiting and improve pull speeds
        registries = {
          mirrors = {
            "docker.io" = {
              endpoints = [
                "https://mirror.gcr.io",
                "https://registry-1.docker.io"
              ]
            }
            "ghcr.io" = {
              endpoints = [
                "https://ghcr.io"
              ]
            }
            "registry.k8s.io" = {
              endpoints = [
                "https://registry.k8s.io"
              ]
            }
          }
        }
      }
    })
  ]

  # SSH configuration for boot args
  proxmox_host    = include.env.locals.proxmox_host
  ssh_user        = include.env.locals.proxmox_ssh_user
  ssh_private_key = include.env.locals.proxmox_ssh_private_key

  tags = ["homelab", "talos", "kubernetes"]

  # Cilium CNI inline installation
  install_cilium_inline  = true
  cilium_inline_manifest = file("${get_terragrunt_dir()}/../../../files/cilium-rendered.yaml")

  # Kubelet CSR Approver inline installation (auto-approves kubelet server certificates)
  install_kubelet_csr_approver_inline  = true
  kubelet_csr_approver_inline_manifest = file("${get_terragrunt_dir()}/../../../files/kubelet-csr-approver-rendered.yaml")

  # Image cache configuration (prevents failures from flaky external registries)
  image_cache_endpoint   = include.env.locals.image_cache_endpoint
  image_cache_ca_cert    = include.env.locals.image_cache_ca_cert
  image_cache_registries = include.env.locals.image_cache_registries

  # Spegel P2P image cache configuration
  spegel_enabled = include.env.locals.spegel_enabled

  # Spegel inline installation (P2P image distribution)
  install_spegel_inline  = include.env.locals.spegel_enabled
  spegel_inline_manifest = include.env.locals.spegel_enabled ? file("${get_terragrunt_dir()}/../../../files/spegel-rendered.yaml") : ""
}
