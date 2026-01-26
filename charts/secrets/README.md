# SOPS Encrypted Secrets

This directory contains SOPS-encrypted Kubernetes secrets managed via GitOps.

## Prerequisites

1. Install SOPS: `brew install sops`
2. Install age: `brew install age`

## Setup

### 1. Generate Age Key Pair (one-time)

```bash
# Generate a new age key pair
age-keygen -o ~/.sops/age-key.txt

# Output will show the public key:
# Public key: age1qqnete80x7t9tdp2xrp9nwl0n8hr6yjyaf0vtmdjq39qwcm4ra9qgcpf0w
```

### 2. Store Keys in 1Password

Create a 1Password item named `sops-age-key` in the `homelab` vault:
- **private_key**: Contents of `~/.sops/age-key.txt` (the full file including header)
- **public_key**: The public key from step 1

### 3. Update .sops.yaml

Update the `age` recipient in `/.sops.yaml` with your public key.

## Encrypting Secrets

### 1Password Credentials

```bash
# Create the unencrypted secret first (don't commit!)
cat > charts/secrets/onepassword/onepassword-credentials.yaml << 'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: onepassword-credentials
  namespace: onepassword-operator
type: Opaque
stringData:
  1password-credentials.json: |
    <paste your 1password-credentials.json content here>
  token: <paste your connect token here>
EOF

# Encrypt the secret
sops --encrypt charts/secrets/onepassword/onepassword-credentials.yaml > \
  charts/secrets/onepassword/onepassword-credentials.sops.yaml

# Remove the unencrypted file
rm charts/secrets/onepassword/onepassword-credentials.yaml
```

## Editing Encrypted Secrets

```bash
# Edit directly (SOPS will decrypt, open editor, and re-encrypt)
sops charts/secrets/onepassword/onepassword-credentials.sops.yaml
```

## Decryption in ArgoCD

ArgoCD uses the ksops plugin with the age private key stored in the `sops-age-key`
Kubernetes secret (provisioned during bootstrap via Terragrunt).

The secret is mounted at `/.config/sops/age/keys.txt` in the repo-server pod.
