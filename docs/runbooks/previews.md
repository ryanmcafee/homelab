# Per-PR preview environments

A pull request can get its own short-lived copy of one or more media apps on the homelab
cluster, rendered from the PR head. Issue #261 item 16; decision record ADR-013.

## Request a preview

1. A maintainer adds the label `preview` to the PR. Only maintainers can label, which is
   the whole trust boundary (see [Trust model](#trust-model)).
2. Optionally add one `preview:<app>` label per app. Without one, the preview runs
   `sonarr` (`global.preview.defaultApps`). Allowed apps (`global.preview.allowedApps` in
   `charts/applications/values.yaml`): `sonarr`, `radarr`, `prowlarr`, `nzbget`,
   `tautulli`, `lazylibrarian`, `flaresolverr`. Any other `preview:<app>` label fails the
   render with an error naming the allowed list.
3. Within about 5 minutes (`previews.requeueAfterSeconds: 300`) ArgoCD creates the
   Application `preview-pr<N>`. The ArgoCD ingress is internal-only, so GitHub webhooks
   cannot reach the ApplicationSet controller: it polls, and a new push to the PR is
   picked up on the next poll too.

## What you get

| Thing | Name |
|---|---|
| Parent Application (namespace `argocd`) | `preview-pr<N>`, project `previews`, source = PR head SHA |
| Namespace | `preview-<N>` (PodSecurity `baseline`, ResourceQuota + LimitRange `preview`) |
| App Applications (namespace `preview-<N>`) | `<app>-pr<N>`, project `previews` |
| URL | `https://<app>-pr<N>.<domain>` (`envoy-internal` Gateway, same as production) |
| Smoke check | PostSync Job `smoke-<app>` in `preview-<N>` curls `<svc>.preview-<N>.svc` |

Check status read-only: `task prod:status`, or in the ArgoCD UI filter on project `previews`.

## Teardown

Close or merge the PR, or remove the `preview` label. On the next poll the ApplicationSet
deletes `preview-pr<N>`; its finalizer prunes the `<app>-pr<N>` Applications (each with its
own finalizer) and the `preview-<N>` Namespace.

A preview claims no volume (see [Limits](#limits)), so teardown leaves no
PersistentVolume or TrueNAS dataset behind; there is nothing to clean up by hand.

## Limits

- **Resources:** quota `requests.cpu 4`, `requests.memory 8Gi`, `limits.cpu 12`,
  `limits.memory 16Gi`, 30 pods, no LoadBalancer or NodePort Services, and
  `persistentvolumeclaims: 0` / `requests.storage: 0` (`global.preview.quota`); containers
  without resources get the LimitRange defaults.
- **Ephemeral storage, by design:** every TrueCharts persistence entry renders as an
  `emptyDir`: the config volume (never production's claim, and no new PVC) as well as
  every NFS media mount. A preview starts empty, and its config is lost whenever a preview
  pod restarts or is rescheduled; reconfigure it, or push again for a fresh one. The
  `previews` AppProject does not allow PersistentVolumeClaims and the quota rejects them.
- **No secrets:** no `*-config` children, no 1Password items (the `previews` AppProject
  does not allow `onepassword.com`, `Secret`, ServiceAccounts or RBAC).
- **No cluster-wide changes:** the only cluster-scoped kind is the preview Namespace. CRDs,
  operators and anything from `charts/addons` cannot be previewed; a PR changing those is
  verified by level 0-2 on Kind only. Isolated control planes (vcluster) are not
  implemented.
- **Never previewed:** plex (GPU, LoadBalancer), homeassistant (hostNetwork), mosquitto
  (LoadBalancer), renovate, duckdns.
- Let's Encrypt issues one certificate per preview host (limit: 50 per registered domain
  per week).

## Trust model

The label is maintainer-applied, and the ApplicationSet also generates Applications for
fork PRs: a labelled fork PR runs **code from the fork** on the homelab cluster, rendered
by the CMP with the real `configuration/environments/homelab.yaml` values (domain, IPs) in
scope. Label a fork PR only after reading its diff. What bounds a preview:

- `cmp/plugin.yaml` is baked into the `homelab-cmp` image, not read from the PR; it
  rejects `PREVIEW_PR` that is not digits and `PREVIEW_APPS` outside `[a-z0-9,-]`.
- The `previews` AppProject: sources = this repo + `oci.trueforge.org/truecharts`;
  destinations = `preview-*` on the in-cluster server only; `sourceNamespaces:
  [preview-*]`; cluster kinds = Namespace only; namespaced kinds = the whitelist in
  `charts/gitops/templates/previews-appproject.yaml`. ArgoCD refuses the whole sync if a
  PR renders anything else, including Applications that name another project.
- PodSecurity `baseline` in `preview-<N>`: no privileged pods, hostPath, hostNetwork or
  extra capabilities.

## How it works

- `charts/gitops/templates/previews-applicationset.yaml` (homelab only,
  `previews.enabled`): `pullRequest.github` generator (`github.com/ryanmcafee/homelab`, label
  `preview`, anonymous: the repo is public; set `previews.github.tokenSecret.name` to use a
  token Secret in `argocd`). The template renders `charts/applications` at `{{.head_sha}}`
  through plugin `homelab-config-helm-v1.0` with env `PREVIEW_PR={{.number}}` and
  `PREVIEW_APPS=<preview:* labels, prefix stripped, lower-cased, comma-joined>`.
- `charts/gitops/templates/previews-appproject.yaml`: the `previews` AppProject.
- `charts/bootstrap/values-homelab.yaml`: `configs.params."application.namespaces":
  "preview-*"` lets the controller and server reconcile Applications outside `argocd`.
- `cmp/plugin.yaml`: validates the two variables and adds `--set-string
  global.preview.pr=<N> --set-string global.preview.apps=<a\,b>` to `helm template`.
- `charts/applications/templates/_preview.tpl`: preview mode helpers; with
  `global.preview.pr` empty the chart renders byte-identically to before.
- Level 0 env `homelab-preview`: the homelab two-stage render of `charts/applications`
  with `global.preview.pr=123` and every allowed app; snapshot
  `tests/snapshots/homelab-preview/applications.yaml`; `gitops/homelab-preview/repo-secrets`
  is skipped (the repository Secret is provided by the homelab env). Policy
  `tests/policy/applicationset.rego` checks every ApplicationSet template (finalizer,
  ServerSideApply, project not `default`, automated sync).

## Rollout (human, after merge)

1. The pre-commit hook bumps `images.homelab-cmp` for the `cmp/plugin.yaml` change; the
   new image must be running before a PR is labelled. An old CMP ignores the preview
   variables and renders the production chart, which the `previews` AppProject then
   refuses to sync (nothing is applied).
2. ArgoCD picks up `application.namespaces` from the bootstrap sync (server and controller
   restart).
3. Label a test PR `preview`, wait for `preview-pr<N>` Healthy, open
   `https://sonarr-pr<N>.<domain>`, remove the label, and confirm the `preview-<N>`
   namespace is gone.
