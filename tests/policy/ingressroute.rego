package homelab.ingressroute

import data.homelab.lib

# ingressroute-class: both Traefik instances run with
# --providers.kubernetescrd.ingressClass=<external|internal>, so an IngressRoute
# without the kubernetes.io/ingress.class annotation is loaded by neither one:
# it applies cleanly, shows Healthy in ArgoCD and serves the default
# certificate with a 404.
allowed_classes := {"external", "internal"}

deny contains msg if {
	input.kind == "IngressRoute"
	not lib.is_exempt(input, "ingressroute-class")
	ann := object.get(object.get(input, "metadata", {}), "annotations", {})
	class := object.get(ann, "kubernetes.io/ingress.class", "")
	not class in allowed_classes
	msg := sprintf("[ingressroute-class] %s: annotation kubernetes.io/ingress.class is %q, want one of %v; no Traefik instance loads this route", [lib.id(input), class, sort(allowed_classes)])
}
