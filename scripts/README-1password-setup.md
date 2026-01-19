# 1Password Secrets Setup Guide

This guide helps you migrate your hardcoded secrets from `.envrc` to 1Password.

## Prerequisites

1. **Install 1Password CLI**:
   ```bash
   # Already configured in mise (see .mise.toml)
   mise install
   ```

2. **Authenticate with 1Password**:
   ```bash
   op signin
   ```

## Step 1: Populate 1Password Vault

Run the setup script to create all secrets in your 1Password vault:

```bash
chmod +x scripts/setup-1password-secrets.sh
./scripts/setup-1password-secrets.sh
```

This script will:
- Create a `homelab` vault (if it doesn't exist)
- Create the following items:
  - `proxmox` - Proxmox API credentials
  - `cloudflare` - Cloudflare API token and zone ID
  - `onepassword-connect` - 1Password Connect credentials
  - `truenas` - TrueNAS API key (you'll need to provide this)
  - `network-config` - Network and cluster configuration

## Step 2: Verify Secrets

Check that all secrets were created correctly:

```bash
# List all items in the homelab vault
op item list --vault homelab

# View a specific item (without revealing secrets)
op item get proxmox --vault homelab

# Read a specific secret value
op read "op://homelab/proxmox/api_token_secret"
```

## Step 3: Update .envrc

Replace your current `.envrc` with the 1Password-integrated version:

```bash
# Backup current .envrc
cp .envrc .envrc.backup

# Use the new 1Password version
cp .envrc.1password .envrc

# Reload environment
direnv allow
```

## Step 4: Test the Configuration

Verify that all environment variables are loaded correctly:

```bash
# Test Terraform variables
echo $TF_VAR_proxmox_api_url
echo $TF_VAR_cloudflare_api_token

# Test 1Password variables
echo $OP_CONNECT_HOST
```

## Step 5: Clean Up

Once you've verified everything works:

1. **Delete the backup** (contains plaintext secrets):
   ```bash
   shred -u .envrc.backup  # Secure deletion
   ```

2. **Update documentation** if needed

## Troubleshooting

### "not currently signed in" error
```bash
# Re-authenticate
op signin
```

### "item not found" error
```bash
# Check if the vault exists
op vault list

# Check if the item exists
op item list --vault homelab
```

### Environment variables not loading
```bash
# Reload direnv
direnv allow

# Check for errors
direnv status
```

## Secret Structure Reference

Your 1Password vault follows this structure:

```
homelab/ (Vault)
├── proxmox
│   ├── api_url (text)
│   ├── api_token_id (text)
│   ├── api_token_secret (password)
│   └── node (text)
├── cloudflare
│   ├── api_token (password)
│   └── zone_id (text)
├── onepassword-connect
│   ├── connect_host (text)
│   ├── connect_token (password)
│   └── service_account_token (password)
├── truenas
│   ├── api_key (password)
│   └── host (text)
└── network-config
    ├── base_fqdn (text)
    ├── cluster_name (text)
    └── environment (text)
```

## Next Steps

After completing this setup:

1. **Configure GitHub Actions** - Add `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` as repository secrets
2. **Set up 1Password Operator** - Deploy to Kubernetes for secret synchronization
3. **Rotate secrets** - Now that they're in 1Password, schedule regular rotation

See [docs/secrets-management.md](../docs/secrets-management.md) for more details.
