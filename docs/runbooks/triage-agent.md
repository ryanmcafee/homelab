# Alert triage agent

A Claude Agent SDK service in namespace `triage-agent` that investigates every firing alert
read-only and writes a root-cause report: summary, probable root cause, evidence and a
recommended fix naming repository files. It never changes the cluster (ADR-033).

| Piece | Where |
|---|---|
| Service (Bun + TypeScript) | `triage-agent/src/`, tests in `triage-agent/tests/unit/` (`task test:triage-agent`) |
| Image | `Dockerfile.triage-agent`, published by `.github/workflows/triage-agent-image.yml` as `ghcr.io/<owner>/homelab-triage-agent:<images.triage-agent>` |
| Chart | `charts/triage-agent` (Deployment, Service, ServiceAccount, ConfigMap, NetworkPolicy, PVC, OnePasswordItem) |
| Application | `charts/addons/templates/triage-agent.yaml`, wave 10; values from `configuration/templates/helm-addons.tmpl` |
| Alertmanager route | `charts/addons/templates/kube-prometheus-stack.yaml`: receiver `triage-agent`, `continue: true` |

## How alerts reach it

1. **Webhook.** Every alert except `Watchdog`/`InfoInhibitor` also goes to the `triage-agent`
   receiver (`send_resolved: false`); the Pushover routes are unchanged.
2. **Sweep.** Every `sweepIntervalSeconds` (300) the agent reads
   `GET /api/v2/alerts?active=true&silenced=false&inhibited=false` from
   `kube-prometheus-stack-alertmanager.monitoring.svc:9093`, so alerts that fired while it was
   down are picked up too.

Alerts are grouped by `alertname` + `namespace`, deduplicated by fingerprint and triaged one
group at a time. A group triaged within `cooldownSeconds` (24h) runs again only when a new
fingerprint fires in it. `ignoredAlerts` also skips `GitHubPullRequestNeedsReview`.

Before each run the agent resets its shallow clone of the repository to `main`; the clone is the
agent's working directory, so the project `CLAUDE.md`, `AGENTS.md`, `.mcp.json` and
`.claude/settings.json` load (`settingSources: ["user", "project"]`).

## The 1Password item

`TRIAGE_AGENT_1P_PATH` (default `vaults/homelab/items/triage-agent`) becomes Secret
`triage-agent`. Until the item exists the pod stays in `CreateContainerConfigError`.

| Field | Required | Value |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | `claude setup-token` (Claude subscription) |
| `GITHUB_TOKEN` | no | Fine-grained PAT, read-only contents on the dotfiles repository |
| `DOTFILES_REPO` | no | `<owner>/<repo>` of the private dotfiles; with `GITHUB_TOKEN` its `claude/CLAUDE.md` and `claude/profiles/personal/CLAUDE.md` become the agent's user memory |
| `PAPERCLIP_API_KEY` | no | Paperclip board API key; enables the paperclip MCP server |
| `PAPERCLIP_COMPANY_ID` | no | Paperclip company UUID; enables the paperclip MCP server |
| `SLACK_WEBHOOK_URL` | no | Slack incoming webhook; each report is posted there |

The image package must be public (GitHub -> Packages -> `homelab-triage-agent` -> visibility) or
the cluster cannot pull it; the first publish creates it private.

## Claude configuration

`CLAUDE_CONFIG_DIR` (`/home/agent/.claude`, an emptyDir) is rebuilt on every start from the
ConfigMap: `settings.json` (model `opus[1m]`, telemetry off, tool search on, the permission
list) plus the dotfiles files above. The SDK runs with `permissionMode: dontAsk`: a tool call
outside `settings.permissions.allow` is denied, never prompted. Model, `maxTurns` and the run
timeout are `agent.*` in `charts/triage-agent/values.yaml`.

| MCP server | Default | Notes |
|---|---|---|
| sequential-thinking | on | `npx @modelcontextprotocol/server-sequential-thinking` |
| context7 | on | `npx @upstash/context7-mcp` |
| memory | on | `MEMORY_FILE_PATH=/data/memory.json`, a PVC when `TRIAGE_AGENT_MEMORY_PERSISTENCE=true` |
| serena | on | from the repository's `.mcp.json`; the chart copy is skipped so it is registered once |
| paperclip | on when both Paperclip fields exist | `uvx paperclip-mcp` against `paperclip.paperclip.svc:3100`, read tools only |
| puppeteer | off | deprecated upstream; the image has no Chromium |
| codesearch | n/a | a workstation binary, not available in the cluster |

## Security model

- ServiceAccount `triage-agent` is bound to `view` and `homelab-agent-readonly`
  (`charts/agent-readonly`): no Secrets, no write verbs, `pods/exec` and `pods/portforward`
  for diagnosis. The chart never widens either role.
- exec can read what a container mounts and `curl` can reach unauthenticated in-cluster APIs
  (Alertmanager, Prometheus); the system prompt forbids writes there and a human reviews every
  recommendation. This is the same trust as `docs/runbooks/readonly-access.md`.
- Only the `monitoring` namespace may reach the webhook (NetworkPolicy); egress is open for the
  Claude API, GitHub, npm and PyPI.
- Runs as uid 1000, no capabilities, read-only root filesystem, PodSecurity `restricted`.

## Operate

```bash
kubectl -n triage-agent logs deploy/triage-agent -f | jq -c 'select(.msg | test("triage"))'
kubectl -n triage-agent port-forward svc/triage-agent 8080 &
curl -s localhost:8080/reports | jq '.[0].text' -r   # newest report
curl -s localhost:8080/metrics                        # runs, cost, queue depth
```

Trigger a run with a synthetic alert (see `docs/runbooks/alerting.md`, Test delivery), or post
a webhook through the port-forward. `dryRun: true` logs the prompt without calling Claude.
Turn the whole feature off with `TRIAGE_AGENT_ENABLED=false`.
