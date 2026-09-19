# SOPS Encrypted Secrets

This directory contains SOPS-encrypted Kubernetes secrets managed via GitOps.

## Bootstrap (once per repository)

```bash
# 1. Age key pair: generated once, stored as op://homelab/sops-age-key (fields
#    private_key, public_key), public key written into every creation rule of
#    .sops.yaml. Re-runs reuse the key in 1Password; --dry-run shows the plan.
task sops:bootstrap

# 2. 1Password Connect credentials: read from op://homelab/onepassword-connect
#    (1password-credentials.json + connect_token), rendered as the
#    onepassword-credentials Secret and encrypted into onepassword/onepassword-credentials.sops.yaml
task sops:setup:dry-run  # redacted preview
task sops:setup          # encrypts and commits (task sops:setup -- --help for flags)
task sops:verify         # proves your local age key decrypts what is committed

# 3. Provision the age key in the cluster (gitops-bootstrap reads op://homelab/sops-age-key)
task tf:apply:component COMPONENT=gitops-bootstrap
```

Without a Connect item in 1Password, `task sops:bootstrap` writes the gitignored
`onepassword/onepassword-credentials.template.yaml` on a fresh repository; fill it in and run
`task sops:encrypt`. Key rotation is `task sops:rotate`: `sops:bootstrap:force` regenerates the
pair, overwrites the 1Password item and `.sops.yaml` (keeping any extra recipient a rule lists,
such as the Tailscale ACL key), then re-keys every committed `*.sops.yaml` / `*.sops.hujson`
with `sops updatekeys`; re-apply `gitops-bootstrap` afterwards.

## Available Tasks

| Task | Description |
|------|-------------|
| `task sops:bootstrap` | Generate/reuse the age key in 1Password and write its public key to `.sops.yaml` |
| `task sops:bootstrap:force` | Regenerate the key pair (then `task sops:rotate`) |
| `task sops:setup` / `task sops:setup:dry-run` | Encrypt the 1Password Connect credentials from 1Password (and commit) / redacted preview |
| `task sops:encrypt` | Encrypt a hand-filled `onepassword-credentials.template.yaml` |
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
