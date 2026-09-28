# The status page back end -> UI contract

Normative for the status page (`ryanmcafee/homelab#41`). Decision record: ADR-050 in
[`docs/project_notes/decisions.md`](../project_notes/decisions.md). The machine-checkable artifact is
[`contracts/status/status-page.v1.yaml`](../../contracts/status/status-page.v1.yaml), checked by
`scripts/status-contract_test.ts` in `task test:scripts`.

Two halves, two owners: the back end reads Prometheus and Alertmanager, the React UI renders what
it returns. This document exists because those halves would otherwise each guess, and a status
page is the worst possible place to find a shape mismatch — the page is what a visitor loads
*during* the incident. [`sdk-boundary.md`](sdk-boundary.md) Sec. 2 requires the contract and its
tests to land before either implementation, so they do; the conformance test against a served
response is named in the YAML's `enforcement` block as specified-not-implemented, because there is
nothing serving yet.

**The one rule everything below follows from: the page never claims more coverage than exists.**
Green must mean "something measured this and it was fine", never "nothing told us otherwise".

## 1. Shape and transport: one polled JSON document

`GET /api/v1/status` returns the whole page — states, uptime, incidents, provenance — as one
`StatusDocument`. Not SSE, and not PromQL from the browser.

Polling wins because the data cannot move faster than Prometheus' evaluation interval, so a stream
delivers nothing sooner while costing a long-lived connection per visitor and a reconnect state
machine in the UI. The server sends `pollAfterSeconds` and the UI honours it rather than hard-coding
a cadence, which keeps load the back end's to control. `ETag` / `If-None-Match` and
`Cache-Control: public, max-age=<pollAfterSeconds>` make the document cacheable at the edge,
because a refresh storm is exactly what an incident produces.

Browser-side PromQL is rejected for the reason raised on the issue and one more: it puts Prometheus
on the public path, and it makes every query string a published part of the cluster's inventory.
See `x-status-page.redaction` — this endpoint is unauthenticated, so anything it echoes is public.
No metric name, label name, label value, fingerprint or internal hostname appears in a response.

One request rather than three also means the UI has **one** loading state, one error state and one
empty state instead of three of each.

**Its own host and its own process, not the platform API.** That surface is authenticated and shaped
for many tenants; this page is deliberately unauthenticated and LAN-scoped. Serving an
unauthenticated route from the authenticated service makes one authorization mistake an API exposure
rather than a status page, and makes `Cache-Control: public` a property of the API host. A separate
process is a separate blast radius, and the redaction rules are far easier to hold when the process
has nothing else to leak. `/api/v1/status` is reserved on the status host: the platform API must not
serve a route at that path, which it will otherwise eventually want for its own health.

## 2. Component granularity: seven names, fixed in the contract

| id | Name | Group |
|---|---|---|
| `ingress` | Ingress & DNS | platform |
| `cluster` | Cluster Platform | platform |
| `data` | Databases & Storage | platform |
| `observability` | Observability | platform |
| `automation` | Automation & Agents | platform |
| `media` | Media | applications |
| `home-automation` | Home Automation | applications |

Each maps to a list of chart templates in `x-status-page.taxonomy`, and the test fails if a mapped
application has no template — a component map that has rotted after a rename is worse than none.
No name is a namespace, a chart or a release.

**These live in the YAML, not the ConfigSet, and that corrects the assumption the issue started
from.** The ConfigSet is a flat map of scalar keys with a description, a default and an optional
enum (`configuration/schema/*.yaml`); it has no array or object type, so a list of components with
ids, display names, groups and app mappings cannot go there without inventing a delimited-string
encoding. Nor should it: "Media" is not personal to one operator, so
[fork-ability](fork-ability.md) does not ask for it to be configurable. What *is* operator-specific
stays in the ConfigSet where it already belongs — the hostname and `page.title`. A fork that adds an
application adds a row to the taxonomy in the same pull request.

## 3. State vocabulary: four states, and `unknown` is the honest one

`operational`, `degraded`, `down`, `unknown`. Every one is derived, and every one carries a
`stateReason` so no tile is unfalsifiable.

| stateReason | Meaning | State |
|---|---|---|
| `alert_firing` | a mapped alert is firing; `critical` -> `down`, `warning` -> `degraded` | `down` / `degraded` |
| `signal_unavailable` | nothing is firing and an upstream this component's state depends on did not answer | `unknown` |
| `no_signal` | nothing is mapped to this component, so nothing could have fired | `unknown` |
| `no_firing_alerts` | alerts are mapped and none are firing | `operational` |

First match wins, in that order, so a component never has two answers.

**`alert_firing` is deliberately first, and the asymmetry is the rule.** A lost signal invalidates a
claim of health; it does not retract a fault the page can still prove. A frozen Alertmanager saying
"nothing is firing" proves nothing, but one saying "something *is* firing" is still evidence of a
fault, and burying it under `unknown` is the same lie pointed the other way — told in the hour it
costs most. `unknown` is the floor for unproven health, never a ceiling on proven fault.

**A tile may never read better than the feed beneath it.** A component named by a firing incident
reads at least that incident's `severityToState`. A red banner over a green tile for the same
service is the error a visitor spots first and forgives last, and it is `operational` requiring a
mapped alert, one level up.

