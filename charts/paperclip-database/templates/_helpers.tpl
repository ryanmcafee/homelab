{{- define "paperclip-database.workflowPod" -}}
{{- $b := .backup -}}
podMetadata:
  labels:
    app.kubernetes.io/name: paperclip-db-backup
    app.kubernetes.io/instance: {{ .root.Values.name }}
    {{- if .root.Values.ambientOptOut }}
    istio.io/dataplane-mode: none
    {{- end }}
securityContext:
  runAsNonRoot: true
  runAsUser: 26
  runAsGroup: 26
  fsGroup: 26
  fsGroupChangePolicy: OnRootMismatch
  seccompProfile:
    type: RuntimeDefault
volumes:
  - name: backups
    persistentVolumeClaim:
      claimName: {{ .root.Values.name }}-backups
  - name: tmp
    emptyDir: {}
{{- end -}}

{{- define "paperclip-database.pgContainer" -}}
script:
  image: {{ .backup.image | default .root.Values.imageName }}
  command: [/bin/sh]
  volumeMounts:
    - name: backups
      mountPath: /backups
    - name: tmp
      mountPath: /tmp
  resources:
    {{- toYaml .backup.resources | nindent 4 }}
  securityContext:
    {{- toYaml .podSecurity | nindent 4 }}
{{- end -}}
