{{/*
The ADR-043 static backend: the declaration in contracts/events/bus-principals.v1.yaml, expanded
by scripts/render-nats-accounts.ts into files/nats-accounts.gen.yaml, rendered here into the NATS
server's `accounts {}` block through the upstream chart's `config.merge`.

Identity is operator-supplied and permissions are contract. `nats.principalNkeys` carries PUBLIC
user nkeys only, as `<principal>=<public key>` pairs; the private seeds reach the workloads as
Secrets through External Secrets and never this path.

An account block with no users refuses every client, NACK included, so nothing renders until the
operator supplies at least one key. The flip from anonymous to authenticated is therefore one
configuration value, and it cannot half-land.
*/}}

{{/* principal name -> public nkey, parsed from the operator's comma-separated pairs. */}}
{{- define "addons.natsPrincipalNkeys" -}}
{{- $keys := dict -}}
{{- range $pair := splitList "," (default "" .Values.nats.principalNkeys) -}}
{{- $pair = trim $pair -}}
{{- if $pair -}}
{{- $parts := splitn "=" 2 $pair -}}
{{- if not $parts._1 -}}
{{- fail (printf "nats.principalNkeys entry %q is not a <principal>=<public nkey> pair" $pair) -}}
{{- end -}}
{{- $name := trim $parts._0 -}}
{{/*
One key per principal. The map cannot hold two, so a second pair for the same name would
silently replace the first -- which is exactly what an operator staging a rotation would try,
and it would leave every client still holding the old seed refused with no error anywhere but
at connect time. Rotation is therefore a bounded maintenance interruption, not an overlap:
docs/runbooks/nats-credentials.md.
*/}}
{{- if hasKey $keys $name -}}
{{- fail (printf "nats.principalNkeys names %s twice; this renderer accepts one key per principal, so a second pair replaces the first instead of adding an accepted key -- rotate through the documented maintenance interruption rather than a staged overlap" $name) -}}
{{- end -}}
{{- $_ := set $keys $name (trim $parts._1) -}}
{{- end -}}
{{- end -}}
{{- $keys | toYaml -}}
{{- end -}}

{{/*
The auth-callout backend's bound, enforced before the backend exists.

v2.15.0 delegates EVERY account to the callout service when `allowed_accounts` is left empty,
so the secure value is not the default and an unbounded callout reaches `$SYS` as readily as a
tenant. Recording the rule only once the backend ships means the first configuration that could
get it wrong is also the first one nothing checks.

The callout itself is refused: rendering an authentication path this repository has not run
against a server would widen a trust boundary on inference. The bound is checked first, so a
`nats.authCallout` that would have been unbounded is named as unbounded rather than as absent.
*/}}
{{- define "addons.natsAssertCalloutBounded" -}}
{{- with .Values.nats.authCallout -}}
{{- $allowed := .allowedAccounts | default list -}}
{{- if not $allowed -}}
{{- fail "nats.authCallout.allowedAccounts is empty; v2.15.0 delegates every account to the callout service when allowed_accounts is unset, so an empty list is the widest possible setting rather than the narrowest" -}}
{{- end -}}
{{- if has "$SYS" $allowed -}}
{{- fail "nats.authCallout.allowedAccounts names $SYS; a callout service that can mint system-account users has cross-account reach over every tenant's streams (ADR-043 D4)" -}}
{{- end -}}
{{- fail "nats.authCallout is set, but only the static backend ships; the callout backend needs an Architect review of the trust boundary before this chart renders an authentication path it has not run against a server" -}}
{{- end -}}
{{- end -}}

