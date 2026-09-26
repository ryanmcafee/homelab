{{/*
Expand the name of the chart.
*/}}
{{- define "addons.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "addons.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "addons.labels" -}}
helm.sh/chart: {{ include "addons.chart" . }}
{{ include "addons.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "addons.selectorLabels" -}}
app.kubernetes.io/name: {{ include "addons.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Generate a config hash for an Application to force re-sync when values change.
Usage: {{ include "addons.configHash" (dict "values" .Values.myApp) }}
*/}}
{{- define "addons.configHash" -}}
{{- .values | toJson | sha256sum | trunc 8 }}
{{- end }}

{{/*
Gateway API parentRefs (a YAML list) to one listener of global.gateway.<gateway>
(internal or external); sectionName defaults to https, the http listener only redirects.
Usage: {{ include "addons.gatewayParentRefs" (dict "root" . "gateway" "internal") }}
*/}}
{{- define "addons.gatewayParentRefs" -}}
- group: gateway.networking.k8s.io
  kind: Gateway
  name: {{ required (printf "global.gateway.%s is required" .gateway) (index .root.Values.global.gateway .gateway) }}
  namespace: {{ required "global.gateway.namespace is required" .root.Values.global.gateway.namespace }}
  sectionName: {{ .sectionName | default "https" }}
{{- end }}
