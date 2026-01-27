# SOPS Encrypted Secrets

This directory contains SOPS-encrypted Kubernetes secrets managed via GitOps.

## Quick Start (Automated)

```bash
# 1. Bootstrap SOPS (generates age keys, stores in 1Password, configures .sops.yaml)
task sops:bootstrap

# 2. Setup 1Password credentials (pulls from 1Password, encrypts, commits)
task sops:setup

# 3. Apply gitops-bootstrap to provision age key in cluster
task tf:apply:component COMPONENT=gitops-bootstrap
```

## Available Tasks

| Task | Description |
|------|-------------|
| `task sops:bootstrap` | Generate age keys and store in 1Password |
| `task sops:bootstrap:force` | Regenerate keys (overwrites existing) |
| `task sops:setup` | Full automated setup - pull credentials, encrypt, commit |
| `task sops:setup:dry-run` | Preview setup without making changes |
| `task sops:encrypt` | Encrypt a template file |
| `task sops:decrypt` | Decrypt and view credentials (stdout) |
| `task sops:edit` | Edit encrypted credentials in-place |
| `task sops:rotate` | Rotate keys and re-encrypt all secrets |
| `task sops:verify` | Verify SOPS can decrypt secrets |

## Prerequisites

Tools are managed via mise (installed automatically):
```bash
mise install
```

Required tools: `age`, `sops`, `op` (1Password CLI)

## How It Works

1. **Age keys** are generated and stored in 1Password (`homelab/sops-age-key`)
2. **Public key** is configured in `.sops.yaml` for encryption
3. **1Password credentials** are pulled and encrypted with SOPS
4. **ArgoCD** uses ksops plugin with the age private key mounted from a Kubernetes secret
5. **Secrets** are decrypted at deploy time by ArgoCD's repo-server

## Manual Operations

### Edit Encrypted Secrets

```bash
# Decrypt, edit in $EDITOR, re-encrypt automatically
task sops:edit
```

### Add New Encrypted Secret

```bash
# Create unencrypted file (use .yaml, not .sops.yaml)
# Then encrypt:
sops --encrypt path/to/secret.yaml > path/to/secret.sops.yaml
rm path/to/secret.yaml
```

### Decrypt for Debugging

```bash
# View decrypted content
task sops:decrypt

# Or for any SOPS file:
sops --decrypt charts/secrets/onepassword/onepassword-credentials.sops.yaml
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   1Password     │────▶│  sops:setup     │────▶│  Encrypted      │
│  (credentials)  │     │  (automation)   │     │  .sops.yaml     │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
┌─────────────────┐     ┌─────────────────┐              │
│   1Password     │────▶│  gitops-        │              │
│  (age key)      │     │  bootstrap      │              │
└─────────────────┘     └────────┬────────┘              │
                                 │                       │
                                 ▼                       ▼
                        ┌─────────────────┐     ┌─────────────────┐
                        │  K8s Secret     │     │    ArgoCD       │
                        │  (sops-age-key) │────▶│    (ksops)      │
                        └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │  Decrypted      │
                                                │  K8s Secrets    │
                                                └─────────────────┘
```

## Troubleshooting

### SOPS decryption fails locally

Ensure the age key is available:
```bash
# Set environment variable
export SOPS_AGE_KEY=$(op read 'op://homelab/sops-age-key/private_key')

# Or use op run
op run --env-file=.env.op -- sops --decrypt file.sops.yaml
```

### ArgoCD can't decrypt secrets

1. Verify the `sops-age-key` secret exists in the `argocd` namespace
2. Check repo-server pod logs for ksops errors
3. Re-apply gitops-bootstrap: `task tf:apply:component COMPONENT=gitops-bootstrap`
