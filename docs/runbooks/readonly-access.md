# Read-only production access and deploy notifications

Agents may change only Kind (ADR-009). This runbook covers what they can do against the homelab
(production) cluster: read it, through identities that RBAC keeps read-only, over Tailscale. It also
covers the ArgoCD notifications that post deploy status to the PR that produced a sync
(issue #261 item 18).

## What exists after merge

ArgoCD syncs all of this. Nothing works end to end until the human steps below are done.

| Piece | Where | What it does |
|-------|-------|--------------|
| Namespace `agent-access` | `charts/addons/templates/agent-readonly.yaml` (wave 1) | PodSecurity `restricted`; nothing runs there |
| Application `agent-readonly` | same file (wave 2) → `charts/agent-readonly` | Enabled in homelab **and** Kind |
| ServiceAccount `agent-readonly` + Secret `agent-readonly-token` | `charts/agent-readonly/templates/serviceaccount.yaml` | Long-lived token (`kubernetes.io/service-account-token`) that the token controller fills |
| ClusterRoleBinding `agent-readonly-view` → built-in `view` | `charts/agent-readonly/templates/rbac.yaml` | Read access to namespaced workloads, Services, ConfigMaps and `pods/log`. Never Secrets |
| ClusterRole + binding `homelab-agent-readonly` | same | `get/create` on `pods/exec` and `pods/portforward` (diagnosis: `amtool`, port-forward to Prometheus/Alertmanager). `get/list/watch` on nodes, namespaces, persistentvolumes, events, storageclasses, ingressclasses and CRDs, plus `*` in `argoproj.io`, `cert-manager.io`, `gateway.networking.k8s.io`, `gateway.envoyproxy.io`, `cilium.io`, `postgresql.cnpg.io`, `barmancloud.cnpg.io`, `monitoring.coreos.com`, `onepassword.com`, `tailscale.com`, `externaldns.k8s.io` |
| Group `homelab:agent-readonly` | both bindings | Same roles for a future Tailscale "auth" mode (impersonation). Unused today |
| Tailscale API server proxy | `charts/addons/templates/tailscale-operator.yaml` `apiServerProxyConfig.mode: "noauth"` | `https://tailscale-operator-homelab.<tailnet>.ts.net` forwards requests without adding authentication, so the caller's bearer token authenticates it |
| ArgoCD account `agent` | `charts/bootstrap/values-homelab.yaml` `configs.cm."accounts.agent": apiKey`, `configs.rbac."policy.csv": g, agent, role:readonly` | API token only (no UI login). `role:readonly` can view and diff but not sync, delete or exec |
| ArgoCD account `triage-agent` | same file, `accounts.triage-agent: apiKey`, `p, role:triage-agent, applications, get` and `sync` | The alert triage agent's sync identity (docs/runbooks/triage-agent.md): get and sync Applications, nothing else |
| GitHub notifier (off) | `charts/bootstrap/values-homelab.yaml` `argocd.notificationsGithub` | `service.github`, templates `app-deployed`, `app-sync-failed`, `app-health-degraded`, triggers `on-deployed`, `on-sync-failed`, `on-health-degraded`, OnePasswordItem `argocd-notifications-secret` |
| Subscriptions (off) | `charts/gitops/values*.yaml` `notifications.github` → annotations on `bootstrap`, `addons`, `applications` | `notifications.argoproj.io/subscribe.<trigger>.github: ""` |

The verbs are fixed in the template and never come from values. The chart refuses a `crdGroups` entry
of `""` or `*`, because `resources: ["*"]` in the core group would include Secrets.
`tests/e2e/agent-readonly` proves in Kind, with `kubectl auth can-i --as=...`, that the
ServiceAccount and the group can list pods, read `pods/log`, Applications, CRDs, nodes, PVs and
Certificates, can `exec` and port-forward, and cannot read Secrets, create ConfigMaps, create or
delete pods, `attach`, patch Applications or delete CRDs.

`pods/exec` and `pods/portforward` are the diagnostic channel: Alertmanager and Prometheus have no
route, so `amtool alert` (exec) or a port-forward is how an agent reads what is firing
(`docs/runbooks/alerting.md`). API objects stay read-only, but exec is not: a shell in a container
can read the Secrets that container mounts and change state inside it. Agents use it to inspect,
never to change anything; revoking the token (below) closes it in one command.

## Agent commands

```bash
task prod:kubeconfig                  # once per workstation: writes ~/.kube/homelab-readonly.yaml (0600)
task prod:kubeconfig -- --tailnet tail1234.ts.net   # when the tailscale CLI is not on PATH
task prod:kubeconfig -- --dry-run     # print the kubeconfig, token redacted, 1Password untouched
task verify:prod                      # prod/argocd/<app> checks, exit 0/1/2
task verify:prod -- --json            # the level-2 JSON contract ({"level":2,"checks":[...]})
task verify:prod -- --require-synced  # also fail OutOfSync Applications
task prod:status                      # Application table: sync, health, last operation, revision
task prod:diff -- <app>               # argocd app diff as the read-only ArgoCD account
```

- `homelab verify prod` runs one `kubectl get applications.argoproj.io -n argocd` through context
  `homelab-readonly` in `~/.kube/homelab-readonly.yaml`. It refuses `kind-*` contexts (the local
  loop uses `task verify LEVEL=2`). Anything that blocks the read is one failing `prod/argocd/apps`
  check, never a skip.
- `prod/argocd/domain` proves the base domain reached production: the root `gitops` Application
  must carry the helm parameter `global.domain` that `terragrunt/modules/gitops-bootstrap` injects
  (the domain never lives in git), and no Application may embed the chart placeholder `example.com`
  in `helm.values`, `helm.valuesObject` or `helm.parameters`. It fails, naming the Applications,
  when the module was changed but not applied — the ArgoCD HTTPRoute then reads `argocd.example.com`
  (`docs/project_notes/bugs.md` 2026-09-13). The fix is a human `task tf:apply:component
  COMPONENT=gitops-bootstrap`, never an agent action.
- `task prod:diff` passes the ArgoCD token in `ARGOCD_AUTH_TOKEN` rather than on the command line.
  It points the CLI at an empty private `--config`, so a saved admin login is never used. The server
  comes from `--argocd-server`, then `HOMELAB_ARGOCD_SERVER`, then `argocd.<DOMAIN>` from the
  gitignored `configuration/environments/homelab.yaml`.
- The read-only kubeconfig is its own file. The script refuses to write `~/.kube/config`, and agents
  never use the admin kubeconfig or talosconfig for production.
- Kubernetes object reads are the full contract. Changes reach production only through merge →
  ArgoCD, and deploy status comes back through the notifications below.

## Human steps (one time, in order)

Agents do none of these. None of them is automated.

1. **Merge.** ArgoCD creates the `agent-readonly` Application, restarts the Tailscale operator with
   the API server proxy, and adds the ArgoCD `agent` account. Check that `agent-readonly` is
   Healthy in the ArgoCD UI.
2. **Tailnet.** Make sure MagicDNS and HTTPS certificates are enabled in the Tailscale admin console.
   The proxy serves a Let's Encrypt certificate for `tailscale-operator-homelab.<tailnet>.ts.net`,
   which is why the kubeconfig carries no CA. Then grant the agent's device access to the operator.
   Edit the SOPS-encrypted policy with `sops policy.sops.hujson` (never commit it decrypted) and
   add a grant like the one below, replacing the source with the agent's user, device tag or group:

   ```hujson
   {"src": ["autogroup:admin"], "dst": ["tag:k8s-operator"], "ip": ["tcp:443"]},
   ```

   Apply it the way the policy is normally applied. `tag:k8s-operator` is the operator's
   `defaultTags`. The grant only opens the TCP path; the ServiceAccount token still has to
   authenticate.
3. **Kubernetes token → 1Password.** Using your admin context, copy the token the controller put in
   the Secret into the API Credential item the scripts read (`op://homelab/k8s-agent-readonly/credential`):

   ```bash
   op item create --vault homelab --category "API Credential" --title k8s-agent-readonly \
     "credential=$(kubectl -n agent-access get secret agent-readonly-token -o jsonpath='{.data.token}' | base64 -d)"
   ```

4. **ArgoCD token → 1Password.** Log in as an admin, then generate a token for the `agent` account
   (`op://homelab/argocd-agent-token/credential`):

   ```bash
   op item create --vault homelab --category "API Credential" --title argocd-agent-token \
     "credential=$(argocd account generate-token --account agent --grpc-web)"
   ```

5. **Check it from the agent's machine:** `task prod:kubeconfig && task verify:prod && task prod:diff -- addons`.

### Rotation and revocation

| Credential | Revoke | Rotate |
|------------|--------|--------|
| ServiceAccount token | `kubectl -n agent-access delete secret agent-readonly-token`. The old token dies at once | ArgoCD recreates the Secret with a new token (self-heal); repeat step 3 with `op item edit k8s-agent-readonly --vault homelab "credential=..."` |
| ArgoCD `agent` token | `argocd account delete-token --account agent <id>` (`argocd account get --account agent` lists ids) | Repeat step 4 with `op item edit` |
| Tailnet access | Remove the grant | n/a |

Both tokens are long-lived on purpose: an expiring token would silently break unattended agent
checks. What limits their reach is that both identities are read-only on API objects (the Kubernetes
one can also exec and port-forward, see above) and live only in 1Password,
and either can be revoked in one command. Rotate them quarterly or whenever a machine that held them
is retired.

## Deploy notifications (GitHub App, then two flags)

With both flags on, every sync of `bootstrap`, `addons` and `applications` produces two things. The
first is a commit status `argocd/<app>` (success, error or failure) on the synced revision. The
second is one comment per Application on the PR that produced that revision, upserted through
`commentTag` so each app keeps a single comment. The PR is found from the commit, so a
squash-merged PR gets the comment. Each trigger fires once per revision (`oncePer`), and links point
at the internal `argocd.<domain>` (tailnet only).

1. Create a GitHub App under the repository owner: no webhook. Grant **Commit statuses: read &
   write**, **Pull requests: read & write**, **Contents: read-only** and **Metadata: read-only**.
   Install it on `github.com/ryanmcafee/homelab` only and generate a private key.
2. Create the 1Password item `argocd-notifications-github` in vault `homelab`
   (`vaults/homelab/items/argocd-notifications-github`) with three fields whose labels are exactly
   `github-appID`, `github-installationID` and `github-privateKey` (the full PEM). The 1Password
   operator turns them into the keys of Secret `argocd/argocd-notifications-secret`, and
   `service.github` reads them as `$github-appID` and so on.
3. PR 1: set `argocd.notificationsGithub.enabled: true` in `charts/bootstrap/values-homelab.yaml`.
   After merge, check that OnePasswordItem `argocd-notifications-secret` is Ready and `bootstrap` is
   Healthy. If the item is missing, the OnePasswordItem health check marks it Degraded and
   `bootstrap` with it, which is why this flag defaults to false.
4. PR 2: set `notifications.github: true` in `charts/gitops/values-homelab.yaml`. That PR's own merge
   should receive the first `argocd/bootstrap`, `argocd/addons` and `argocd/applications` statuses.

Turning off is the reverse: flip `notifications.github` off first, then the bootstrap flag.

## Troubleshooting

| `verify prod` says | Meaning | Fix |
|--------------------|---------|-----|
| `read-only kubeconfig ... does not exist` | Step 5 not run on this machine | `task prod:kubeconfig` |
| `production API server unreachable` | Tailscale down, no grant, MagicDNS/HTTPS off, operator not running | `tailscale status`, step 2, `tailscale-operator` Application health |
| `rejected the agent-readonly token (Unauthorized)` | Token revoked or rotated | Step 3 with `op item edit`, then `task prod:kubeconfig` |
| `RBAC denied reading Applications (Forbidden)` | `homelab-agent-readonly` binding missing | Check the `agent-readonly` Application in ArgoCD |
| `op read ... failed` (scripts) | 1Password CLI not signed in, or item missing | `op signin`; steps 3–4 |

## Decisions (conservative choices where the plan left one)

- The namespace PodSecurity is `restricted` rather than `baseline`: nothing runs in `agent-access`.
- The proxy runs in `noauth` mode rather than `auth` (impersonation). With `noauth`, the tailnet
  gives connectivity only and a revocable Kubernetes token gives identity. `auth` mode would need
  an ACL grant per agent identity in the encrypted policy. The `homelab:agent-readonly` Group
  binding is already in place for a later switch.
- The default `--hostname` is `tailscale-operator-homelab` (the operator's real
  `operatorConfig.hostname`), not `tailscale-operator`.
- `verify prod` fails, never skips, when it cannot read, and it treats OutOfSync as a failure only
  with `--require-synced`.
- Notifications ship off behind two flags. The subscriptions cover only the three parent
  Applications, since chart-sourced children have no GitHub revision.
- The ArgoCD token travels in the environment, not argv. The kubeconfig is written with mode 0600
  and a dry run shows it with the token redacted.
