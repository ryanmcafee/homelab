package homelab.application

good_app := {
	"kind": "Application",
	"apiVersion": "argoproj.io/v1alpha1",
	"metadata": {
		"name": "addons",
		"namespace": "argocd",
		"annotations": {"argocd.argoproj.io/sync-wave": "2"},
		"finalizers": ["resources-finalizer.argocd.argoproj.io"],
	},
	"spec": {"syncPolicy": {
		"automated": {"prune": true, "selfHeal": true},
		"syncOptions": ["ServerSideApply=true"],
	}},
}

test_good_app_passes if {
	count(deny) == 0 with input as good_app
}

test_non_application_ignored if {
	obj := {"kind": "Deployment", "metadata": {"name": "x", "namespace": "ns"}}
	count(deny) == 0 with input as obj
}

test_missing_finalizer if {
	app := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {
			"name": "addons",
			"namespace": "argocd",
			"annotations": {"argocd.argoproj.io/sync-wave": "2"},
		},
		"spec": {"syncPolicy": {
			"automated": {"prune": true, "selfHeal": true},
			"syncOptions": ["ServerSideApply=true"],
		}},
	}
	some m in deny with input as app
	startswith(m, "[app-finalizer]")
}

test_bad_sync_wave if {
	app := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {
			"name": "addons",
			"namespace": "argocd",
			"annotations": {"argocd.argoproj.io/sync-wave": "not-a-number"},
			"finalizers": ["resources-finalizer.argocd.argoproj.io"],
		},
		"spec": {"syncPolicy": {
			"automated": {"prune": true, "selfHeal": true},
			"syncOptions": ["ServerSideApply=true"],
		}},
	}
	some m in deny with input as app
	startswith(m, "[app-sync-wave]")
}

test_missing_ssa if {
	app := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {
			"name": "addons",
			"namespace": "argocd",
			"annotations": {"argocd.argoproj.io/sync-wave": "2"},
			"finalizers": ["resources-finalizer.argocd.argoproj.io"],
		},
		"spec": {"syncPolicy": {
			"automated": {"prune": true, "selfHeal": true},
			"syncOptions": [],
		}},
	}
	some m in deny with input as app
	startswith(m, "[app-ssa]")
}

test_not_automated if {
	app := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {
			"name": "addons",
			"namespace": "argocd",
			"annotations": {"argocd.argoproj.io/sync-wave": "2"},
			"finalizers": ["resources-finalizer.argocd.argoproj.io"],
		},
		"spec": {"syncPolicy": {
			"automated": {"prune": false, "selfHeal": true},
			"syncOptions": ["ServerSideApply=true"],
		}},
	}
	some m in deny with input as app
	startswith(m, "[app-automated]")
}

test_exempt_automated if {
	app := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {
			"name": "cilium",
			"namespace": "argocd",
			"annotations": {
				"argocd.argoproj.io/sync-wave": "0",
				"homelab.ryanmcafee.com/policy-exempt": "app-automated",
				"homelab.ryanmcafee.com/policy-exempt-reason": "cilium is installed by talos inline manifests",
			},
			"finalizers": ["resources-finalizer.argocd.argoproj.io"],
		},
		"spec": {"syncPolicy": {
			"automated": {"prune": false, "selfHeal": true},
			"syncOptions": ["ServerSideApply=true"],
		}},
	}
	count(deny) == 0 with input as app
}
