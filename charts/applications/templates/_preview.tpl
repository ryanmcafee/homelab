{{/*
Per-PR preview mode (issue #261 item 16, docs/runbooks/previews.md).

The `previews` ApplicationSet in charts/gitops generates one Application
`preview-pr<N>` per pull request labelled `preview`. It renders this chart
through the CMP with PREVIEW_PR=<N> and PREVIEW_APPS=<apps from the PR's
preview:<app> labels>, which the plugin passes as --set-string
global.preview.pr / global.preview.apps. With global.preview.pr set:

  - only the selected apps render (enabled, in apps or else defaultApps, and in
    allowedApps), as Application <app>-pr<N> in namespace preview-<N>
    (ArgoCD "apps in any namespace"), project `previews`, destination
    preview-<N>;
  - no *-config children, no repository Secrets, no prod namespaces, and never
    plex, renovate, duckdns, homeassistant or mosquitto;
  - namespaces.yaml renders Namespace preview-<N> + ResourceQuota + LimitRange;
  - route hostnames <x>.<domain> become <x>-pr<N>.<domain>;
  - every TrueCharts persistence entry (config PVC and NFS media mounts) becomes
    an emptyDir: a preview claims no volume and leaves nothing behind;
  - smoke Jobs run in preview-<N> and curl <svc>.preview-<N>.svc.

With global.preview.pr empty every helper returns exactly what the template
rendered before preview mode existed, so the normal render is byte-identical.
*/}}

{{/* homelab.preview.enabled: "true" in preview mode, "" otherwise. Takes the root context. */}}
{{- define "homelab.preview.enabled" -}}
{{- if ne (toString (dig "preview" "pr" "" .Values.global)) "" -}}
true
{{- end -}}
{{- end -}}

{{/* homelab.preview.pr: the validated PR number. Takes the root context. */}}
{{- define "homelab.preview.pr" -}}
{{- $pr := toString (dig "preview" "pr" "" .Values.global) -}}
{{- if not (regexMatch "^[0-9]+$" $pr) -}}
{{- fail (printf "global.preview.pr must be a pull request number (digits only), got %q" $pr) -}}
{{- end -}}
{{- $pr -}}
{{- end -}}

{{/* homelab.preview.namespace: preview-<pr>. Takes the root context. */}}
{{- define "homelab.preview.namespace" -}}
preview-{{ include "homelab.preview.pr" . }}
{{- end -}}

{{/*
homelab.preview.apps: the apps a preview renders, one per line: the
comma-separated global.preview.apps, or defaultApps when it is empty. An app
outside allowedApps fails the render, so a mistyped preview:<app> label is an
error in ArgoCD instead of a silently empty preview. Takes the root context.
*/}}
{{- define "homelab.preview.apps" -}}
{{- $p := .Values.global.preview -}}
{{- $apps := list -}}
{{- range splitList "," (toString $p.apps) -}}
{{- $a := trim . -}}
{{- if $a -}}
{{- $apps = append $apps $a -}}
{{- end -}}
{{- end -}}
{{- if not $apps -}}
{{- $apps = $p.defaultApps -}}
{{- end -}}
{{- range $apps -}}
{{- if not (has . $p.allowedApps) -}}
{{- fail (printf "preview app %q is not in global.preview.allowedApps (%s)" . (join ", " $p.allowedApps)) -}}
{{- end -}}
{{- end -}}
{{- join "\n" $apps -}}
{{- end -}}

{{/*
homelab.preview.appEnabled: "true" when the app renders. Normal mode:
.Values.<app>.enabled. Preview mode: enabled, selected and allowed.
Usage: include "homelab.preview.appEnabled" (dict "root" . "app" "sonarr")
*/}}
{{- define "homelab.preview.appEnabled" -}}
{{- $v := index .root.Values .app -}}
{{- if $v.enabled -}}
{{- if not (include "homelab.preview.enabled" .root) -}}
true
{{- else if has .app (splitList "\n" (include "homelab.preview.apps" .root)) -}}
true
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
homelab.preview.appName: <app>, or <app>-pr<pr> in preview mode.
Usage: include "homelab.preview.appName" (dict "root" . "app" "sonarr")
*/}}
{{- define "homelab.preview.appName" -}}
{{- if include "homelab.preview.enabled" .root -}}
{{ .app }}-pr{{ include "homelab.preview.pr" .root }}
{{- else -}}
{{ .app }}
{{- end -}}
{{- end -}}

