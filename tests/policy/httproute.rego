package homelab.httproute

import data.homelab.lib

# The Istio comparison gateways serve exactly one route, echo, so both
# implementations answer the same request.
istio_namespace := "istio-ingress"

istio_gateways := {"istio-internal", "istio-external"}

istio_route := "echo"

envoy_gateways := {lib.gateway_internal, lib.gateway_external}

# The http listener of every Gateway only redirects to https.
redirect_listener := "http"

route_listener := "https"

default is_redirect_only(route) := false

is_redirect_only(route) if {
	rules := object.get(object.get(route, "spec", {}), "rules", [])
	count(rules) > 0
	every rule in rules {
		count(object.get(rule, "backendRefs", [])) == 0
	}
}

is_gateway_ref(ref) if {
	object.get(ref, "group", "gateway.networking.k8s.io") == "gateway.networking.k8s.io"
	object.get(ref, "kind", "Gateway") == "Gateway"
}

# valid_parent(ref, ns, route_name, redirect) holds when ref names an allowed
# Gateway listener; ns is the namespace ref resolves to.
valid_parent(ref, ns, _, _) if {
	is_gateway_ref(ref)
	ns == lib.gateway_namespace
	ref.name in envoy_gateways
	object.get(ref, "sectionName", "") == route_listener
}

valid_parent(ref, ns, route_name, _) if {
	is_gateway_ref(ref)
	ns == istio_namespace
	ref.name in istio_gateways
	object.get(ref, "sectionName", "") == route_listener
	route_name == istio_route
}

valid_parent(ref, _, _, redirect) if {
	redirect
	is_gateway_ref(ref)
	ref.name in (envoy_gateways | istio_gateways)
	object.get(ref, "sectionName", "") == redirect_listener
}

want := sprintf("Gateway %s or %s in namespace %s with sectionName %q", [lib.gateway_internal, lib.gateway_external, lib.gateway_namespace, route_listener])

# httproute-parent: a route attached to anything else is served by no
# listener (or only by the http listener, which redirects every request).
deny contains msg if {
	input.kind == "HTTPRoute"
	not lib.is_exempt(input, "httproute-parent")
	count(object.get(object.get(input, "spec", {}), "parentRefs", [])) == 0
	msg := sprintf("[httproute-parent] %s: no parentRefs, want %s", [lib.id(input), want])
}

deny contains msg if {
	input.kind == "HTTPRoute"
	not lib.is_exempt(input, "httproute-parent")
	meta := object.get(input, "metadata", {})
	route_ns := object.get(meta, "namespace", "")
	some ref in object.get(object.get(input, "spec", {}), "parentRefs", [])
	ns := object.get(ref, "namespace", route_ns)
	not valid_parent(ref, ns, object.get(meta, "name", ""), is_redirect_only(input))
	msg := sprintf("[httproute-parent] %s: parentRef %s/%s sectionName %q, want %s", [lib.id(input), ns, object.get(ref, "name", ""), object.get(ref, "sectionName", ""), want])
}

# httproute-parent: the same contract for parentRefs a remote chart receives
# through an Application's inline values; namespace must be explicit there.
deny contains msg if {
	input.kind == "Application"
	input.apiVersion == "argoproj.io/v1alpha1"
	not lib.is_exempt(input, "httproute-parent")
	walk(lib.inline_values(input), [path, refs])
	count(path) > 0
	path[count(path) - 1] == "parentRefs"
	is_array(refs)
	some ref in refs
	ns := object.get(ref, "namespace", "")
	not valid_parent(ref, ns, "", false)
	msg := sprintf("[httproute-parent] %s: inline values %s: parentRef %s/%s sectionName %q, want %s", [lib.id(input), concat(".", [sprintf("%v", [p]) | some p in path]), ns, object.get(ref, "name", ""), object.get(ref, "sectionName", ""), want])
}

# no-ingress: Envoy Gateway does not implement networking.k8s.io Ingress, so an
# Ingress is never served.
deny contains msg if {
	input.kind == "Ingress"
	startswith(object.get(input, "apiVersion", ""), "networking.k8s.io/")
	not lib.is_exempt(input, "no-ingress")
	msg := sprintf("[no-ingress] %s: Ingress is not served by Envoy Gateway; use an HTTPRoute", [lib.id(input)])
}

# Keys under which charts configure network policy rules rather than an Ingress.
network_policy_keys := {"networkPolicy", "networkpolicy", "netpol", "policy"}

deny contains msg if {
	input.kind == "Application"
	input.apiVersion == "argoproj.io/v1alpha1"
	not lib.is_exempt(input, "no-ingress")
	walk(lib.inline_values(input), [path, v])
	v == true
	count(path) > 1
	path[count(path) - 1] == "enabled"
	some i
	path[i] == "ingress"
	i < count(path) - 1
	not network_policy_path(path, i)
	msg := sprintf("[no-ingress] %s: inline values %s enables an Ingress, which Envoy Gateway does not serve; use the chart's HTTPRoute support", [lib.id(input), concat(".", [sprintf("%v", [p]) | some p in path])])
}

network_policy_path(path, i) if {
	some j
	path[j] in network_policy_keys
	j < i
}
