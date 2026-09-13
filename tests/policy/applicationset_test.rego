package homelab.applicationset

good_appset := {
	"kind": "ApplicationSet",
	"apiVersion": "argoproj.io/v1alpha1",
	"metadata": {"name": "previews", "namespace": "argocd"},
	"spec": {
		"goTemplate": true,
		"generators": [{"pullRequest": {"github": {"owner": "o", "repo": "r"}}}],
		"template": {
			"metadata": {
				"name": "preview-pr{{.number}}",
				"finalizers": ["resources-finalizer.argocd.argoproj.io"],
			},
			"spec": {
				"project": "previews",
				"syncPolicy": {
					"automated": {"prune": true, "selfHeal": true},
					"syncOptions": ["CreateNamespace=true", "ServerSideApply=true"],
				},
			},
		},
	},
}

exempt_annotations(reason) := {"homelab.ryanmcafee.com/policy-exempt": "appset-project"} if {
	reason == ""
} else := {
	"homelab.ryanmcafee.com/policy-exempt": "appset-project",
	"homelab.ryanmcafee.com/policy-exempt-reason": reason,
}

test_good_appset_passes if {
	count(deny) == 0 with input as good_appset
}

test_non_appset_ignored if {
	app := json.patch(good_appset, [{"op": "replace", "path": "/kind", "value": "Application"}])
	count(deny) == 0 with input as app
}

test_missing_finalizer if {
	appset := json.patch(good_appset, [{"op": "remove", "path": "/spec/template/metadata/finalizers"}])
	some m in deny with input as appset
	startswith(m, "[appset-finalizer]")
}

test_missing_ssa if {
	appset := json.patch(good_appset, [{"op": "replace", "path": "/spec/template/spec/syncPolicy/syncOptions", "value": ["CreateNamespace=true"]}])
	some m in deny with input as appset
	startswith(m, "[appset-ssa]")
}

test_default_project if {
	appset := json.patch(good_appset, [{"op": "replace", "path": "/spec/template/spec/project", "value": "default"}])
	some m in deny with input as appset
	startswith(m, "[appset-project]")
}

test_missing_project if {
	appset := json.patch(good_appset, [{"op": "remove", "path": "/spec/template/spec/project"}])
	some m in deny with input as appset
	startswith(m, "[appset-project]")
}

test_missing_automated if {
	appset := json.patch(good_appset, [{"op": "remove", "path": "/spec/template/spec/syncPolicy/automated"}])
	msgs := deny with input as appset
	some p in msgs
	contains(p, "automated.prune")
	some s in msgs
	contains(s, "automated.selfHeal")
}

test_automated_not_required_when_env_syncs_locally if {
	appset := json.patch(good_appset, [{"op": "remove", "path": "/spec/template/spec/syncPolicy/automated"}])
	count(deny) == 0 with input as appset with data.argocd_automated_sync as false
}

test_exemption_with_reason if {
	appset := json.patch(good_appset, [
		{"op": "replace", "path": "/spec/template/spec/project", "value": "default"},
		{"op": "add", "path": "/metadata/annotations", "value": exempt_annotations("test")},
	])
	count(deny) == 0 with input as appset
}

test_exemption_without_reason_ignored if {
	appset := json.patch(good_appset, [
		{"op": "replace", "path": "/spec/template/spec/project", "value": "default"},
		{"op": "add", "path": "/metadata/annotations", "value": exempt_annotations("")},
	])
	some m in deny with input as appset
	startswith(m, "[appset-project]")
}
