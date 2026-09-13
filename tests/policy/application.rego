package homelab.application

import data.homelab.lib

# is_app matches rendered ArgoCD Application objects (argoproj.io/v1alpha1).
is_app if {
	input.kind == "Application"
	input.apiVersion == "argoproj.io/v1alpha1"
}

# app-finalizer: every Application must carry the resources-finalizer so
# ArgoCD cleans up managed resources on delete.
deny contains msg if {
	is_app
	not lib.is_exempt(input, "app-finalizer")
	finalizers := object.get(input.metadata, "finalizers", [])
	not "resources-finalizer.argocd.argoproj.io" in finalizers
	msg := sprintf("[app-finalizer] %s: missing finalizer resources-finalizer.argocd.argoproj.io", [lib.id(input)])
}

# app-sync-wave: every Application must carry a numeric sync-wave annotation
# so deployment ordering across the App-of-Apps tree is explicit.
deny contains msg if {
	is_app
	not lib.is_exempt(input, "app-sync-wave")
	ann := object.get(input.metadata, "annotations", {})
	wave := object.get(ann, "argocd.argoproj.io/sync-wave", "")
	not regex.match(`^-?[0-9]+$`, wave)
	msg := sprintf("[app-sync-wave] %s: missing or non-numeric argocd.argoproj.io/sync-wave annotation (got %q)", [lib.id(input), wave])
}

# app-ssa: every Application must sync with ServerSideApply so CRD defaults
# and large objects apply cleanly.
deny contains msg if {
	is_app
	not lib.is_exempt(input, "app-ssa")
	opts := object.get(object.get(input.spec, "syncPolicy", {}), "syncOptions", [])
	not "ServerSideApply=true" in opts
	msg := sprintf("[app-ssa] %s: spec.syncPolicy.syncOptions missing ServerSideApply=true", [lib.id(input)])
}

# app-automated: every Application must self-heal and prune drift so the
# cluster tracks Git. Deliberate exceptions (e.g. Cilium, installed by Talos)
# use the policy-exempt annotation. The whole rule is off for an env whose
# _data.yaml says argocd_automated_sync: false (see lib.automated_sync_required).
deny contains msg if {
	is_app
	lib.automated_sync_required
	not lib.is_exempt(input, "app-automated")
	automated := object.get(object.get(input.spec, "syncPolicy", {}), "automated", {})
	not automated.prune == true
	msg := sprintf("[app-automated] %s: spec.syncPolicy.automated.prune must be true", [lib.id(input)])
}

deny contains msg if {
	is_app
	lib.automated_sync_required
	not lib.is_exempt(input, "app-automated")
	automated := object.get(object.get(input.spec, "syncPolicy", {}), "automated", {})
	not automated.selfHeal == true
	msg := sprintf("[app-automated] %s: spec.syncPolicy.automated.selfHeal must be true", [lib.id(input)])
}
