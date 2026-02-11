# Kubernetes Cluster & ArgoCD Debugging

## Cluster Connection
- **Context**: `admin@homelab`
- **Control Plane**: `https://172.16.100.10:6443`
- **kubectl**: Already configured and working
- **Default namespace**: `default` (keep it this way)

## ArgoCD CLI Access
- **CLI version**: argocd v3.2.6
- **Installed at**: `~/.local/share/mise/installs/argocd/3.2.6/argocd`
- **Core mode** (talks directly to k8s, no port-forward needed):
  1. Set namespace: `kubectl config set-context --current --namespace=argocd`
  2. Run command: `argocd app get <app> --core`
  3. **IMPORTANT**: Reset namespace after: `kubectl config set-context --current --namespace=default`
- **Warning**: `--core` mode requires the kubectl context namespace to be `argocd` (where argocd-cm configmap lives)
- **Warning**: Helm `--client` flag error appears but is non-fatal, output still works
- **Web UI**: https://argocd.ryanmcafee.com (OIDC auth via Traefik middleware)

## Useful Debugging Commands

### ArgoCD Application Status
```bash
# List all apps
kubectl get applications -n argocd -o wide

# Get app details (via kubectl)
kubectl get application <app> -n argocd -o json | jq '.status'

# Get app details (via argocd CLI - requires namespace switch)
kubectl config set-context --current --namespace=argocd
argocd app get <app> --core
kubectl config set-context --current --namespace=default

# Find unhealthy resources in an app
kubectl get application <app> -n argocd -o json | jq '.status.resources[] | select(.health.status == "Progressing" or .health.status == "Degraded" or .health.status == "Missing")'
```

### Pod Debugging
```bash
# Check pod status
kubectl get pods -n <namespace> -l app.kubernetes.io/name=<app-name> -o wide

# Get pod events (especially useful for Pending pods)
kubectl describe pod <pod-name> -n <namespace> | tail -30

# Check PVCs
kubectl get pvc -n <namespace>
```

### Common ArgoCD Namespaces
- `argocd` - ArgoCD itself
- `media` - Plex, Sonarr, Radarr, Prowlarr, NZBGet, Tautulli, LazyLibrarian, FlareSolverr
- `home-automation` - Home Assistant, Mosquitto
- `duckdns` - DuckDNS
- `cert-manager` - cert-manager
- `traefik` - Traefik ingress
- `kube-prometheus-stack` - Monitoring
- `gpu-operator` - NVIDIA GPU operator
- `democratic-csi` - CSI drivers (NFS, iSCSI, SSD)

## Key Insight: jq and Shell Escaping
- The `!` character in `!=` gets escaped by bash history expansion
- Use `select(.field == "value")` with positive matching instead of `!=`
- Or use `set +H` to disable history expansion before jq commands
