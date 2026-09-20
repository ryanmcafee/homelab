package homelab.ingressroute

route(annotations) := {
	"apiVersion": "traefik.io/v1alpha1",
	"kind": "IngressRoute",
	"metadata": {"name": "auth-oidc", "namespace": "traefik", "annotations": annotations},
	"spec": {"routes": [{"kind": "Rule", "match": "Host(`auth.example.com`)"}]},
}

test_ingressroute_with_external_class_passes if {
	count(deny) == 0 with input as route({"kubernetes.io/ingress.class": "external"})
}

test_ingressroute_with_internal_class_passes if {
	count(deny) == 0 with input as route({"kubernetes.io/ingress.class": "internal"})
}

test_ingressroute_without_class_is_denied if {
	some m in deny with input as route({})
	startswith(m, "[ingressroute-class]")
}

test_ingressroute_with_unknown_class_is_denied if {
	some m in deny with input as route({"kubernetes.io/ingress.class": "nginx"})
	startswith(m, "[ingressroute-class]")
}

test_ingressroute_without_metadata_annotations_is_denied if {
	obj := {"kind": "IngressRoute", "metadata": {"name": "r", "namespace": "traefik"}}
	some m in deny with input as obj
	startswith(m, "[ingressroute-class]")
}

test_exempt_ingressroute_passes if {
	count(deny) == 0 with input as route({
		"homelab.local/policy-exempt": "ingressroute-class",
		"homelab.local/policy-exempt-reason": "served by a third Traefik without a class filter",
	})
}
