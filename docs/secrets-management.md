# Secrets Management

This homelab uses **1Password** for centralized secrets management across all environments.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        1Password Vault                           │
│  (Single Source of Truth for All Secrets)                       │
└─────────────────────────────────────────────────────────────────┘
                                 │
                 ┌───────────────┼───────────────┐
                 │               │               │
                 ▼               ▼               ▼
         ┌───────────┐   ┌──────────────┐   ┌────────────┐
         │   Local   │   │   CI/CD      │   │ Kubernetes │
         │   Dev     │   │   GitHub     │   │  1Password │
         │   (CLI)   │   │   Actions    │   │  Operator  │
         └───────────┘   └──────────────┘   └────────────┘
```

## Components

### 1. 1Password CLI (Local Development)

Used for local development and testing.

**Installation:**
```bash
# macOS
brew install 1password-cli

# Linux
curl -sS https://downloads.1password.com/linux/keys/1password.asc | \
  gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" | \
  tee /etc/apt/sources.list.d/1password.list
apt update && apt install 1password-cli
```

**Usage:**
```bash
# Sign in (one-time)
op signin

# Retrieve a secret
op read "op://homelab/proxmox/api-token"

# Use in scripts (with service account token)
export OP_SERVICE_ACCOUNT_TOKEN="<your-token>"
op read "op://homelab/proxmox/api-token"
```

### 2. 1Password Connect (CI/CD)

Self-hosted API server for programmatic access to 1Password secrets.

**Setup:**
1. Deploy 1Password Connect Server (see below)
2. Create a Connect Token in 1Password
3. Add secrets to GitHub Actions:
   - `OP_CONNECT_HOST`: Connect server URL
   - `OP_CONNECT_TOKEN`: Connect token

**GitHub Actions Example:**
```yaml
- name: Retrieve secret from 1Password
  uses: 1password/load-secrets-action@v1
  with:
    export-env: true
  env:
    OP_CONNECT_HOST: ${{ secrets.OP_CONNECT_HOST }}
    OP_CONNECT_TOKEN: ${{ secrets.OP_CONNECT_TOKEN }}
    PROXMOX_TOKEN: op://homelab/proxmox/api-token
```

### 3. 1Password Operator (Kubernetes)

Syncs secrets from 1Password to Kubernetes Secrets automatically.

**Deployment:**
Deployed via ArgoCD in `charts/bootstrap/templates/1password-operator.yaml`.

**Usage in Kubernetes:**
```yaml
apiVersion: onepassword.com/v1
kind: OnePasswordItem
metadata:
  name: proxmox-credentials
  namespace: infrastructure
spec:
  itemPath: "vaults/homelab/items/proxmox"
---
apiVersion: v1
kind: Secret
metadata:
  name: proxmox-api-token
  namespace: infrastructure
type: Opaque
stringData:
  token: onepassworditem://proxmox-credentials/credential
```

#### Bootstrap Process

The 1Password Operator requires initial credentials to connect to the 1Password Connect server. This creates a "bootstrap secret" problem - we need secrets to manage secrets.

**Solution**: The `gitops-bootstrap` Terraform module provisions the credentials Secret during cluster initialization:

1. **Obtain Credentials**:
   - Set up 1Password Connect server (separate infrastructure)
   - Download `1password-credentials.json` from 1Password web UI
   - Generate Connect API token
   - Generate Service Account token (for CLI)

2. **Store Credentials Securely**:
   ```bash
   # Store credentials file
   mkdir -p ~/.op
   cp ~/Downloads/1password-credentials.json ~/.op/
   chmod 600 ~/.op/1password-credentials.json
   ```

3. **Configure Environment Variables**:
   ```bash
   # Add to .envrc
   export TF_VAR_onepassword_credentials_json="$(cat ~/.op/1password-credentials.json)"
   export OP_CONNECT_HOST="https://1password-connect.<DOMAIN>"  # DOMAIN from configuration/environments/homelab.yaml
   export OP_CONNECT_TOKEN="<your-connect-token>"
   export OP_SERVICE_ACCOUNT_TOKEN="<your-service-account-token>"

   # mise loads .envrc automatically (mise.toml [env] _.file); no direnv needed
   ```

4. **Deploy Bootstrap**:
   ```bash
   task tf:apply:component ENV=homelab COMPONENT=gitops-bootstrap
   ```

5. **Verify Deployment**:
   ```bash
   # Check namespace
   kubectl get namespace onepassword-operator

   # Check secret
   kubectl get secret onepassword-credentials -n onepassword-operator

   # Verify operator pods (after ArgoCD sync)
   kubectl get pods -n onepassword-operator
   ```

**Secret Rotation**: To rotate 1Password credentials:
1. Generate new credentials in 1Password web UI
2. Update environment variables in `.envrc`
3. Run `task tf:apply:component ENV=homelab COMPONENT=gitops-bootstrap`
4. Restart operator: `kubectl rollout restart deployment -n onepassword-operator`

## 1Password Vault Structure

Recommended structure for the homelab vault:

```
homelab/ (Vault)
├── proxmox/
│   ├── api-token-id
│   ├── api-token-secret
│   └── root-password
├── truenas/
│   ├── api-key
│   └── root-password
├── cloudflare/
│   ├── api-token
│   └── zone-id
├── github/
│   ├── pat-token
│   └── ssh-key
├── argocd/
│   └── admin-password
└── kubernetes/
    ├── talos-secrets
    └── kubeconfig
