{{- define "triage-agent.labels" -}}
app.kubernetes.io/name: {{ .Values.name }}
app.kubernetes.io/part-of: homelab
{{- end }}

{{- define "triage-agent.selector" -}}
app.kubernetes.io/name: {{ .Values.name }}
{{- end }}
