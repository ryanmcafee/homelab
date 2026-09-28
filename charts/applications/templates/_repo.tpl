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