{{/*
A public key the server accepts is only usable while the matching seed reaches its client, so the
two land in one change or neither does. Exactly one seed source is declared per surface: a
1Password vault path (homelab, through the operator) or `bootstrapSeeded` (Kind, where
scripts/localdev-kind.ts mints the seeds into Secrets because there is no vault). With neither,
rendering the accounts block would leave every client refused with no credential to present --
an outage, and never a fallback to anonymous access.

`system` is refused in `principalNkeys`: `$SYS` has its own field, and a system key in the tenant
map would render the break-glass credential as a tenant user holding tenant grants (ADR-043 D4).
*/}}
{{- define "addons.natsAssertSeedSource" -}}
{{- $nkeys := fromYaml (include "addons.natsPrincipalNkeys" .) -}}
{{- if hasKey $nkeys "system" -}}
{{- fail "nats.principalNkeys names `system`; the break-glass $SYS user belongs in nats.systemAccountNkey, and naming it here renders it as a tenant user holding tenant grants (ADR-043 D4)" -}}
{{- end -}}
{{- if $nkeys -}}
{{/*
Two principals sharing a public key are one identity holding the union of two permission sets,
which is the account boundary failing in the place a values diff reads as correct.
*/}}
{{- $seen := dict -}}
{{- range $principal, $key := $nkeys -}}
{{- if hasKey $seen $key -}}
{{- fail (printf "nats.principalNkeys gives %s and %s the same public key, so they authenticate as one identity holding the union of both permission sets" $principal (get $seen $key)) -}}
{{- end -}}
{{- $_ := set $seen $key $principal -}}
{{- if hasPrefix "S" $key -}}
{{- fail (printf "the public key for %s starts \"S\", which is a SEED; nats.principalNkeys is public configuration and reaches Git, rendered manifests and CI logs" $principal) -}}
{{- end -}}
{{- end -}}
{{- if hasPrefix "S" (default "" .Values.nats.systemAccountNkey) -}}
{{- fail "nats.systemAccountNkey starts \"S\", which is a SEED; the server holds only the PUBLIC half of the break-glass key" -}}
{{- end -}}
{{- $credentials := .Values.nats.credentials -}}
{{- if and (not $credentials.onePasswordVaultPath) (not $credentials.bootstrapSeeded) -}}
{{- fail "nats.principalNkeys is set but no seed source is declared; set nats.credentials.onePasswordVaultPath so the 1Password operator delivers each `nats-principal-<principal>` Secret, or nats.credentials.bootstrapSeeded=true on a surface whose bootstrap mints them -- a public key with no matching seed refuses its client rather than falling back to anonymous access" -}}
{{- end -}}
{{- if and $credentials.onePasswordVaultPath $credentials.bootstrapSeeded -}}
{{- fail "nats.credentials sets both onePasswordVaultPath and bootstrapSeeded; two seed sources for one principal means the Secret in the cluster and the item in the vault can disagree, and which key a client presents then depends on apply order" -}}
{{- end -}}
{{- range $principal, $namespaces := $credentials.extraNamespaces -}}
{{- if not (hasKey $nkeys $principal) -}}
{{- fail (printf "nats.credentials.extraNamespaces names %s, which nats.principalNkeys does not; replicating a seed for a principal the server does not accept spreads a credential that authenticates nothing" $principal) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Substitutes the tenant token into a grant list. The renderer is the only thing that does it. */}}
{{- define "addons.natsTenantSubjects" -}}
{{- $tenant := .tenant -}}
{{- $subjects := list -}}
{{- range $subject := .subjects -}}
{{- $subjects = append $subjects (replace "<tenant>" $tenant $subject) -}}
{{- end -}}
{{- $subjects | toJson -}}
{{- end -}}

{{/* The account name for a tenant token: upper-cased, `-` mapped to `_` (ADR-043 D12). */}}
{{- define "addons.natsAccountName" -}}
{{- $contract := .contract -}}
{{- replace "<TENANT>" (upper (replace "-" "_" .tenant)) $contract.accountNameTemplate -}}
{{- end -}}

