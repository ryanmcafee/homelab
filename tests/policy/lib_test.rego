package homelab.lib

test_domain_from_data if {
	domain == "example.com" with data.domain as "example.com"
}

test_not_exempt_by_default if {
	obj := {"kind": "Application", "metadata": {"name": "x", "namespace": "argocd"}}
	not is_exempt(obj, "app-automated")
}

test_exempt_with_reason if {
	obj := {"kind": "Application", "metadata": {"name": "x", "namespace": "argocd", "annotations": {
		"homelab.local/policy-exempt": "app-automated, image-latest",
		"homelab.local/policy-exempt-reason": "cilium is installed by talos",
	}}}
	is_exempt(obj, "app-automated")
	is_exempt(obj, "image-latest")
	not is_exempt(obj, "app-ssa")
}

test_exempt_requires_reason if {
	obj := {"kind": "Application", "metadata": {"name": "x", "namespace": "argocd", "annotations": {
		"homelab.local/policy-exempt": "app-automated",
	}}}
	not is_exempt(obj, "app-automated")
}

test_id if {
	obj := {"kind": "Application", "metadata": {"name": "x", "namespace": "argocd"}}
	id(obj) == "Application/argocd/x"
}

test_id_defensive_when_metadata_missing if {
	obj := {"kind": "Deployment"}
	id(obj) == "Deployment//"
}
