# Kind + ArgoCD loop (issue #261 Section B, ADR-012)

Localdev Applications are synced from the WORKING TREE, not from git: `task localdev:sync` runs
`argocd app sync <app> --local charts/<path> --local-repo-root . --prune --async` tier by tier
((parent sync-wave, own sync-wave)). ArgoCD refuses `--local` on apps with automated sync, so the
platform key `ARGOCD_AUTOMATED_SYNC` is `"false"` in `configuration/environments/localdev.yaml`:
every Application template wraps `automated:` in `{{- if .Values.global.automatedSync }}` and the
policy rule `app-automated` is skipped when `_data.yaml` says `argocd_automated_sync: false`.
Consequence: after a local sync an app shows OutOfSync vs GitHub `main` — expected; `task
localdev:wait` checks Healthy + operation Succeeded (`--require-synced` is opt-in).

Pieces
- `scripts/localdev-kind.ts up|down|fakes|registry`: Kind `homelab-localdev` (image
  `images.kind-node` from versions.yaml), Cilium CNI installed from `charts/addons/values-localdev.yaml`
  `cilium.values` (the `cilium` Application adopts it), registry pull-through caches
  `kind-registry-<docker|ghcr|quay|k8s|lscr>` (cache dir `~/.cache/homelab-kind-registry`, hosts.toml in
  `/etc/containerd/certs.d`), fakes from `localdev/fakes/` (StorageClass aliases → local-path, seeded
  Secrets, OnePasswordItem CRD).
- `scripts/localdev-argocd.ts install|sync|wait|diagnose`: helm-installs argo-cd (version
  `charts.argocd`) with `localdev/values/argocd-values.yaml` + `--set-file` of every
  `charts/bootstrap/files/health/*.lua`; root app `localdev/argocd/gitops-app.yaml` (GitHub main, no
  automation); login via NodePort 30080 → http://localhost:8080.
- Fakes as capability keys (ADR-011): `CERT_ISSUER: selfsigned` renders `ClusterIssuer/letsencrypt`
  with `selfSigned: {}`; `MEDIA_PROVIDER: ephemeral` renders media mounts as emptyDir; storage
  provider `local-path` drops `existingClaim`/`configExistingClaim`; `CNI_PROVIDER: cilium`;
  cloudnative-pg runs in Kind.
- Health Lua: `charts/bootstrap/files/health/<group>_<kind>.lua`, injected by
  `charts/bootstrap/templates/argocd.yaml` (.Files.Glob) and tested by `task test:health`
  (`tests/health/<group>_<kind>/*.yaml`, `# expect:` header, `argocd admin settings
  resource-overrides health`).
- PostSync smoke hooks: `homelab.smokeJob` helper in charts/{addons,applications}/templates/_smoke.tpl,
  values `<app>.smoke {enabled,url,expect}`, image `curlimages/curl:{{ global.images.curl }}`.
- e2e: `tests/e2e/<app>/chainsaw-test.yaml` (`task test:e2e`); `homelab verify all --level 1`
  (server dry-run in Kind: `dryrun/localdev/<chart>`), `--level 2` (+ `argocd/<app>`, `e2e/<test>`).
- CI: `.github/workflows/tilt-ci.yml` job `kind-argocd` runs `task localdev:ci` (required, no
  continue-on-error) with the registry cache in actions/cache.

Gotchas: Traefik NodePorts must not use 30080 (ArgoCD); `sops-secrets`/1Password are disabled in
`charts/bootstrap/values-localdev.yaml`; never regenerate snapshots from a subagent in a shared worktree.
