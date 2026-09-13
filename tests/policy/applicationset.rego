package homelab.applicationset

import data.homelab.lib

# is_appset matches rendered ArgoCD ApplicationSet objects (argoproj.io/v1alpha1).
# The rules below judge spec.template, the Application every generated
# Application starts from: the application.rego rules cannot see generated
# Applications at level 0, so the template has to carry the same guarantees.
is_appset if {
	input.kind == "ApplicationSet"
	input.apiVersion == "argoproj.io/v1alpha1"
}

tmpl := object.get(object.get(input, "spec", {}), "template", {})

tmpl_meta := object.get(tmpl, "metadata", {})

tmpl_spec := object.get(tmpl, "spec", {})

# appset-finalizer: generated Applications must carry the resources-finalizer,
# so deleting one (PR closed, label removed) cascades to what it deployed.
deny contains msg if {
	is_appset
	not lib.is_exempt(input, "appset-finalizer")
	finalizers := object.get(tmpl_meta, "finalizers", [])
	not "resources-finalizer.argocd.argoproj.io" in finalizers
	msg := sprintf("[appset-finalizer] %s: spec.template.metadata.finalizers missing resources-finalizer.argocd.argoproj.io", [lib.id(input)])
}

# appset-ssa: generated Applications must sync with ServerSideApply.
deny contains msg if {
	is_appset
	not lib.is_exempt(input, "appset-ssa")
	opts := object.get(object.get(tmpl_spec, "syncPolicy", {}), "syncOptions", [])
	not "ServerSideApply=true" in opts
	msg := sprintf("[appset-ssa] %s: spec.template.spec.syncPolicy.syncOptions missing ServerSideApply=true", [lib.id(input)])
}

# appset-project: generated Applications must use a dedicated AppProject. The
# default project allows every source, destination and kind, so an
# ApplicationSet fed by an external generator (pull requests) must never
# land in it.
deny contains msg if {
	is_appset
	not lib.is_exempt(input, "appset-project")
	project := object.get(tmpl_spec, "project", "")
	project in {"", "default"}
	msg := sprintf("[appset-project] %s: spec.template.spec.project must name a dedicated AppProject, not %q", [lib.id(input), project])
}

# appset-automated: generated Applications must prune and self-heal, like
# every other Application (app-automated). Off for an env whose _data.yaml says
# argocd_automated_sync: false (see lib.automated_sync_required).
deny contains msg if {
	is_appset
	lib.automated_sync_required
	not lib.is_exempt(input, "appset-automated")
	automated := object.get(object.get(tmpl_spec, "syncPolicy", {}), "automated", {})
	not automated.prune == true
	msg := sprintf("[appset-automated] %s: spec.template.spec.syncPolicy.automated.prune must be true", [lib.id(input)])
}

deny contains msg if {
	is_appset
	lib.automated_sync_required
	not lib.is_exempt(input, "appset-automated")
	automated := object.get(object.get(tmpl_spec, "syncPolicy", {}), "automated", {})
	not automated.selfHeal == true
	msg := sprintf("[appset-automated] %s: spec.template.spec.syncPolicy.automated.selfHeal must be true", [lib.id(input)])
}