**A component with no SLI reads `unknown` with `no_signal`, not `operational`** — the explicit
second option the issue asked for, and it is enforced, not documented: `operational` with
`coverage.mappedAlertCount == 0` fails the contract test. The UI reads `coverage`, not `state`, to
decide whether to draw a "not measured" badge.

`maintenance` is deliberately **not** a state. It is a nullable overlay on the component, so a
service that is genuinely broken during a declared window still reads `degraded` or `down`.
Replacing the state would hide a real outage behind a calendar entry.

`info` alerts appear in the incident feed and never move a component's state. A page that cries
wolf spends the only thing it has.

`overall.state` is derived from the tiles by `worstFirst: [down, degraded, unknown, operational]`,
so the headline can never disagree with what is beneath it, a coverage gap never masks an outage,
and an all-`unknown` page never reads green. Empty `components` is `unknown`, not `operational`.

### No SLI, no uptime number

`uptime.ratio` is nullable and so is every bucket, with a required `unavailableReason` whenever the
ratio is absent: `no_sli`, `insufficient_history` or `signal_unavailable`. A headline percentage
requires a full window of non-null buckets, so a fork whose SLI is three days old shows the bar it
has and no number rather than "99.9% (of three days)". Nothing is synthesized. `buckets` is either
empty or exactly `windowDays` long — a missing day is a null bucket the UI draws as a gap, never an
absent one that silently shortens the bar.

### When the monitoring stack is the thing that is down

`signals` reports Prometheus and Alertmanager per response, and
`stateDerivation.signalDependencies` says which field each one backs: `state` depends on both,
`uptime` on Prometheus, `incidents` on Alertmanager. `state` depends on Prometheus because
Prometheus evaluates the rules — with it unreachable, an Alertmanager that still answers is serving
a frozen view, and a frozen "nothing is firing" is not evidence of health.

When a dependency is unavailable the affected field says so and the UI raises a banner. Every tile
**with nothing firing against it** reads `unknown`; a tile with a firing alert keeps its real state,
per the asymmetry above. The alternative is the classic status page lie where the page is green
because the thing watching it died.

**An empty `incidents` is only an empty feed while Alertmanager is available.** With that signal
unavailable, `incidents: []` means *not known*, and the UI renders the feed as unavailable rather
than as its empty state — never as "no incidents in the last N days". An empty list is otherwise an
affirmative claim of calm, and this is the one document that must not make that claim on the
strength of an upstream that did not answer.

## 4. Subscriptions: deferred, and not the UI's to invent

Out of v1 on both sides. `features.subscriptions` is `false` for the whole of v1 so the UI ships no
control that posts into nothing.

It is not a rendering decision: it is a PII store and an abuse surface behind an unauthenticated
endpoint, needing double opt-in, unsubscribe tokens, rate limiting and a mail or push provider as a
BYO seam. When it lands the storage and the endpoint are the back end's, the alert-side trigger is
already the back end's, and the form is the UI's. Flipping the flag is additive.

Also deferred, with reasons, in `x-status-page.deferred`: per-incident permalink pages, and SSE if
the poll cadence ever proves too slow.

## 5. What each half owns now

- **Back end** — the PromQL, the alert-to-component mapping, the SLI queries, Alertmanager reads,
  and its own conformance test proving a served response satisfies this schema and the redaction
  rules. None of that appears in this contract.
- **UI** — the component tree, and a designed rendering for all four states, all four state
  reasons, all three uptime-unavailable reasons, the signal-lost banner, the unreadable-feed state,
  the maintenance overlay and the empty-components page. `tests/status/*.json` are the documents it
  renders against; the test fails if a value the UI has to render has no fixture. The hardest of
  them is `prometheus-unavailable-with-firing.json`: a proven outage on one tile, `unknown` on
  another, and no uptime history for either. That is the worst hour the page will ever have, and it
  is the one the design has to survive.

## 6. Versioning

**The path is the major**, per [`sdk-boundary.md`](sdk-boundary.md) Sec. 5: `/api/v1/status`, and a
breaking change is `/api/v2/status` served alongside v1, with `status-page.v2.yaml` alongside v1 as
[`contracts/README.md`](../../contracts/README.md) requires.

`schemaVersion` is an **echo** of that major, not a second axis. It is worth one integer because a
cached or proxied body that self-identifies is useful, but an invariant pins it to the path and the
filename — a `/api/v2/status` whose body still said `1` is a disagreement nothing would otherwise
catch. Additive fields do not change it. A UI reading a version it does not know renders an
out-of-date state rather than guessing.

**A consumer MUST ignore properties it does not recognise.** `additionalProperties: false` in the
contract binds the *producer* and this repository's fixtures — it is what catches a typo'd field
before it ships. A consumer that validates a live response strictly against a bundled copy of the
schema breaks on the first additive field, which would make the additive promise above false against
the very UI this contract was written for. Assume a consumer you cannot see and cannot redeploy: on
this surface that is a stranger's fork running a UI build from six months ago.

That rule is also what keeps a future enterprise `tenant` field a cheap additive change rather than
a breaking one, which is why v1 does not pre-place it. Anything genuinely non-additive is a new
major and an escalation to the Architect before it merges.
