# Talos Control Plane Machine Configuration Template
# This template is used by the talos-cluster module to generate control plane configs
#
# Variables are substituted by Terraform/Terragrunt:
# - ${cluster_name}
# - ${cluster_endpoint}
# - ${hostname}
# - ${node_ip}

version: v1alpha1
persist: true

machine:
  type: controlplane
  token: ${token}
  ca:
    crt: ${ca_crt}
    key: ${ca_key}

  certSANs:
    - ${cluster_endpoint}
    %{ for ip in control_plane_ips ~}
    - ${ip}
    %{ endfor ~}

  kubelet:
    image: ghcr.io/siderolabs/kubelet:${kubernetes_version}
    extraArgs:
      rotate-server-certificates: "true"
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
        vip:
          ip: ${cluster_endpoint}

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
    endpoint: https://${cluster_endpoint}:6443

  clusterName: ${cluster_name}

  network:
    cni:
      name: none  # Cilium will be installed via Helm/ArgoCD
    dnsDomain: cluster.local
    podSubnets:
      - 10.244.0.0/16
    serviceSubnets:
      - 10.96.0.0/12

  proxy:
    disabled: true  # Cilium handles kube-proxy functionality

  apiServer:
    image: registry.k8s.io/kube-apiserver:${kubernetes_version}
    certSANs:
      - ${cluster_endpoint}
      %{ for ip in control_plane_ips ~}
      - ${ip}
      %{ endfor ~}
    admissionControl:
      - name: PodSecurity
        configuration:
          apiVersion: pod-security.admission.config.k8s.io/v1alpha1
          kind: PodSecurityConfiguration
          defaults:
            enforce: "baseline"
            enforce-version: "latest"
            audit: "restricted"
            audit-version: "latest"
            warn: "restricted"
            warn-version: "latest"
          exemptions:
            usernames: []
            runtimeClasses: []
            namespaces:
              - kube-system

  controllerManager:
    image: registry.k8s.io/kube-controller-manager:${kubernetes_version}

  scheduler:
    image: registry.k8s.io/kube-scheduler:${kubernetes_version}

  discovery:
    enabled: true
    registries:
      kubernetes:
        disabled: false
      service:
        disabled: false

  etcd:
    ca:
      crt: ${etcd_ca_crt}
      key: ${etcd_ca_key}

  allowSchedulingOnControlPlanes: false
