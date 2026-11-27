{{/* NODE_OPTIONS env entry capping the V8 heap at nodeHeap.percent of resources.limits.memory. */}}
{{- define "paperclip.nodeHeapEnv" -}}
{{- $limit := dig "limits" "memory" "" (.Values.resources | default dict) | toString -}}
{{- $percent := .Values.nodeHeap.percent | default 0 | float64 -}}
{{- $overridden := false -}}
{{- range .Values.extraEnv | default list -}}
{{- if eq .name "NODE_OPTIONS" -}}{{- $overridden = true -}}{{- end -}}
{{- end -}}
{{- if and $limit (gt $percent 0.0) (not $overridden) -}}
{{- if or (gt $percent 100.0) (not (regexMatch "^[0-9]+(\\.[0-9]+)?(Ki|Mi|Gi|Ti|k|M|G|T)?$" $limit)) -}}
{{- fail (printf "paperclip: cannot size NODE_OPTIONS from resources.limits.memory=%q and nodeHeap.percent=%v (need a plain quantity and 0-100)" $limit $percent) -}}
{{- end -}}
{{- $number := regexFind "^[0-9]+(\\.[0-9]+)?" $limit -}}
{{- $unit := trimPrefix $number $limit -}}
{{- $bytesPerUnit := dict "" 1.0 "k" 1e3 "M" 1e6 "G" 1e9 "T" 1e12 "Ki" 1024.0 "Mi" 1048576.0 "Gi" 1073741824.0 "Ti" 1099511627776.0 -}}
{{- $limitMiB := divf (mulf (float64 $number) (get $bytesPerUnit $unit)) 1048576.0 -}}
{{- $heapMiB := floor (divf (mulf $limitMiB $percent) 100.0) | int64 -}}
{{- dict "name" "NODE_OPTIONS" "value" (printf "--max-old-space-size=%d" $heapMiB) | toJson -}}
{{- end -}}
{{- end -}}
