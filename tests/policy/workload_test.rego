package homelab.workload

good_resources := {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"cpu": "50m", "memory": "32Mi"}}

test_deployment_pass if {
	obj := {
		"kind": "Deployment",
		"metadata": {"name": "app", "namespace": "ns"},
		"spec": {"template": {"spec": {"containers": [{"name": "app", "image": "nginx:1.27.0", "resources": good_resources}]}}},
	}
	count(deny) == 0 with input as obj
}

test_deployment_latest_tag if {
	obj := {
		"kind": "Deployment",
		"metadata": {"name": "app", "namespace": "ns"},
		"spec": {"template": {"spec": {"containers": [{"name": "app", "image": "nginx:latest", "resources": good_resources}]}}},
	}
	some m in deny with input as obj
	startswith(m, "[image-latest]")
}

test_deployment_no_tag if {
	obj := {
		"kind": "Deployment",
		"metadata": {"name": "app", "namespace": "ns"},
		"spec": {"template": {"spec": {"containers": [{"name": "app", "image": "nginx", "resources": good_resources}]}}},
	}
	some m in deny with input as obj
	startswith(m, "[image-latest]")
}

test_cronjob_missing_resources if {
	obj := {
		"kind": "CronJob",
		"metadata": {"name": "job", "namespace": "ns"},
		"spec": {"jobTemplate": {"spec": {"template": {"spec": {"containers": [{"name": "app", "image": "curlimages/curl:8.19.0"}]}}}}},
	}
	some m in deny with input as obj
	startswith(m, "[container-resources]")
}

test_daemonset_partial_resources if {
	obj := {
		"kind": "DaemonSet",
		"metadata": {"name": "ds", "namespace": "ns"},
		"spec": {"template": {"spec": {"containers": [{
			"name": "app",
			"image": "busybox:1.36",
			"resources": {"requests": {"cpu": "1m", "memory": "8Mi"}, "limits": {"cpu": "10m"}},
		}]}}},
	}
	some m in deny with input as obj
	startswith(m, "[container-resources]")
}

test_application_inline_helm_latest_tag if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "plex", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "image:\n  repository: plexinc/pms-docker\n  tag: latest\n"}}},
	}
	some m in deny with input as obj
	startswith(m, "[image-latest]")
}

test_application_inline_helm_pinned_tag if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "plex", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "image:\n  repository: plexinc/pms-docker\n  tag: \"1.41.3\"\n"}}},
	}
	count(deny) == 0 with input as obj
}

test_registry_port_is_not_mistaken_for_a_tag if {
	obj := {
		"kind": "Deployment",
		"metadata": {"name": "app", "namespace": "ns"},
		"spec": {"template": {"spec": {"containers": [{"name": "app", "image": "registry.local:5000/app", "resources": good_resources}]}}},
	}
	some m in deny with input as obj
	startswith(m, "[image-latest]")
}

test_registry_port_with_pinned_tag_passes if {
	obj := {
		"kind": "Deployment",
		"metadata": {"name": "app", "namespace": "ns"},
		"spec": {"template": {"spec": {"containers": [{"name": "app", "image": "registry.local:5000/app:1.2.3", "resources": good_resources}]}}},
	}
	count(deny) == 0 with input as obj
}

test_digest_pinned_image_passes if {
	obj := {
		"kind": "Deployment",
		"metadata": {"name": "app", "namespace": "ns"},
		"spec": {"template": {"spec": {"containers": [{
			"name": "app",
			"image": "nginx@sha256:1234567890123456789012345678901234567890123456789012345678901234",
			"resources": good_resources,
		}]}}},
	}
	count(deny) == 0 with input as obj
}

test_exempt_image_latest if {
	obj := {
		"kind": "Deployment",
		"metadata": {"name": "app", "namespace": "ns", "annotations": {
			"homelab.local/policy-exempt": "image-latest",
			"homelab.local/policy-exempt-reason": "upstream publishes no numbered tags",
		}},
		"spec": {"template": {"spec": {"containers": [{"name": "app", "image": "nginx:latest", "resources": good_resources}]}}},
	}
	count(deny) == 0 with input as obj
}

cronjob_with_job_spec(job_spec) := {
	"kind": "CronJob",
	"metadata": {"name": "job", "namespace": "ns"},
	"spec": {"jobTemplate": {"spec": object.union(
		{"template": {"spec": {"containers": [{"name": "app", "image": "curlimages/curl:8.19.0", "resources": good_resources}]}}},
		job_spec,
	)}},
}

test_cronjob_without_ttl_is_denied if {
	some m in deny with input as cronjob_with_job_spec({})
	startswith(m, "[cronjob-ttl]")
}

test_cronjob_with_ttl_passes if {
	count(deny) == 0 with input as cronjob_with_job_spec({"ttlSecondsAfterFinished": 3600})
}

test_cronjob_with_non_numeric_ttl_is_denied if {
	some m in deny with input as cronjob_with_job_spec({"ttlSecondsAfterFinished": "1h"})
	startswith(m, "[cronjob-ttl]")
}
