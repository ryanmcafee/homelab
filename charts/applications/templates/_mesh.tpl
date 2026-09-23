{{/*
homelab.meshNamespaces returns the enrolled namespaces
(global.serviceMesh.ambientNamespaces, SERVICE_MESH_AMBIENT_NAMESPACES) as a
comma-joined string; homelab.meshWaypoints those of them that also have a
waypoint (SERVICE_MESH_WAYPOINT_NAMESPACES).
*/}}
{{- define "homelab.meshNamespaces" -}}
{{- splitList "," (nospace (dig "serviceMesh" "ambientNamespaces" "" .Values.global)) | compact | join "," -}}
{{- end -}}
{{- define "homelab.meshWaypoints" -}}
{{- $enrolled := splitList "," (include "homelab.meshNamespaces" .) -}}
{{- $waypoints := list -}}
{{- range splitList "," (nospace (dig "serviceMesh" "waypointNamespaces" "" .Values.global)) | compact -}}
{{- if has . $enrolled }}{{ $waypoints = append $waypoints . }}{{ end -}}
{{- end -}}
{{- join "," $waypoints -}}
{{- end -}}

{{/*
homelab.meshLabels renders the ambient labels (new lines, indented for
metadata.labels) of one Namespace of this chart, and nothing when it is not
enrolled. With a waypoint, every Service in it (ingress traffic from outside
the mesh included) is routed through the waypoint named "waypoint".

Usage, right after the last label of a Namespace:
  {{- include "homelab.meshLabels" (dict "namespace" "media" "root" $) }}
*/}}
{{- define "homelab.meshLabels" -}}
{{- if has .namespace (splitList "," (include "homelab.meshNamespaces" .root)) }}
    istio.io/dataplane-mode: ambient
{{- if has .namespace (splitList "," (include "homelab.meshWaypoints" .root)) }}
    istio.io/use-waypoint: waypoint
    istio.io/ingress-use-waypoint: "true"
{{- end }}
{{- end -}}
{{- end -}}
