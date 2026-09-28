{{/*
Bytes for an integer Kubernetes storage quantity (8Gi, 512Mi, 2000M, 4096).
A fractional quantity is refused rather than truncated.

A plain byte count is taken first, because a value that large arrives here as a
float and renders back as 6.442450944e+09, which no suffix parser matches.
*/}}
{{- define "argo-events-config.quantityBytes" -}}
{{- $numeric := int64 . -}}
{{- if gt $numeric (int64 0) -}}
{{- $numeric -}}
{{- else -}}
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
{{- fail (printf "argo-events-config: %q is not an integer storage quantity (expected e.g. 512Mi)" $quantity) -}}
{{- end -}}
{{- mul (atoi $digits) $multiplier -}}
{{- end -}}
{{- end -}}

{{/*
Refuse to render a trigger bus whose byte ceiling it cannot honour.

Argo Events creates exactly one stream on this bus -- `default`, subjects
`default.*.*` (pkg/eventbus/jetstream/base/jetstream.go) -- so `maxBytes` is the
whole message budget and is checked against the PVC alone, with no sum over
streams. The headroom covers the index and metadata JetStream accounts for
alongside message bytes; the fraction matches ADR-042's rule for the platform
bus so the two buses are sized by the same reasoning.
*/}}
{{- define "argo-events-config.assertMaxBytesBudget" -}}
{{- $store := include "argo-events-config.quantityBytes" .Values.storage.size | int64 -}}
{{- $limit := include "argo-events-config.quantityBytes" .Values.maxBytes | int64 -}}
{{- $fraction := .Values.maxBytesBudgetFraction | float64 -}}
{{- $budget := mulf (float64 $store) $fraction -}}
{{- if le $limit (int64 0) -}}
{{- fail "argo-events-config: maxBytes must be a positive byte count; an unbounded trigger bus fills its PVC and then refuses every publish" -}}
{{- end -}}
{{- if gt (float64 $limit) $budget -}}
{{- fail (printf "argo-events-config: maxBytes %d exceeds the %.0f-byte budget (%v of the %d-byte PVC); lower maxBytes or grow storage.size" $limit $budget $fraction $store) -}}
{{- end -}}
{{- end -}}
