# Runbook: Paperclip agent health alerts

Paperclip runs every agent as a Claude Code child process of the `paperclip-0` pod, so one
memory limit covers the server and all runs in flight. The `homelab-paperclip` rule group
(`charts/addons/templates/kube-prometheus-stack.yaml`) watches that pod and the agent runs;
alerts route like every other rule (warning -> Pushover low priority, critical -> high;
[alerting.md](./alerting.md)).

## Where the metrics come from

| Metrics | Source |
|---|---|
| `container_memory_working_set_bytes`, `kube_pod_container_resource_limits`, `kube_pod_container_status_*` | cAdvisor and kube-state-metrics (kube-prometheus-stack) |
| `paperclip_*` | `paperclip-exporter` Deployment in namespace `paperclip` (`charts/paperclip/templates/exporter.yaml`) |

The exporter is `charts/paperclip/files/paperclip-exporter.ts` run by the stock `oven/bun` image
(`configuration/versions.yaml` `images.bun`). On each scrape (every 60 s) it reads, for every
active company, `GET /api/companies`, `/heartbeat-runs?limit=500`, `/agents`, `/live-runs` and
`/recovery-observability` from `http://paperclip.paperclip.svc.cluster.local:3100/api` with a
board API key. Unit tests: `task test:scripts -- scripts/paperclip-exporter_test.ts`.

| Metric | Labels | Meaning |
|---|---|---|
| `paperclip_up` | | 1 if every API read of the last scrape succeeded |
| `paperclip_agent_runs_finished` | `company_id`, `company`, `status` | runs that finished in the last hour (`paperclip_agent_runs_window_seconds`) by status: succeeded, failed, interrupted, cancelled, timed_out |
| `paperclip_agent_runs_errors` | `company_id`, `company`, `error_code` | the same runs by error code (`orphaned_running_run`, `process_lost`, `acpx_turn_failed`, ...) |
| `paperclip_agent_runs_live` | `company_id`, `company` | queued, running or scheduled-retry runs |
| `paperclip_agents` | `company_id`, `company`, `status` | agents by status |
| `paperclip_agents_phantom_running` | `company_id`, `company` | agents in status `running` without a live run |
| `paperclip_recovery_rate_percent`, `paperclip_recovery_threshold_percent`, `paperclip_recovery_breached`, `paperclip_recovery_week_runs`, `paperclip_recovery_week_actions` | `company_id`, `company` | the latest week of recovery-observability and Paperclip's own breach verdict |

## The 1Password item

`PAPERCLIP_EXPORTER_1P_PATH` (default `vaults/homelab/items/paperclip-exporter`) names one item
with one field, `PAPERCLIP_API_KEY`: a Paperclip board API key (created with the
`create_board_api_key` operation of the Paperclip API or MCP server). The `paperclip-dependencies` Application turns it
into Secret `paperclip-exporter`. The key is read-only in use: the exporter only sends GETs.
Until the item exists the OnePasswordItem is Degraded, the exporter runs without a key and
`PaperclipMetricsUnavailable` fires. Kind seeds a placeholder (`localdev/fakes/secrets.yaml`),
so there the exporter always reports `paperclip_up 0`.

## Alerts

### PaperclipMemoryNearLimit (warning > 85 % for 5 m, critical > 95 % for 2 m)

Memory climbs in steps as agent runs start; on 2026-09-25 it went from 73 % to the limit within
two minutes, so treat the warning as "one more run will kill the pod".

1. `kubectl -n paperclip top pod paperclip-0` and the "Paperclip request path" dashboard (panel 6).
2. Count running agents: `paperclip_agent_runs_live`, or the Paperclip UI dashboard.
3. Pause agents that are not needed right now (UI, or `pause_agent`), so no new run starts.
4. If it recurs, raise `paperclip.instance.resources.limits.memory` in
   `configuration/templates/helm-apps.tmpl` and re-render (`task config:export:localdev`,
   `task test:snapshot -- --update`).

### PaperclipOOMKilled (warning)

The container was restarted after an OOM kill; every run in flight was lost and Paperclip marks
them `interrupted` (`orphaned_running_run`, `process_lost`), which also moves the failure and
recovery alerts. Follow the memory steps above, then check that agents restarted cleanly
(PaperclipPhantomAgentStuck).

### PaperclipMetricsUnavailable (warning, 15 m)

The agent alerts below cannot fire. `kubectl -n paperclip logs deploy/paperclip-exporter`
names the endpoint and HTTP status: 401/403 = the item is missing or the key was revoked
(create a new board key, update the field; the operator refreshes the Secret, then
`kubectl -n paperclip rollout restart deploy/paperclip-exporter` picks it up); connection errors
= Paperclip itself is down (`HomelabProbeFailing` on `paperclip-direct` says the same).

### PaperclipAgentFailureRateHigh (warning, > 20 % of >= 5 runs in 1 h, for 15 m)

```promql
sum by (company, error_code) (paperclip_agent_runs_errors)
```

- `orphaned_running_run` / `process_lost`: the process disappeared (OOM kill, pod restart). Check
  memory and restarts first.
- `acpx_turn_failed`: the model or tool call failed; open the run in the UI and read its log.
- `server_shutdown_interrupted`: a rollout restarted the pod; expected during deploys.

### PaperclipRecoveryRateBreached (warning, 30 m)

Paperclip's own recovery-observability verdict for the current week (recovery actions per run
above `paperclip_recovery_threshold_percent`, 2 % by default). It stays firing for the rest of
the week once the rate is high, so silence it after acting:
`amtool silence add alertname=PaperclipRecoveryRateBreached --duration=24h` ([alerting.md](./alerting.md)).
`GET /api/companies/<id>/recovery-observability` `byCause` names the causes.

### PaperclipPhantomAgentStuck (warning, 15 m)

An agent reports `running` but has no queued or running run, so it never picks up new work. It
usually follows an OOM kill or restart. In the UI open the agent and clear its error or pause and
resume it (`clear_agent_error`, `pause_agent` / `resume_agent`); the gauge drops on the next scrape.

## Related

- [alerting.md](./alerting.md): routing, receivers, silences
- [paperclip-request-path.md](./paperclip-request-path.md): the server does not respond
- `docs/apps/paperclip.md`: the deployment and its secrets
