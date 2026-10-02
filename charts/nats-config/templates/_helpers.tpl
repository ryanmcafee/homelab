{{/*
Bytes for an integer Kubernetes storage quantity (8Gi, 512Mi, 2000M, 4096).
A fractional quantity is refused rather than truncated.
*/}}
{{- define "nats-config.quantityBytes" -}}
{{- $quantity := toString . | trim -}}
{{- $units := dict "Ki" 1024 "Mi" 1048576 "Gi" 1073741824 "Ti" 1099511627776 "K" 1000 "M" 1000000 "G" 1000000000 "T" 1000000000000 -}}
{{- $digits := $quantity -}}
{{- $multiplier := 1 -}}
{{- range $suffix, $factor := $units -}}
{{- if hasSuffix $suffix $quantity -}}
{{- $digits = trimSuffix $suffix $quantity -}}
{{- $multiplier = $factor -}}
{{- end -}}
{{- end -}}
{{- if not (regexMatch "^[0-9]+$" $digits) -}}
{{- fail (printf "nats-config: fileStoreSize %q is not an integer storage quantity (expected e.g. 8Gi)" $quantity) -}}
{{- end -}}
{{- mul (atoi $digits) $multiplier -}}
{{- end -}}

{{/*
The ceiling on `maxBytesBudgetFraction`, restating the contract's
`max_bytes_sum_rule`: 75% of the file store is the ceiling, not the target, and
the chart is named there as what refuses to render above it. The fraction is
therefore part of the guard rather than a way out of it: raising it past this
allocates no store, it only stops the sum rule from being applied. (ADR-042)
*/}}
{{- define "nats-config.maxBytesBudgetCeiling" -}}0.75{{- end -}}

{{/*
Refuse to render a stream set that is unbounded, individually or collectively.

`maxBytes` must be set on every stream: JetStream applies `discard` only at
`max_bytes`, `max_msgs` or `max_msgs_per_subject`, so an unlimited stream has a
decorative discard policy and the only thing it can exhaust is the shared file
store — which refuses writes for every stream on the peer with `insufficient
resources (10023)`.

The four limits must also sum at or below `maxBytesBudgetFraction` of the file
store. `maxBytes` bounds a stream against itself and reserves nothing, so limits
summing above the store are individually bounded and collectively unbounded, and
the headroom covers the index and metadata JetStream accounts for alongside
message bytes. (ADR-042)
*/}}
{{- define "nats-config.assertMaxBytesBudget" -}}
{{- if not .Values.fileStoreSize -}}
{{- fail "nats-config: fileStoreSize is unset; the stream budget cannot be checked against a file store of unknown size (ADR-042)" -}}
{{- end -}}
{{- $store := include "nats-config.quantityBytes" .Values.fileStoreSize | int64 -}}
{{- $ceilingText := include "nats-config.maxBytesBudgetCeiling" . -}}
{{- $ceiling := $ceilingText | float64 -}}
{{- if kindIs "invalid" .Values.maxBytesBudgetFraction -}}
{{- fail (printf "nats-config: maxBytesBudgetFraction is unset; the stream budget has no fraction of the file store to check against (expected a positive decimal at or below %s, the ADR-042 ceiling)" $ceilingText) -}}
{{- end -}}
{{- $fractionText := printf "%v" .Values.maxBytesBudgetFraction -}}
{{- if not (regexMatch "^([0-9]+(\\.[0-9]+)?|\\.[0-9]+)$" $fractionText) -}}
{{- fail (printf "nats-config: maxBytesBudgetFraction %q is not a finite positive decimal (expected e.g. %s, the ADR-042 ceiling); a negative, non-numeric, NaN or Inf fraction makes the budget unmeaningful rather than large" $fractionText $ceilingText) -}}
{{- end -}}
{{- $fraction := $fractionText | float64 -}}
{{- if le $fraction (float64 0) -}}
{{- fail (printf "nats-config: maxBytesBudgetFraction %s budgets no bytes at all; it must be greater than 0 and at or below %s (ADR-042)" $fractionText $ceilingText) -}}
{{- end -}}
{{- if gt $fraction $ceiling -}}
{{- fail (printf "nats-config: maxBytesBudgetFraction %s exceeds the ADR-042 ceiling of %s; %s of the JetStream file store is the ceiling, not the target, and raising the fraction creates no store; lower a stream's maxBytes or grow nats.jetstream.storage.size (ADR-042 max_bytes_sum_rule)" $fractionText $ceilingText $ceilingText) -}}
{{- end -}}
{{- $budget := mulf (float64 $store) $fraction -}}
{{- $total := int64 0 -}}
{{- range $stream := .Values.streams -}}
{{- $limit := get ($.Values.maxBytes | default dict) $stream.name | int64 -}}
{{- if le $limit (int64 0) -}}
{{- fail (printf "nats-config: maxBytes.%s must be a positive byte count; unset or -1 leaves the stream unbounded, which can exhaust the shared JetStream file store and refuse writes for every stream on the peer (ADR-042)" $stream.name) -}}
{{- end -}}
{{- $total = add $total $limit -}}
{{- end -}}
{{- if gt (float64 $total) $budget -}}
{{- fail (printf "nats-config: stream maxBytes total %d bytes exceeds the %.0f-byte budget (%v of the %d-byte JetStream file store); lower a stream's maxBytes or grow nats.jetstream.storage.size (ADR-042 max_bytes_sum_rule)" $total $budget $fraction $store) -}}
{{- end -}}
{{- end -}}
