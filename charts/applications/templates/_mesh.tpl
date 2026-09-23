{{/*
homelab.meshLabels renders the Istio ambient enrollment label (a new line,
indented for metadata.labels) for a Namespace of this chart when
global.serviceMesh.ambientNamespaces (comma-separated,
SERVICE_MESH_AMBIENT_NAMESPACES) lists it, and nothing otherwise.

Usage, right after the last label of a Namespace:
  {{- include "homelab.meshLabels" (dict "namespace" "media" "root" $) }}
*/}}
{{- define "homelab.meshLabels" -}}
{{- $mesh := dig "serviceMesh" "ambientNamespaces" "" .root.Values.global -}}
{{- $enrolled := splitList "," (nospace $mesh) | compact -}}
{{- if has .namespace $enrolled }}
    istio.io/dataplane-mode: ambient
{{- end -}}
{{- end -}}
