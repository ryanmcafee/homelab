{{- define "codesearch-dependencies.labels" -}}
app.kubernetes.io/name: codesearch
app.kubernetes.io/component: backup
app.kubernetes.io/part-of: homelab
{{- end }}

{{- define "codesearch-dependencies.restricted" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{- define "codesearch-dependencies.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
fsGroupChangePolicy: OnRootMismatch
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/*
The codesearch volume is ReadWriteOnce: pods that mount it must run on the
node of the codesearch pod.
*/}}
{{- define "codesearch-dependencies.besideServer" -}}
podAffinity:
  requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          {{- toYaml .Values.server.podLabels | nindent 10 }}
      topologyKey: kubernetes.io/hostname
{{- end }}

{{- define "codesearch-dependencies.s3" -}}
endpoint: {{ required "workflows.store.endpoint is required" .Values.workflows.store.endpoint }}
bucket: {{ .Values.workflows.store.bucket }}
insecure: true
accessKeySecret:
  name: {{ .Values.workflows.artifacts.secretName }}
  key: accessKey
secretKeySecret:
  name: {{ .Values.workflows.artifacts.secretName }}
  key: secretKey
{{- end }}
