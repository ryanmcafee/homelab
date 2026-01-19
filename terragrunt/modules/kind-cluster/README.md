# Kind Cluster Module

This module provisions a local Kubernetes cluster using Kind (Kubernetes in Docker) for rapid development and testing.

## Overview

Kind (Kubernetes in Docker) creates a Kubernetes cluster using Docker containers as nodes. Perfect for:
- Local development and testing
- CI/CD pipelines
- Validating Helm charts and manifests
- Testing GitOps configurations before deploying to production

## Features

- Multi-node cluster support (1 control plane + N workers)
- Ingress-ready configuration with port mappings
- Local-path-provisioner for dynamic storage
- Metrics-server for HPA testing
- Custom CNI support (Cilium, Calico, etc.)
- Volume mounts for local development

## Usage

### Basic Single-Node Cluster

```hcl
module "kind" {
  source = "../../modules/kind-cluster"

  cluster_name = "dev"
  worker_count = 0  # Single node (control plane only)
}
```

### Multi-Node Cluster with Ingress

```hcl
module "kind" {
  source = "../../modules/kind-cluster"

  cluster_name = "homelab-local"
  worker_count = 2

  # Ingress configuration
  ingress_enabled    = true
  ingress_http_port  = 8080
  ingress_https_port = 8443

  # Storage
  install_local_path_provisioner = true
  install_metrics_server         = true
}
```

### Custom CNI (Cilium)

```hcl
module "kind_cilium" {
  source = "../../modules/kind-cluster"

  cluster_name        = "cilium-dev"
  worker_count        = 2
  disable_default_cni = true  # Don't install kindnet

  # Install Cilium separately
}

# After cluster creation, install Cilium:
# helm install cilium cilium/cilium --namespace kube-system
```

### With Local Volume Mounts

```hcl
module "kind_dev" {
  source = "../../modules/kind-cluster"

  cluster_name = "dev"
  worker_count = 1

  # Mount local directories into nodes
  extra_mounts = [
    {
      host_path      = "/path/to/local/data"
      container_path = "/data"
      read_only      = false
    }
  ]
}
```

## Post-Creation

### Access the Cluster

```bash
# Set kubeconfig
export KUBECONFIG=~/.kube/config

# Or use the cluster name context
kubectl cluster-info --context kind-homelab-local

# Get nodes
kubectl get nodes

# Get all resources
kubectl get all -A
```

### Install Ingress Controller

```bash
# Install nginx-ingress
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml

# Wait for ingress controller
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=90s
```

### Test Ingress

```yaml
# test-ingress.yaml
apiVersion: v1
kind: Pod
metadata:
  name: test-app
  labels:
    app: test
spec:
  containers:
  - name: nginx
    image: nginx:alpine
    ports:
    - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: test-app
spec:
  selector:
    app: test
  ports:
  - port: 80
    targetPort: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: test-app
spec:
  rules:
  - host: test.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: test-app
            port:
              number: 80
```

```bash
# Apply
kubectl apply -f test-ingress.yaml

# Test (add to /etc/hosts: 127.0.0.1 test.local)
curl http://test.local
```

## Variables

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| cluster_name | Cluster name | `string` | "kind" | no |
| kubeconfig_path | Kubeconfig path | `string` | "~/.kube/config" | no |
| worker_count | Number of workers | `number` | 2 | no |
| ingress_enabled | Enable ingress | `bool` | true | no |
| ingress_http_port | HTTP port | `number` | 80 | no |
| ingress_https_port | HTTPS port | `number` | 443 | no |
| install_local_path_provisioner | Install storage | `bool` | true | no |
| install_metrics_server | Install metrics | `bool` | true | no |
| disable_default_cni | Disable default CNI | `bool` | false | no |

## Outputs

| Name | Description |
|------|-------------|
| cluster_name | Cluster name |
| kubeconfig_path | Path to kubeconfig |
| endpoint | API server endpoint |
| client_certificate | Client certificate (sensitive) |
| client_key | Client key (sensitive) |
| cluster_ca_certificate | CA certificate (sensitive) |

## Local Development Workflow

### 1. Create Cluster

```bash
cd terragrunt/environments/localdev/kind-cluster
terragrunt apply
```

### 2. Deploy Applications

```bash
# Using kubectl
kubectl apply -f manifests/

# Using Helm
helm install myapp ./charts/myapp

# Using ArgoCD
kubectl apply -f argocd-apps/
```

### 3. Iterate and Test

```bash
# Make changes to your manifests
# Reapply
kubectl apply -f manifests/

# Or use Tilt for hot-reload
tilt up
```

### 4. Cleanup

```bash
# Delete cluster
cd terragrunt/environments/localdev/kind-cluster
terragrunt destroy

# Or use kind CLI
kind delete cluster --name homelab-local
```

## Integration with Tilt

Kind works great with Tilt for hot-reloading:

```python
# Tiltfile
k8s_context('kind-homelab-local')

# Build and deploy
docker_build('myapp', './app')
k8s_yaml('k8s/deployment.yaml')
k8s_resource('myapp', port_forwards=8000)
```

## Performance Tips

### Resource Limits

```bash
# Check Docker resource limits
docker info | grep -i memory
docker info | grep -i cpu

# Adjust in Docker Desktop settings:
# Memory: 8GB minimum
# CPUs: 4+ cores
```

### Node Image Caching

```bash
# Pre-pull node image
docker pull kindest/node:v1.29.0

# Use in module
node_image = "kindest/node:v1.29.0"
```

### Local Registry

```bash
# Create local registry
docker run -d -p 5001:5000 --name kind-registry registry:2

# Connect to Kind
docker network connect kind kind-registry

# Push images
docker tag myapp:latest localhost:5001/myapp:latest
docker push localhost:5001/myapp:latest
```

## Troubleshooting

### Cluster Won't Start

```bash
# Check Docker
docker ps

# Check logs
kind export logs --name homelab-local

# Delete and recreate
kind delete cluster --name homelab-local
```

### Can't Access Services

```bash
# Check port mappings
docker port <container-name>

# Verify ingress controller
kubectl get svc -n ingress-nginx
```

### Storage Issues

```bash
# Check storage class
kubectl get sc

# Check PVCs
kubectl get pvc -A

# Manual provisioner install
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.26/deploy/local-path-storage.yaml
```

## Limitations

- **Performance**: Slower than native Kubernetes
- **Networking**: Limited to localhost or Docker network
- **Storage**: No distributed storage (local-path only)
- **LoadBalancer**: Requires MetalLB or cloud-provider-kind
- **GPU**: No GPU passthrough support

## Alternatives

- **Minikube**: More features, heavier
- **k3d**: k3s in Docker (similar to Kind)
- **MicroK8s**: Lightweight Kubernetes
- **Docker Desktop**: Built-in Kubernetes

## Related Documentation

- [Kind Documentation](https://kind.sigs.k8s.io/)
- [Ingress on Kind](https://kind.sigs.k8s.io/docs/user/ingress/)
- [Local Registry](https://kind.sigs.k8s.io/docs/user/local-registry/)
- [LoadBalancer](https://kind.sigs.k8s.io/docs/user/loadbalancer/)
