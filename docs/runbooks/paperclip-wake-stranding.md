# Runbook: Paperclip issues stranded behind an unfinished wake record

Alerts: `PaperclipIssueWakeStranded` (warning / critical), `PaperclipWakeSweepStale` (warning).
Metrics: `paperclip_issues_wake_stranded`, `paperclip_issues_open`, `paperclip_issues_wake_swept`,
`paperclip_wake_sweep_age_seconds`, from the `paperclip-exporter` Deployment
(`charts/paperclip`). Related: [paperclip-agents.md](paperclip-agents.md).

## What is broken

When an agent run dies in a sandbox drop, the run row is terminalized but the
**wake request it had claimed is never finished**. The record keeps
`status: "claimed"` with `finishedAt: null` forever.

While the drop's execution hold is in force, every later wake for that issue
lands `deferred_issue_execution` and the issue takes no new work.

**The dirty record marks the drop; it is not itself the hold.** Measured on the
MCAA board on 2026-09-27: five issues dispatched and ran normally with a
71-hour-old `claimed` / `finishedAt: null` record untouched, and one reached
`done` still carrying one. Nothing readable — not the ledger row, not
`execution.phase`, not `permittedActions` — tells you whether an issue will
dispatch. Only minting a wake does. So treat this alert as "a drop hit these
issues, check them", never as "these issues are dead".

**Why they still need a nudge, then.** A wake that lands
`deferred_issue_execution` is **spent** — it is not queued behind anything and
is never retried. So an issue whose newest wake deferred during the drop stays
idle even after the hold lifts, not because anything is blocking it but because
nothing has asked for it since. That is the whole reason the probe below works,
and it is why an issue still receiving comments or events recovers on its own
while a quiet one does not.

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

**Probe first: post an ordinary comment on the issue from any account that is
not its assignee.** That mints an `issue_commented` wake, and it is both the
test and, usually, the whole repair. Then re-read the ledger:

| Newest wake after the comment | Meaning |
|---|---|
| `queued` or `claimed`, **with a run id** | Dispatch works. Nothing else to do. |
| `deferred_issue_execution`, **no run id** | Genuinely held. Escalate (below). |

On 2026-09-27 this restored four of four issues that three separate sweeps had
written off as permanently undispatchable. A fresh wake also **drains** that
issue's parked `deferred_issue_execution` rows — they flip to `coalesced` and
are absorbed into the new run — so the backlog of swallowed wakes is delivered
too.

Two things to get right:

- **The comment must not come from the assignee.** An assignee commenting on
  their own issue mints no wake at all, so the probe silently proves nothing.
- **Do not stop at `queued`.** Per-agent serialization means a queued wake can
  wait minutes while its owner finishes a run on another issue. Wait for a run
  id and then for the run to start.

Two levers that do **not** work, both tested against a genuinely stranded issue:

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

If a probe still defers, escalate to the board operator with the issue list and
the probe result. Note that resolving the issue's recovery actions does not
clear the hold on its own, because the blocker predicate reads the action's
evidence and ignores its status (upstream `paperclipai/paperclip#14082`);
cancellation is what released it on 2026-09-27.

## Stop it recurring

The durable fix belongs in Paperclip's recovery backstop: when it terminalizes
an orphaned run it must also finish every wake request that run had claimed, the
same way it should reset `agents.status`. Run finalization writes the terminal
run and the wake receipt separately, so an interruption between the two leaks
the record (upstream `paperclipai/paperclip#13607`). Until that ships, the
records accumulate; they are inert once the hold lifts, but they are the only
signal this alert has, so a leak left unrepaired degrades the detector over time.

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
