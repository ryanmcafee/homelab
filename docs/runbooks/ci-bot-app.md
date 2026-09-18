# CI bot App and secrets

Two GitHub Actions workflows push commits back to a pull request and need a token that
triggers CI (a push made with `GITHUB_TOKEN` starts no workflows, so a fix could never be
verified):

| Workflow | Job | What it pushes |
|---|---|---|
| `.github/workflows/upgrade.yml` | `regenerate` | regenerated snapshots, CRD schemas and localdev values on `renovate/*` branches (ADR-014) |
| `.github/workflows/ci-autofix.yml` | `autofix` | Claude Code's fix for a failed PR workflow (`docs/runbooks/ci-autofix.md`) |

Both read the same pair of repository secrets. Until they exist the jobs log
`::notice::... not configured` and exit green, so Renovate PRs that need regeneration stay red
until a human runs `task config:export:localdev`, `task schemas:vendor` and
`task test:snapshot -- --update`, and nothing is auto-fixed.

## 1. Create the GitHub App (once)

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**:

| Field | Value |
|---|---|
| Name | `homelab-bot` (any unique name; the commits are authored as `homelab-regen-bot` / `homelab-ci-autofix` regardless) |
| Homepage URL | this repository |
| Webhook | inactive |
| Repository permissions | **Contents: Read and write**, **Pull requests: Read and write**, **Actions: Read-only**, Metadata: Read-only |
| Where can this App be installed | Only on this account |

After creation: **Generate a private key** (downloads a `.pem`), note the **App ID**, then
**Install App** on this repository only.

## 2. Repository secrets

Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
|---|---|
| `HOMELAB_BOT_APP_ID` | the App ID (a number) |
| `HOMELAB_BOT_PRIVATE_KEY` | the full `.pem` contents, including the `BEGIN`/`END` lines |
| `CLAUDE_CODE_OAUTH_TOKEN` | output of `claude setup-token` on a machine logged into the Claude subscription (ci-autofix only; `ANTHROPIC_API_KEY` works instead) |

Store the `.pem` in 1Password (`op://homelab/homelab-bot-app/private_key`) and delete the
download.

## 3. Prove it

- Open a Renovate PR (or push any `renovate/*` branch) that changes a chart version: the
  `regenerate` job in `upgrade.yml` commits the regenerated files as `homelab-regen-bot` and CI
  re-runs on that commit.
- Break formatting on a scratch PR (`deno fmt` a script badly): `ci-autofix.yml` pushes a
  `fix(ci): …` commit with a `Ci-Autofix-Run:` trailer and posts the sticky `ci-autofix`
  comment with the verdict.

## Rotation and revocation

Regenerate the private key in the App settings and replace `HOMELAB_BOT_PRIVATE_KEY`; the
old key stops working immediately. Uninstalling the App from the repository disables both
jobs without touching the workflows (they fall back to the "not configured" notice).

## Not covered

The `production` environment used by `terragrunt-apply.yml` and `talos-image-rebuild.yml`
has no protection rules and the `PROXMOX_API_*` secrets do not exist; those workflows are
manual-dispatch only and stay dormant until someone decides to run applies from GitHub.