{{/*
The `config.merge` payload. Emits nothing when no key is supplied, which is what keeps a rendered
account block and the credentials that make it usable in the same change.
*/}}
{{- define "addons.natsAccountsMerge" -}}
{{- include "addons.natsAssertCalloutBounded" . -}}
{{- include "addons.natsAssertSeedSource" . -}}
{{- $nkeys := fromYaml (include "addons.natsPrincipalNkeys" .) -}}
{{- if $nkeys -}}
{{- $contract := .Files.Get "files/nats-accounts.gen.yaml" | fromYaml -}}
{{- if not $contract.principals -}}
{{- fail "files/nats-accounts.gen.yaml has no principals; regenerate it with `bun scripts/render-nats-accounts.ts`" -}}
{{- end -}}
{{- $tenant := required "nats.tenant is required once nats.principalNkeys is set" .Values.nats.tenant -}}
{{- $limits := .Values.nats.accountLimits -}}
{{- range $limit := $contract.jetstreamLimitsRequired -}}
{{- if not (hasKey $limits $limit) -}}
{{- fail (printf "nats.accountLimits.%s is unset; the four per-account JetStream limits are mandatory (ADR-043 D8), and without them one tenant's streams exhaust the shared file store" $limit) -}}
{{- end -}}
{{- end -}}
{{/*
An account limit above the server's matching store is fatal for EVERY account, not only the
greedy one: v2.15.0 refuses to enable JetStream at all and the pod crash-loops. This chart
configures the file store and never the memory store, so any non-zero `max_memory` is measured
against `max_memory_store: 0` and exits with `insufficient memory resources (10028)`.
*/}}
{{- if ne (toString $limits.max_memory) "0" -}}
{{- fail (printf "nats.accountLimits.max_memory is %v, but this chart enables only the JetStream file store, so the server offers no memory store and refuses to start every account with `insufficient memory resources (10028)`; 0 is the declared limit for a file-store-only bus" $limits.max_memory) -}}
{{- end -}}
{{- $accountName := include "addons.natsAccountName" (dict "tenant" $tenant "contract" $contract) -}}
{{- $users := list -}}
{{- range $principal := $contract.principals -}}
{{- $nkey := get $nkeys $principal.name -}}
{{- if $nkey -}}
{{- if $principal.pending -}}
{{- fail (printf "nats.principalNkeys names %s, whose durable nothing creates yet (%s); a credential for a component that does not exist is a key with no owner" $principal.name $principal.pending) -}}
{{- end -}}
{{- $users = append $users (dict
  "nkey" $nkey
  "permissions" (dict
    "publish" (dict
      "allow" (include "addons.natsTenantSubjects" (dict "tenant" $tenant "subjects" $principal.publish.allow) | fromJsonArray)
      "deny" $principal.publish.deny)
    "subscribe" (dict
      "allow" (include "addons.natsTenantSubjects" (dict "tenant" $tenant "subjects" $principal.subscribe.allow) | fromJsonArray)))) -}}
{{- end -}}
{{- end -}}
{{- if not $users -}}
{{- fail (printf "nats.principalNkeys names no principal in files/nats-accounts.gen.yaml; an account with no users refuses every client") -}}
{{- end -}}
{{- $accounts := dict $accountName (dict "jetstream" $limits "users" $users) -}}
{{/*
`$SYS` is declared even when nothing holds it. v2.15.0 resolves `system_account` against the
accounts it was given and exits with `error resolving system account: account missing` when the
name is absent -- and `nats-server -t` does NOT catch that, so the failure is a crash loop on
sync rather than a rejected config. An empty user list is `system_account_principals: []`
expressed in the server's own terms: the account exists, and no credential reaches it.
*/}}
{{- $systemUsers := list -}}
{{- if .Values.nats.systemAccountNkey -}}
{{- $systemUsers = list (dict "nkey" .Values.nats.systemAccountNkey) -}}
{{- end -}}
{{- $_ := set $accounts $contract.systemAccount (dict "users" $systemUsers) -}}
{{- dict "system_account" $contract.systemAccount "accounts" $accounts | toYaml -}}
{{- end -}}
{{- end -}}
