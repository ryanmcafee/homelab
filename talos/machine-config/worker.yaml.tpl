# Talos Worker Machine Configuration Template
# This template is used by the talos-cluster module to generate worker configs
#
# Variables are substituted by Terraform/Terragrunt:
# - ${cluster_name}
# - ${cluster_endpoint}
# - ${hostname}
# - ${node_ip}

version: v1alpha1
persist: true

machine:
  type: worker
  token: ${token}
  ca:
    crt: ${ca_crt}
    key: ${ca_key}

  kubelet:
    image: ghcr.io/siderolabs/kubelet:${kubernetes_version}
    extraArgs:
      rotate-server-certificates: "true"
      max-pods: "250"
    nodeIP:
      validSubnets:
        - ${subnet}

  network:
    hostname: ${hostname}
    interfaces:
      - interface: eth0
        addresses:
          - ${node_ip}/24
        routes:
          - network: 0.0.0.0/0
            gateway: ${gateway}

  install:
    disk: /dev/vda
    image: ghcr.io/siderolabs/installer:${talos_version}
    wipe: false

  time:
    disabled: false
    servers:
      - time.cloudflare.com

  features:
    rbac: true
    stableHostname: true
    kubernetesTalosAPIAccess:
      enabled: true
      allowedRoles:
        - os:reader
      allowedKubernetesNamespaces:
        - kube-system

cluster:
  id: ${cluster_id}
  secret: ${cluster_secret}
  controlPlane:
    endpoint: https://${vip_endpoint}:6443

  clusterName: ${cluster_name}

  network:
    cni:
      name: none  # Cilium will be installed
    dnsDomain: cluster.local

  discovery:
    enabled: true
    registries:
      kubernetes:
        disabled: false
      service:
        disabled: false

  ca:
    crt: ${cluster_ca_crt}
    key: ${cluster_ca_key}
