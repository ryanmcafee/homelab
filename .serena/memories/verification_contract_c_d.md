# Verification contract, previews, read-only prod, upgrades, drills, scaffolder (issue #261 C+D, ADR-013/014)

Agent contract
- `.claude/settings.json` (committed; `.gitignore` has `!.claude/settings.json`) runs
  `scripts/claude-verify-hook.ts` after Edit/Write/MultiEdit under `charts/` or `configuration/`:
  builds `./cmd/homelab`, runs level 0 (150 s cap), silent on pass, exit 2 + ≤60-line summary on fail.
  `HOMELAB_VERIFY_HOOK=off` disables; per-root lock in `$TMPDIR`; a fresh worktree needs `mise trust`.
- No verification block in PR bodies (ADR-032): `pr-contract.yml` job `claim` (required check name
  kept) runs `task verify` on the PR head and fails iff level 0 fails. Skips `renovate/*`, drafts.
- gitops-test skill has no apply/patch/sync/repoint-prod command at all (Tiers 3/4 deleted).

Previews (item 16)
- Labels `preview` + `preview:<app>` → ApplicationSet `previews` (charts/gitops, homelab only) →
  Application `preview-pr<N>` renders `charts/applications` at `head_sha` through the CMP with plugin
  env `PREVIEW_PR`/`PREVIEW_APPS` → `--set-string global.preview.pr/apps` (cmp/plugin.yaml validates them).
- Preview mode (`_preview.tpl`): Applications `<app>-pr<N>` in namespace `preview-<N>` (ArgoCD
  `application.namespaces: preview-*`), project `previews`, hosts `<app>-pr<N>.<domain>`, ALL
  persistence emptyDir, quota 0 PVCs, PSA baseline, only `global.preview.allowedApps` (TrueCharts
  apps); plex/homeassistant/mosquitto/renovate/duckdns never. Normal render must stay byte-identical.
- Level-0 env `homelab-preview` (applications only, pr=123, all allowed apps); repo-secrets = skip.
- `tests/policy/applicationset.rego` + 4 negative fixtures (policy-test.ts needs one per rule id).

Read-only production (item 18)
- Chart `agent-readonly` (both envs): SA `agent-access/agent-readonly` + token Secret, `view` + custom
  ClusterRole (cluster-scoped reads + repo CR groups), never Secrets/writes; Group `homelab:agent-readonly`.
- Tailscale `apiServerProxyConfig.mode: noauth`; proxy host `tailscale-operator-homelab.<tailnet>.ts.net`.
- `homelab verify prod` (refuses `kind-*`), `scripts/prod-readonly.ts kubeconfig|status|diff`
  (context `homelab-readonly`, `~/.kube/homelab-readonly.yaml`, token via `op`, ArgoCD token in env).
- ArgoCD `accounts.agent: apiKey` + `g, agent, role:readonly`; GitHub notifications behind two flags
  (`argocd.notificationsGithub.enabled` in bootstrap values-homelab, `notifications.github` in gitops).

Upgrades (item 19)
- `homelab verify upgrade --base <ref>`: base render in a temp git worktree; upstream `helm template`
  of every changed chart source at base/head (helm resolved via `mise which helm` in the working tree —
  mise refuses the untrusted temp worktree); own Myers per-object diff; `upgrade/<env>/_repo` diffs the
  repo's own manifests. `upgrade.yml`: sticky `upgrade-diff`, CRD revalidation after `schemas:vendor`,
  status `upgrade/automerge-gate` on `renovate/*`; optional `regenerate` job (GitHub App secrets
  HOMELAB_BOT_APP_ID/PRIVATE_KEY, author homelab-regen-bot, Renovate `gitIgnoredAuthors`).
- `versions/<env>` level-0 check: rendered chart versions must be pinned in versions.yaml unless in
  `tests/gitops/version-drift.yaml` (bootstrap argo-cd 9.4.7, connect 1.16.0 — plain Helm, owner decision).
- Renovate: `platformAutomerge: false` everywhere; manager file patterns anchored at the repo root
  (`internal/scaffold/testdata/repo` is a miniature repo copy).

Restore drill (item 20)
- Addon `cnpg-barman-cloud` (chart plugin-barman-cloud, cnpg-system, needs cert-manager); native
  barmanObjectStore is removed in CNPG 1.31. S3 fake `versity/versitygw` (MinIO has no images).
- `tests/drills/cnpg-restore` (own `.chainsaw.yaml`), `task drill:restore` / `task test:drill`,
  weekly `restore-drill.yml` opening/closing an issue labelled `restore-drill`.
- Gotchas: the plugin chart needs `--kube-version` ≥ 1.29 for a bare `helm template`; its ObjectStore
  CRD is a chart template, so `helm show crds` is empty (the vendor script falls back to
  `helm template --include-crds`); versitygw runs as root by default (drill sets UID 10001 + fsGroup;
  global flags go before `posix`); boto3 path-style addressing against the in-cluster FQDN just works.
- `localdev:sync --warm`/`--only` used to end while a parent still held a wave open (its later
  children not created yet) → final pass hung; `parentsAwaitingWaves` keeps the loop polling.

Scaffolder (item 21)
- `homelab scaffold app <name> --pattern operator|helm|deps-main-config`, `embed.FS` templates in
  `internal/scaffold/templates/`, goldens in `internal/scaffold/testdata/`; regenerates localdev values
  and touched snapshots in-process; `task test:scaffold` (selftest in a temp copy, needs
  `MISE_TRUSTED_CONFIG_PATHS`), job `scaffold` in verify.yml.
