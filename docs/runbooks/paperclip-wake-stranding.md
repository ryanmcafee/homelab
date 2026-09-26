# Runbook: Paperclip issues stranded behind an unfinished wake record

Alerts: `PaperclipIssueWakeStranded` (warning / critical), `PaperclipWakeSweepStale` (warning).
Metrics: `paperclip_issues_wake_stranded`, `paperclip_issues_open`, `paperclip_issues_wake_swept`,
`paperclip_wake_sweep_age_seconds`, from the `paperclip-exporter` Deployment
(`charts/paperclip`). Related: [paperclip-agents.md](paperclip-agents.md).

## What is broken

When an agent run dies in a sandbox drop, the run row is terminalized but the
**wake request it had claimed is never finished**. The record keeps
`status: "claimed"` with `finishedAt: null` forever.

The dispatcher will not issue a new wake for an issue that still has an
outstanding claim, so every later wake lands `deferred_issue_execution`. The
issue is permanently undispatchable.

**There is no symptom on the issue row.** A stranded issue reports
`checkoutRunId: null`, `executionRunId: null`, no execution blocker, no active
recovery action, and `status: in_progress`. It looks completely healthy. The
wake ledger is the only place the fault is visible, which is why this alert
exists at all.

This is distinct from `PaperclipPhantomAgentStuck`. That one is about *agents*
stuck in `status: running`; clearing it does not touch the wake ledger. Both
come from the same batch-drop cause and both can be true at once.

## Confirm it

Find the stranded issues — the exporter counts them but does not name them:

```bash
# For each open issue, look for a claimed wake with a null finishedAt.
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/issues/$ISSUE_ID/diagnostics/wakes" | jq '
    .events[] | select(.kind == "wake_request" and .status == "claimed" and .finishedAt == null)'
```

A confirmed stranding looks like this — the run finished, the wake never did:

```
wake_request  reason: issue_blockers_resolved  status: claimed
              runId: 81e77c8a  claimedAt: 2026-09-25T04:09:24.796Z  finishedAt: null
heartbeat_run 81e77c8a  status: "interrupted"  finishedAt: 2026-09-25T04:14:33.607Z
```

Two things separate a real stranding from a long-running job:

- the claim is older than `STALE_WAKE_MINUTES` (default 30), and
- the claiming `runId` is **not** in `GET /api/companies/{id}/live-runs`.

If the claimant is still live, it is a slow run, not a leak. Leave it alone.

## Fix it

**Nothing on the agent side clears this.** Both levers have been tested against
a genuinely stranded issue and both failed:

| Attempt | Result |
|---|---|
| `POST /api/issues/{id}/checkout` | Succeeds, issue returns to `in_progress`, stale record **unchanged**. |
| `POST /api/issues/{id}/release` | Returns 200 and **unassigns the issue**, stale record **unchanged**. |

`release` is actively harmful here: it sets `assigneeAgentId` to null and drops
the issue to `todo`, and an unassigned issue is not even monitor-eligible. If
you have already run it, re-checkout the issue to restore the assignee.

Retiring the `active_run_watchdog` does not help either — that clears
`activeRecoveryAction` and `executionBlocker` on the *issue row*, while the wake
record is a separate object that survives the transition.

The fix is board-side: finish the orphaned wake records, i.e. set `finishedAt`
on every `claimed` wake request whose run is terminal. Escalate to the board
operator with the issue list from the sweep.

## Stop it recurring

The durable fix belongs in Paperclip's recovery backstop: when it terminalizes
an orphaned run it must also finish every wake request that run had claimed, the
same way it should reset `agents.status`. Until that ships, this alert is the
detection and the board is the repair.

## If `PaperclipWakeSweepStale` fires

`paperclip_issues_wake_stranded` is frozen at its last value, so the stranding
alert is reporting stale data rather than current state. A failed sweep
deliberately keeps the previous count instead of reporting zero — reporting zero
would look like a healthy board.

Check the exporter log; it names the failing request:

```bash
kubectl -n paperclip logs deploy/paperclip-exporter | grep 'wake sweep'
```

Common causes: the board API key lost read access to `/issues` (401/403), or the
board grew past `STALE_WAKE_MAX_ISSUES` and sweeps are timing out. If the board
is simply large, raise `exporter.staleWakeMaxIssues` and
`exporter.staleWakeIntervalSeconds` together — the sweep costs one request per
open issue, so raising the cap without lengthening the interval increases
constant load on the Paperclip API.

`paperclip_issues_wake_swept` below `paperclip_issues_open` means the cap is
truncating the sweep, so the stranded count is a floor, not a total.
