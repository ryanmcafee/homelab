# Network Architecture and Configuration

This document provides comprehensive networking documentation for the homelab, including VLAN configuration, BGP peering, MetalLB setup, and troubleshooting procedures.

## Table of Contents

- [Overview](#overview)
- [Network Topology](#network-topology)
- [VLAN Configuration](#vlan-configuration)
- [IP Address Allocation](#ip-address-allocation)
- [BGP Configuration](#bgp-configuration)
- [MetalLB Configuration](#metallb-configuration)
- [DNS Configuration](#dns-configuration)
- [Ingress Configuration](#ingress-configuration)
- [Network Security](#network-security)
- [Cilium CNI Configuration](#cilium-cni-configuration)
- [Troubleshooting](#troubleshooting)
- [References](#references)

---

## Overview

The homelab uses a software-defined networking approach with BGP routing between the Kubernetes cluster and the UniFi Dream Machine. This enables dynamic service IP advertisement and automatic traffic routing.

### Key Components

- **UniFi Dream Machine**: Gateway, DHCP server, BGP peer (ASN 64513)
- **MetalLB**: Kubernetes load balancer with BGP mode (ASN 64512)
- **Cilium**: CNI plugin with eBPF datapath
- **Traefik**: HTTP/HTTPS ingress controller
- **external-dns**: Automatic DNS record management (Cloudflare)

### Network Design Principles

1. **Separation of Concerns**: VLANs isolate homelab traffic
2. **Dynamic Routing**: BGP enables automatic service discovery
3. **Zero Manual DNS**: external-dns manages records automatically
4. **High Availability**: Multiple control plane nodes for resilience
5. **Security First**: Default-deny firewall rules, TLS everywhere

---

## Network Topology

```
                                 Internet
                                     │
                                     │
                     ┌───────────────▼───────────────┐
                     │   UniFi Dream Machine         │
                     │   WAN: DHCP (ISP)             │
                     │   LAN: 192.168.1.1/24 (Main)  │
                     │   BGP ASN: 64513              │
                     └───────────────┬───────────────┘
                                     │
                     ┌───────────────┴───────────────┐
                     │                               │
             ┌───────▼────────┐            ┌────────▼────────┐
             │  VLAN 1 (Main) │            │ VLAN 100 (Lab)  │
             │  192.168.1.0/24│            │ 172.16.100.0/24 │
             │                │            │                 │
             │  - Desktop     │            │  - Proxmox      │
             │  - Laptop      │            │  - TrueNAS      │
             │  - IoT devices │            │  - Talos Nodes  │
             └────────────────┘            └─────────┬───────┘
                                                     │
                               ┌─────────────────────┼─────────────────────┐
                               │                     │                     │
                        ┌──────▼──────┐     ┌───────▼────────┐   ┌───────▼────────┐
                        │   Proxmox   │     │  TrueNAS VM    │   │  Talos Nodes   │
                        │ .100.250    │     │  (DHCP)        │   │  (DHCP)        │
                        └─────────────┘     └────────────────┘   └────────┬───────┘
                                                                           │
                                                                  ┌────────▼────────┐
                                                                  │    MetalLB      │
                                                                  │  BGP ASN 64512  │
                                                                  │  .100.100-200   │
                                                                  └─────────────────┘
                                                                           │
                                    ┌──────────────────────────────────────┼──────────────────┐
                                    │                                      │                  │
                            ┌───────▼────────┐                   ┌─────────▼─────────┐  ┌────▼─────┐
                            │    Traefik     │                   │      Plex         │  │  Other   │
                            │ LoadBalancer   │                   │  LoadBalancer     │  │ Services │
                            │  .100.101      │                   │    .100.102       │  │          │
                            └────────────────┘                   └───────────────────┘  └──────────┘
```

### Traffic Flow

1. **External Request**: Internet → UniFi WAN
2. **Ingress**: UniFi → MetalLB IP (via BGP route)
3. **Load Balancing**: MetalLB → Service endpoints
4. **Ingress Controller**: Traefik routes by hostname
5. **Application**: Pod serves request

---

## VLAN Configuration

### VLAN 1 (Main Network)

| Parameter | Value |
|-----------|-------|
| VLAN ID | 1 (default/untagged) |
| Subnet | 192.168.1.0/24 |
| Gateway | 192.168.1.1 (UniFi) |
| DHCP Range | 192.168.1.100-192.168.1.200 |
| Purpose | Main home network |

**Devices**: Desktop, laptop, phones, smart home devices

### VLAN 100 (Homelab)

| Parameter | Value |
|-----------|-------|
| VLAN ID | 100 |
| Subnet | 172.16.100.0/24 |
| Gateway | 172.16.100.1 (UniFi) |
| DHCP Range | 172.16.100.50-172.16.100.99 |
| Static IPs | 172.16.100.26, 172.16.100.250 |
| MetalLB Pool | 172.16.100.100-172.16.100.200 |
| Purpose | Homelab infrastructure |

**Devices**: Proxmox, IPMI, TrueNAS, Talos nodes, Kubernetes services

### UniFi VLAN Configuration

**Step 1: Create VLAN**

1. Navigate to **Settings** → **Networks**
2. Click **Create New Network**
3. Configure:
   - Name: `Homelab`
   - VLAN ID: `100`
   - Gateway IP: `172.16.100.1/24`
   - DHCP Mode: `DHCP Server`
   - DHCP Range: `172.16.100.50` - `172.16.100.99`
   - Domain Name: `ryanmcafee.com`

**Step 2: Enable BGP**

1. Navigate to **Settings** → **Routing** → **BGP**
2. Enable BGP
3. Configure:
   - AS Number: `64513`
   - Router ID: `172.16.100.1`

**Step 3: Add BGP Neighbor**

1. Under BGP settings, click **Add Neighbor**
2. Configure:
   - Neighbor IP: `<any-talos-node-ip>` (MetalLB speaker)
   - Remote AS: `64512`
   - Password: (optional, not used)
   - BFD: Disabled

**Note**: MetalLB speakers run on all nodes, so BGP will establish sessions with multiple IPs.

---

## IP Address Allocation

### Static IP Assignments

| Device | IP Address | Interface | Notes |
|--------|------------|-----------|-------|
| UniFi Gateway | 172.16.100.1 | VLAN 100 | Gateway + BGP peer |
| IPMI (Supermicro) | 172.16.100.26 | Dedicated NIC | Out-of-band management |
| Proxmox | 172.16.100.250 | vmbr0 (VLAN 100) | Hypervisor web UI |

### DHCP Assignments

| Device | IP Range | Notes |
|--------|----------|-------|
| TrueNAS | 172.16.100.50-99 | VM on Proxmox |
| Talos Control Plane 1 | 172.16.100.50-99 | VM on Proxmox |
| Talos Control Plane 2 | 172.16.100.50-99 | VM on Proxmox |
| Talos Worker 1-3 | 172.16.100.50-99 | VMs on Proxmox |

**DHCP Configuration**: UniFi handles DHCP with static lease options available

### MetalLB IP Pool

| Pool Name | IP Range | Usage |
|-----------|----------|-------|
| default | 172.16.100.100-172.16.100.200 | LoadBalancer services |

**Total Available IPs**: 101 IPs for services

### Service IP Assignments

MetalLB dynamically assigns IPs from the pool. Typical allocations:

| Service | IP (example) | Port | Purpose |
|---------|--------------|------|---------|
| Traefik | 172.16.100.101 | 80, 443 | HTTP/HTTPS ingress |
| Plex | 172.16.100.102 | 32400 | Media server |
| ArgoCD | 172.16.100.103 | 80, 443 | GitOps UI |
| Grafana | 172.16.100.104 | 80 | Monitoring dashboards |

**Note**: Actual IPs assigned dynamically. Use DNS names, not IPs.

---

## BGP Configuration

### Overview

Border Gateway Protocol (BGP) enables dynamic routing between Kubernetes (MetalLB) and the UniFi router. When a LoadBalancer service is created, MetalLB:

1. Assigns an IP from the pool
2. Announces the IP to BGP peers (UniFi)
3. UniFi installs route in routing table
4. Traffic to that IP flows to correct Kubernetes node

### BGP Autonomous System Numbers

| Component | ASN | Router ID |
|-----------|-----|-----------|
| UniFi Dream Machine | 64513 | 172.16.100.1 |
| MetalLB (K8s) | 64512 | (node IP) |

**ASN Selection**: Private ASN range (64512-65534) per RFC 6996

### MetalLB BGP Configuration

**File**: `charts/addons/templates/metallb.yaml`

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: default
  namespace: metallb-system
spec:
  addresses:
    - 172.16.100.100-172.16.100.200
  autoAssign: true
---
apiVersion: metallb.io/v1beta2
kind: BGPPeer
metadata:
  name: unifi-peer
  namespace: metallb-system
spec:
  myASN: 64512
  peerASN: 64513
  peerAddress: 172.16.100.1
  sourceAddress:
---
apiVersion: metallb.io/v1beta1
kind: BGPAdvertisement
metadata:
  name: default
  namespace: metallb-system
spec:
  ipAddressPools:
    - default
  aggregationLength: 32  # Advertise /32 host routes
```

### Verification

**Check BGP Session Status**:

```bash
# On Kubernetes: Check MetalLB speaker logs
kubectl -n metallb-system logs -l component=speaker | grep -i bgp

# Look for: "BGP session established"
```

**On UniFi**:

1. SSH to UniFi Dream Machine:
   ```bash
   ssh admin@172.16.100.1
   ```

2. Check BGP summary:
   ```bash
   vtysh -c "show ip bgp summary"
   ```

   Expected output:
   ```
   Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ  Up/Down State/PfxRcd
   172.16.100.51   4 64512     123     456        0    0    0 01:23:45        5
   172.16.100.52   4 64512     234     567        0    0    0 01:23:45        5
   ```

3. View advertised routes:
   ```bash
   vtysh -c "show ip bgp"
   ```

### Troubleshooting BGP

**BGP Session Not Establishing**:

1. Verify ASN numbers match
2. Check peer IP addresses
3. Verify firewall allows BGP (TCP port 179)
4. Check MetalLB speaker pods are running
5. Review speaker logs for errors

**Routes Not Installed**:

1. Verify IP pool configuration
2. Check BGP advertisement configuration
3. Verify services have LoadBalancer type
4. Check for IP conflicts

---

## MetalLB Configuration

### Architecture

MetalLB runs in two components:

1. **Controller**: Assigns IPs to LoadBalancer services
2. **Speaker**: Announces IPs via BGP

```
┌─────────────────────────────────────────────────────────────┐
│                     Kubernetes Cluster                       │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  MetalLB Controller (Deployment)                     │  │
│  │  - Watches LoadBalancer services                     │  │
│  │  - Assigns IPs from pool                             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  MetalLB Speaker (DaemonSet - runs on all nodes)     │  │
│  │  - Establishes BGP sessions                          │  │
│  │  - Announces service IPs                             │  │
│  │  - Responds to ARP requests                          │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Installation

MetalLB is installed via ArgoCD from the addons chart:

```yaml
# charts/addons/templates/metallb.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: metallb
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  project: default
  source:
    repoURL: https://metallb.github.io/metallb
    chart: metallb
    targetRevision: 0.14.8
    helm:
      values: |
        controller:
          resources:
            requests:
              cpu: 10m
              memory: 64Mi
        speaker:
          resources:
            requests:
              cpu: 10m
              memory: 64Mi
  destination:
    server: https://kubernetes.default.svc
    namespace: metallb-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

### IP Address Pool Management

**Creating Additional Pools**:

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: production
  namespace: metallb-system
spec:
  addresses:
    - 172.16.100.150-172.16.100.200
  autoAssign: false  # Require explicit pool selection
---
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: development
  namespace: metallb-system
spec:
  addresses:
    - 172.16.100.100-172.16.100.149
  autoAssign: true
```

**Using Specific Pool**:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
  annotations:
    metallb.universe.tf/address-pool: production
spec:
  type: LoadBalancer
  loadBalancerIP: 172.16.100.150  # Optional: request specific IP
  ports:
    - port: 80
      targetPort: 8080
  selector:
    app: my-app
```

### Layer 2 Mode (Alternative to BGP)

If BGP is not available, MetalLB can run in Layer 2 mode:

```yaml
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: default
  namespace: metallb-system
spec:
  ipAddressPools:
    - default
```

**Note**: Layer 2 mode uses ARP, not BGP. Less scalable but simpler.

---

## DNS Configuration

### Overview

DNS is managed at three levels:

1. **Public DNS (Cloudflare)**: External records via external-dns
2. **Local DNS (UniFi)**: Internal VLAN resolution
3. **Kubernetes DNS (CoreDNS)**: In-cluster service discovery

### external-dns Configuration

**Purpose**: Automatically creates DNS records in Cloudflare for Ingress resources

**File**: `charts/addons/templates/external-dns.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: external-dns
  namespace: argocd
spec:
  source:
    repoURL: https://kubernetes-sigs.github.io/external-dns
    chart: external-dns
    targetRevision: 1.14.3
    helm:
      values: |
        provider: cloudflare
        env:
          - name: CF_API_TOKEN
            valueFrom:
              secretKeyRef:
                name: cloudflare-api-token
                key: api-token
        domainFilters:
          - ryanmcafee.com
        policy: sync  # upsert-only or sync
        txtOwnerId: homelab-k8s
        interval: 5m
```

**How It Works**:

1. Create Ingress with annotation:
   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: Ingress
   metadata:
     name: my-app
     annotations:
       external-dns.alpha.kubernetes.io/hostname: app.ryanmcafee.com
   spec:
     rules:
       - host: app.ryanmcafee.com
         http:
           paths:
             - path: /
               pathType: Prefix
               backend:
                 service:
                   name: my-app
                   port:
                     number: 80
   ```

2. external-dns creates Cloudflare DNS record:
   ```
   app.ryanmcafee.com → A → 172.16.100.101 (Traefik LoadBalancer IP)
   ```

3. Traffic flows: Internet → Cloudflare → UniFi WAN → Traefik → Pod

### Local DNS Resolution

**UniFi DNS Settings**:

1. Navigate to **Settings** → **Networks** → **Homelab (VLAN 100)**
2. Configure DNS:
   - DNS Server: `1.1.1.1` (Cloudflare)
   - DNS Server 2: `8.8.8.8` (Google)
   - Domain Name: `ryanmcafee.com`

**Static DNS Entries** (if needed):

1. Navigate to **Settings** → **DNS** → **Static Entries**
2. Add entry:
   - Hostname: `proxmox`
   - IP: `172.16.100.250`
   - Domain: `ryanmcafee.com`

### CoreDNS (Kubernetes Internal)

CoreDNS provides DNS for Kubernetes services. No configuration required.

**Service DNS Format**: `<service>.<namespace>.svc.cluster.local`

Example: `plex.media.svc.cluster.local`

---

## Ingress Configuration

### Traefik Ingress Controller

Traefik routes external HTTP/HTTPS traffic to services.

**Installation**: `charts/addons/templates/traefik.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: traefik
  namespace: argocd
spec:
  source:
    repoURL: https://traefik.github.io/charts
    chart: traefik
    targetRevision: 26.1.0
    helm:
      values: |
        service:
          type: LoadBalancer  # MetalLB assigns IP
          annotations:
            metallb.universe.tf/address-pool: default

        ports:
          web:
            port: 80
            redirectTo:
              port: websecure  # Force HTTPS
          websecure:
            port: 443
            tls:
              enabled: true

        providers:
          kubernetesCRD:
            enabled: true
          kubernetesIngress:
            enabled: true

        logs:
          general:
            level: INFO
          access:
            enabled: true
```

### Creating Ingress Resources

**Example: Plex Ingress**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: plex
  namespace: media
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    external-dns.alpha.kubernetes.io/hostname: plex.ryanmcafee.com
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - plex.ryanmcafee.com
      secretName: plex-tls
  rules:
    - host: plex.ryanmcafee.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: plex
                port:
                  number: 32400
```

**What Happens**:

1. cert-manager requests TLS certificate from Let's Encrypt
2. external-dns creates Cloudflare A record
3. Traefik routes traffic from `plex.ryanmcafee.com` to plex service
4. TLS termination at Traefik

### Middleware (Optional)

Traefik supports middleware for authentication, rate limiting, etc.

**Example: Basic Auth**

```yaml
apiVersion: traefik.containo.us/v1alpha1
kind: Middleware
metadata:
  name: basic-auth
  namespace: media
spec:
  basicAuth:
    secret: basic-auth-credentials
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: protected-app
  annotations:
    traefik.ingress.kubernetes.io/router.middlewares: media-basic-auth@kubernetescrd
spec:
  # ... ingress spec
```

---

## Network Security

### Firewall Rules

**UniFi Firewall** (VLAN 100 → Internet):

1. **Allow Outbound**: Homelab → Internet (HTTP, HTTPS, DNS)
2. **Block Inbound**: Internet → Homelab (default deny)
3. **Allow Inter-VLAN**: VLAN 1 → VLAN 100 (management access)
4. **Block Inter-VLAN**: VLAN 100 → VLAN 1 (isolate homelab)

**Example Rule Set**:

| Rule | Direction | Source | Destination | Ports | Action |
|------|-----------|--------|-------------|-------|--------|
| 1 | LAN → WAN | VLAN 100 | Any | 80, 443 | Allow |
| 2 | LAN → WAN | VLAN 100 | Any | 53 | Allow |
| 3 | LAN → LAN | VLAN 1 | VLAN 100 | 22, 443 | Allow |
| 4 | LAN → LAN | VLAN 100 | VLAN 1 | Any | Deny |
| 5 | WAN → LAN | Any | VLAN 100 | Any | Deny |

### Kubernetes Network Policies

**Enable Cilium Network Policies**:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-ingress-to-plex
  namespace: media
spec:
  endpointSelector:
    matchLabels:
      app: plex
  ingress:
    - fromEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: traefik
    - toPorts:
        - ports:
            - port: "32400"
              protocol: TCP
```

**Default Deny Policy**:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: default-deny
  namespace: media
spec:
  endpointSelector: {}
  ingress:
    - {}  # Empty = deny all
```

### TLS Everywhere

**cert-manager** automatically provisions TLS certificates:

1. Ingress annotated with `cert-manager.io/cluster-issuer: letsencrypt-prod`
2. cert-manager creates Certificate resource
3. ACME challenge completed (HTTP-01 or DNS-01)
4. Certificate stored in Kubernetes Secret
5. Ingress references Secret for TLS

---

## Cilium CNI Configuration

### Overview

Cilium provides container networking with eBPF for high performance and observability.

**Key Features**:
- eBPF datapath (bypasses iptables)
- Network policies with L3-L7 filtering
- Hubble for network observability
- Service mesh capabilities (optional)

### Installation

Cilium is installed inline during Talos cluster bootstrap:

**File**: `talos/inline-manifests/cilium-install.yaml`

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-install
  namespace: kube-system
data:
  values.yaml: |
    ipam:
      mode: kubernetes
    hubble:
      enabled: true
      relay:
        enabled: true
      ui:
        enabled: true
    kubeProxyReplacement: strict
    k8sServiceHost: localhost
    k8sServicePort: 7445
```

### Hubble Observability

**Enable Port Forwarding**:

```bash
kubectl -n kube-system port-forward svc/hubble-ui 12000:80
```

**Access UI**: http://localhost:12000

**CLI Usage**:

```bash
# Install Hubble CLI
curl -L https://github.com/cilium/hubble/releases/latest/download/hubble-linux-amd64.tar.gz | tar xz
sudo mv hubble /usr/local/bin/

# View flows
hubble observe --namespace media

# View flows for specific pod
hubble observe --pod plex

# View dropped packets
hubble observe --verdict DROPPED
```

---

## Troubleshooting

### Network Connectivity Issues

**Symptom**: Pods cannot reach external services

**Diagnosis**:

```bash
# Check pod network connectivity
kubectl run -it --rm debug --image=nicolaka/netshoot --restart=Never -- bash

# Inside pod:
ping 1.1.1.1          # Test internet
nslookup google.com   # Test DNS
curl http://google.com  # Test HTTP
```

**Resolution**:
- Verify Cilium pods are running
- Check DNS configuration
- Verify firewall rules allow outbound traffic

### BGP Session Down

**Symptom**: LoadBalancer services stuck in Pending

**Diagnosis**:

```bash
# Check MetalLB speaker logs
kubectl -n metallb-system logs -l component=speaker

# Look for BGP errors
kubectl -n metallb-system logs -l component=speaker | grep -i error
```

**Resolution**:
- Verify BGP peer configuration matches on both sides
- Check ASN numbers
- Verify peer IP address is reachable
- Check firewall allows TCP port 179

### DNS Not Resolving

**Symptom**: Cannot access services by hostname

**Diagnosis**:

```bash
# Check CoreDNS pods
kubectl -n kube-system get pods -l k8s-app=kube-dns

# Test DNS from pod
kubectl run -it --rm debug --image=nicolaka/netshoot --restart=Never -- nslookup plex.media.svc.cluster.local
```

**Resolution**:
- Verify CoreDNS pods are running
- Check CoreDNS logs for errors
- Verify DNS service is accessible

### Ingress Not Working

**Symptom**: Cannot access application via Ingress

**Diagnosis**:

```bash
# Check Traefik pods
kubectl -n traefik get pods

# Check Traefik service IP
kubectl -n traefik get svc

# Check Ingress resource
kubectl -n media get ingress plex -o yaml

# Test from outside cluster
curl -I http://plex.ryanmcafee.com
```

**Resolution**:
- Verify Traefik LoadBalancer has external IP
- Check Ingress rules are correct
- Verify DNS record points to Traefik IP
- Check application pods are running

### Useful Commands

```bash
# View all network policies
kubectl get networkpolicies -A

# Check MetalLB IP address pools
kubectl -n metallb-system get ipaddresspools

# View BGP peers
kubectl -n metallb-system get bgppeers

# Check Cilium status
kubectl -n kube-system exec -it ds/cilium -- cilium status

# View Cilium connectivity test
kubectl -n kube-system exec -it ds/cilium -- cilium connectivity test

# Check service endpoints
kubectl -n media get endpoints plex
```

---

## References

### Official Documentation

- [MetalLB Documentation](https://metallb.universe.tf/)
- [Cilium Documentation](https://docs.cilium.io/)
- [Traefik Documentation](https://doc.traefik.io/traefik/)
- [external-dns Documentation](https://kubernetes-sigs.github.io/external-dns/)
- [UniFi Dream Machine Documentation](https://help.ui.com/hc/en-us/categories/200320654-UniFi)

### Guides

- [BGP with MetalLB](https://metallb.universe.tf/configuration/#bgp-configuration)
- [UniFi BGP Configuration](https://help.ui.com/hc/en-us/articles/4407211598612-UniFi-Gateway-BGP)
- [Cilium Network Policies](https://docs.cilium.io/en/stable/security/policy/)

### Related Documentation

- [architecture.md](./architecture.md) - Overall architecture overview
- [disaster-recovery.md](./disaster-recovery.md) - Backup and recovery
- [hardware-setup.md](./hardware-setup.md) - Physical network setup

---

**Last Updated**: 2026-01-19
**Version**: 1.0
**Maintainer**: homelab team