{{/* homelab.preview.appNamespace: the Application's own namespace (argocd, or preview-<pr>). Takes the root context. */}}
{{- define "homelab.preview.appNamespace" -}}
{{- if include "homelab.preview.enabled" . -}}
{{ include "homelab.preview.namespace" . }}
{{- else -}}
argocd
{{- end -}}
{{- end -}}

{{/*
homelab.preview.destNamespace: the Application's destination namespace.
Usage: include "homelab.preview.destNamespace" (dict "root" . "namespace" .Values.sonarr.namespace)
*/}}
{{- define "homelab.preview.destNamespace" -}}
{{- if include "homelab.preview.enabled" .root -}}
{{ include "homelab.preview.namespace" .root }}
{{- else -}}
{{ .namespace }}
{{- end -}}
{{- end -}}

{{/* homelab.preview.project: default, or previews in preview mode. Takes the root context. */}}
{{- define "homelab.preview.project" -}}
{{- if include "homelab.preview.enabled" . -}}
previews
{{- else -}}
default
{{- end -}}
{{- end -}}

{{/*
homelab.preview.hosts: rewrites every <label>.<domain> in text to
<label>-pr<pr>.<domain> in preview mode (route hostnames and the external-dns
hostname annotation); text is returned unchanged otherwise.
Usage: include "homelab.preview.hosts" (dict "root" . "text" (toYaml .Values.sonarr.route))
*/}}
{{- define "homelab.preview.hosts" -}}
{{- if include "homelab.preview.enabled" .root -}}
{{- $domain := regexQuoteMeta .root.Values.global.domain -}}
{{- $suffix := printf "-pr%s.%s" (include "homelab.preview.pr" .root) .root.Values.global.domain -}}
{{- regexReplaceAll (printf "([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\\.%s\\b" $domain) .text (printf "${1}%s" $suffix) -}}
{{- else -}}
{{- .text -}}
{{- end -}}
{{- end -}}

{{/*
homelab.preview.persistence: the TrueCharts persistence block as YAML. In
preview mode every volume-backed entry becomes an emptyDir at the same
mountPath: a config PVC (type pvc or unset, with or without existingClaim —
the static PV/PVC belongs to production) and every NFS media mount. Only
enabled and mountPath survive, so no claim, storage class or size reaches the
chart and a preview never creates a PersistentVolumeClaim: its data lives as
long as the pod and nothing is left behind on teardown. Entries of any other
type pass through unchanged. Normal mode: toYaml of the input.
Usage: include "homelab.preview.persistence" (dict "root" . "persistence" .Values.sonarr.persistence)
*/}}
{{- define "homelab.preview.persistence" -}}
{{- if include "homelab.preview.enabled" .root -}}
{{- $out := dict -}}
{{- range $name, $v := .persistence -}}
{{- $type := toString (default "pvc" $v.type) -}}
{{- if or (eq $type "pvc") (eq $type "nfs") (hasKey $v "existingClaim") (hasKey $v "server") -}}
{{- $e := dict "type" "emptyDir" -}}
{{- if hasKey $v "enabled" -}}
{{- $_ := set $e "enabled" $v.enabled -}}
{{- end -}}
{{- if hasKey $v "mountPath" -}}
{{- $_ := set $e "mountPath" $v.mountPath -}}
{{- end -}}
{{- $_ := set $out $name $e -}}
{{- else -}}
{{- $_ := set $out $name $v -}}
{{- end -}}
{{- end -}}
{{- toYaml $out -}}
{{- else -}}
{{- toYaml .persistence -}}
{{- end -}}
{{- end -}}

{{/*
homelab.preview.smoke: the smoke values as YAML (pipe through fromYaml). In
preview mode the in-cluster URL .<namespace>.svc becomes .preview-<pr>.svc.
Usage: include "homelab.preview.smoke" (dict "root" . "smoke" .Values.sonarr.smoke "namespace" .Values.sonarr.namespace) | fromYaml
*/}}
{{- define "homelab.preview.smoke" -}}
{{- if and .smoke (include "homelab.preview.enabled" .root) -}}
{{- $url := replace (printf ".%s.svc" .namespace) (printf ".%s.svc" (include "homelab.preview.namespace" .root)) (toString .smoke.url) -}}
{{- toYaml (merge (dict "url" $url) .smoke) -}}
{{- else -}}
{{- toYaml .smoke -}}
{{- end -}}
{{- end -}}