```

## Deploying 1Password Connect Server

1. **Create Connect Token:**
   - Log in to 1Password web UI
   - Go to Integrations → 1Password Connect
   - Create a new Connect Server
   - Save the `1password-credentials.json` file

2. **Deploy via Docker (on Proxmox host or separate VM):**
```bash
docker run -d \
  --name op-connect \
  -p 8080:8080 \
  -v /path/to/1password-credentials.json:/home/opuser/.op/1password-credentials.json \
  -v op-data:/home/opuser/.op/data \
  1password/connect-api:latest
```

3. **Or deploy via Kubernetes (preferred):**
   See `charts/bootstrap/templates/1password-operator.yaml` for the full deployment.

## Environment Variables

No direnv. `mise.toml` loads `.envrc` itself (`[env] _.file = ".envrc"`, plain `KEY=value`
lines, no command substitution) and sets `OP_SERVICE_ACCOUNT_TOKEN` in its own `[env]` block.
Everything a task needs from 1Password is resolved at run time: the Taskfile wraps commands in
`op run --env-file=.env.op`, and `.env.op` maps each variable (for example `OP_CONNECT_TOKEN`)
to an `op://homelab/...` reference. Copy `.envrc.example` to `.envrc` only for the
non-secret paths it sets (kubeconfig, the Terraform plugin cache and `ANSIBLE_CONFIG`; the
inventory and roles path live in `ansible/ansible.cfg`).

The short version of this page, with the bootstrap order, is `docs/secrets.md`.

## GitHub Actions Secrets

Set these secrets in your GitHub repository settings. `<DOMAIN>` and `<PROXMOX_IP>` below are placeholders resolved from `configuration/environments/homelab.yaml` (gitignored).

| Secret Name | Description | Example |
|------------|-------------|---------|
| `SOPS_AGE_KEY` | Age private key for the SOPS-encrypted bootstrap secrets | `AGE-SECRET-KEY-...` |
| `PROXMOX_API_URL` | Proxmox API endpoint | `https://<PROXMOX_IP>:8006/api2/json` |
| `PROXMOX_API_TOKEN_ID` | Proxmox token ID | `root@pam!terraform` |
| `PROXMOX_API_TOKEN_SECRET` | Proxmox token secret | `<from-proxmox-ui>` |
| `TS_OAUTH_ID` / `TS_OAUTH_SECRET` / `TS_TAILNET` | Tailscale OAuth client for `tailscale-acl.yml` | `<from-tailscale-admin>` |
| `HOMELAB_BOT_APP_ID` / `HOMELAB_BOT_PRIVATE_KEY` | GitHub App for the regeneration bot (`upgrade.yml`, `ci-autofix.yml`); see `docs/runbooks/ci-bot-app.md` | `<from-github-app>` |

`OP_CONNECT_TOKEN` is a local `op run` variable (`.env.op`), not a CI secret.

## Best Practices

1. **Never commit secrets to git**
   - Use `.gitignore` to exclude `.envrc`, `secrets/`, etc.
   - Use 1Password references instead of hardcoded values

2. **Use service accounts for automation**
   - Create dedicated service accounts for CI/CD
   - Limit permissions to minimum required

3. **Rotate secrets regularly**
   - Set up Renovate to notify about secret rotation
   - Rotate API tokens every 90 days

4. **Audit access**
   - Review 1Password access logs regularly
   - Use separate vaults for different environments

5. **Backup credentials file**
   - Store `1password-credentials.json` in a secure location
   - Keep encrypted backup of recovery keys

## Troubleshooting

### Cannot connect to 1Password Connect
```bash
# Test connection
curl -H "Authorization: Bearer $OP_CONNECT_TOKEN" \
  $OP_CONNECT_HOST/v1/vaults

# Check Connect server logs
docker logs op-connect
```

### Secrets not syncing to Kubernetes
```bash
# Check 1Password Operator logs
kubectl logs -n 1password-system -l app=1password-operator

# Verify OnePasswordItem resource
kubectl get onepassworditems -A
kubectl describe onepassworditem <name> -n <namespace>
```

### Local CLI authentication issues
```bash
# Re-authenticate
op signin

# Verify service account token
export OP_SERVICE_ACCOUNT_TOKEN="<your-token>"
op vault list
```

## References

- [1Password CLI Documentation](https://developer.1password.com/docs/cli)
- [1Password Connect](https://developer.1password.com/docs/connect)
- [1Password Operator](https://github.com/1Password/onepassword-operator)
- [1Password GitHub Action](https://github.com/1password/load-secrets-action)
