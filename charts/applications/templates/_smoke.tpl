{{/*
homelab.smokeJob renders an ArgoCD PostSync hook Job that curls an in-cluster
HTTP endpoint and fails the sync when the response code is not one of the
expected codes. Redirects are followed (up to 5), so an app whose root
bounces to a landing page still counts as up when the final response matches.
The Job lives in the app's namespace and shares the app's sync wave.

Usage (inside the app's `{{- if .Values.<app>.enabled }}` block, where <app>
is any app key of the chart holding this copy):

  {{ include "homelab.smokeJob" (dict
       "name" "<app>"
       "namespace" .Values.<app>.namespace
       "smoke" .Values.<app>.smoke
       "wave" "13"
       "image" .Values.global.images.curl) }}

Values contract: `smoke: {enabled: bool, url: string, expect: ["200", ...]}`;
expect entries are quoted strings. Renders nothing when `smoke` is nil or
`smoke.enabled` is false.

Helm cannot share named templates across charts, so this file is a
byte-identical copy in charts/addons/templates/_smoke.tpl and
charts/applications/templates/_smoke.tpl. Change both together.
*/}}
{{- define "homelab.smokeJob" -}}
{{- $smoke := .smoke -}}
{{- if $smoke }}
{{- if $smoke.enabled }}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: smoke-{{ .name }}
  namespace: {{ .namespace }}
  labels:
    app.kubernetes.io/name: smoke-{{ .name }}
  annotations:
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation,HookSucceeded
    argocd.argoproj.io/sync-wave: {{ .wave | quote }}
spec:
  backoffLimit: 2
  activeDeadlineSeconds: 600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: smoke-{{ .name }}
    spec:
      restartPolicy: Never
      containers:
        - name: curl
          image: curlimages/curl:{{ .image }}
          env:
            - name: URL
              value: {{ $smoke.url | quote }}
          command: ["sh", "-c"]
          args:
            - |
              code=$(curl -sL --max-redirs 5 -o /dev/null -w '%{http_code}' --retry 30 --retry-delay 10 --retry-all-errors --max-time 20 "$URL")
              echo "smoke {{ .name }}: $URL -> HTTP $code"
              case "$code" in {{ join "|" $smoke.expect }}) exit 0;; *) exit 1;; esac
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 64Mi
          securityContext:
            runAsNonRoot: true
            runAsUser: 100
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            seccompProfile:
              type: RuntimeDefault
{{- end }}
{{- end }}
{{- end }}
