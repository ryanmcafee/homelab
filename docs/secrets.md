# Secrets

Two systems, one key. SOPS (age) protects the handful of secrets that must exist before
anything else runs; the 1Password operator delivers everything after that. The age private
key never leaves 1Password except into the cluster.

| Secret | Where it lives | Who reads it |
|---|---|---|
| Age private key | `op://homelab/sops-age-key/private_key` | `gitops-bootstrap` (Terragrunt) writes it as the `sops-age-key` Secret in `argocd` |
| Bootstrap credentials (1Password Connect token and credentials) | `charts/secrets/`, SOPS-encrypted, committed | ArgoCD decrypts them with ksops in the `bootstrap` chart |
| Everything else (API tokens, OAuth clients, service credentials) | 1Password vault `homelab` | `OnePasswordItem` resources rendered by the `*-config` / `*-dependencies` child charts |
| Environment values (IPs, hostnames, domain) | `configuration/environments/homelab.yaml` (gitignored) and the `homelab-environment-config` OnePasswordItem | The `homelab-cmp` sidecar at render time; nothing PII-bearing is committed |

## Bootstrap order

1. `task sops:bootstrap` — generate the age key pair once, store the private key in 1Password,
   put the public key in `.sops.yaml`.
2. `task sops:setup` — pull the 1Password Connect credentials, encrypt them into `charts/secrets/`,
   commit.
3. `task tf:apply ENV=homelab` — `gitops-bootstrap` creates the `sops-age-key` Secret, installs
   ArgoCD with ksops and the CMP sidecar, applies the root Application.
4. ArgoCD `bootstrap` chart: `sops-secrets` decrypts `onepassword-credentials` → the 1Password
   operator starts → `homelab-environment-config` and every other `OnePasswordItem` resolve.

See `docs/architecture.md` §3 for the diagram.

## Day to day

```bash
task sops:edit      # edit an encrypted file in place
task sops:decrypt   # print decrypted content
task sops:verify    # prove the local key can decrypt everything committed
task sops:rotate    # rotate the age key (updates 1Password, re-encrypts, needs a bootstrap re-apply)
```

Rules that CI enforces:

- `task config:guard` (the pre-commit hook on staged files, `config-validation.yml` on every
  tracked file in scope) fails on any real IP, hostname, e-mail or domain in `configuration/**`,
  `charts/**/values-homelab.yaml`, `scripts/**`, `docs/**`, `.github/**`, `Taskfile.yml` and
  `ansible/**` (the Ansible inventory is rendered from `configuration/` and gitignored).
  Use `<KEY>` placeholders and RFC 5737 addresses in docs and tests.
- The 1Password paths themselves are not secrets and are committed as `*_1P_PATH` keys in
  `configuration/schema/secrets.schema.yaml`.
- The Tailscale ACL is SOPS-encrypted with a dedicated ACL-only age key
  (`op://homelab/tailscale-acl-age-key`), never the master key.

Details: [charts/secrets/README.md](../charts/secrets/README.md), ADR-010 and the CMP decision
in [project_notes/decisions.md](project_notes/decisions.md).
