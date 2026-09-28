{{/*
global.repoUrl parsed into <owner>/<repo>, so no value restates the fork's
account next to the URL that already names it. Handles https://host/o/r[.git]
and the scp form git@host:o/r[.git].
*/}}
{{- define "homelab.repo.slug" -}}
{{- $url := .Values.global.repoUrl | trimSuffix "/" | trimSuffix ".git" -}}
{{- $parts := splitList "/" $url -}}
{{- if lt (len $parts) 2 -}}
{{- fail (printf "global.repoUrl %q names no <owner>/<repo>" .Values.global.repoUrl) -}}
{{- end -}}
{{- $owner := last (splitList ":" (index $parts (sub (len $parts) 2))) -}}
{{- $name := index $parts (sub (len $parts) 1) -}}
{{- if or (empty $owner) (empty $name) -}}
{{- fail (printf "global.repoUrl %q names no <owner>/<repo>" .Values.global.repoUrl) -}}
{{- end -}}
{{- printf "%s/%s" $owner $name -}}
{{- end -}}

{{/*
global.repoUrl in the form ArgoCD's repoURL takes. GITOPS_REPO_URL may be
written with or without the .git suffix; every Application this chart renders
must name the repository one way, or ArgoCD sees two repositories.
*/}}
{{- define "homelab.repo.cloneUrl" -}}
{{- printf "%s.git" (.Values.global.repoUrl | trimSuffix "/" | trimSuffix ".git") -}}
{{- end -}}

{{- define "homelab.repo.owner" -}}
{{- first (splitList "/" (include "homelab.repo.slug" .)) -}}
{{- end -}}

{{- define "homelab.repo.name" -}}
{{- last (splitList "/" (include "homelab.repo.slug" .)) -}}
{{- end -}}
