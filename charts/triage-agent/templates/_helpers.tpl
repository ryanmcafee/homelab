{{- define "triage-agent.labels" -}}
app.kubernetes.io/name: {{ .Values.name }}
app.kubernetes.io/part-of: homelab
{{- end }}

{{- define "triage-agent.selector" -}}
app.kubernetes.io/name: {{ .Values.name }}
app.kubernetes.io/component: intake
{{- end }}

{{- define "triage-agent.workflowServiceAccount" -}}
{{ .Values.name }}-workflow
{{- end }}

{{- define "triage-agent.restricted" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}
