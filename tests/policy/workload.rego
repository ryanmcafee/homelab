package homelab.workload

import data.homelab.lib

# workload_kinds are the literal Kubernetes workload kinds this repo renders
# directly (as opposed to via a remote Helm chart's own templates, which are
# not part of our rendered output).
workload_kinds := {"Deployment", "StatefulSet", "DaemonSet", "Job", "Pod"}

default pod_spec(obj) := null

pod_spec(obj) := obj.spec if obj.kind == "Pod"

pod_spec(obj) := obj.spec.template.spec if obj.kind in {"Deployment", "StatefulSet", "DaemonSet", "Job"}

pod_spec(obj) := obj.spec.jobTemplate.spec.template.spec if obj.kind == "CronJob"

default containers_for(obj) := []

containers_for(obj) := array.concat(
	object.get(pod_spec(obj), "containers", []),
	object.get(pod_spec(obj), "initContainers", []),
) if pod_spec(obj) != null

is_workload if input.kind in workload_kinds

is_workload if input.kind == "CronJob"

# is_untagged reports whether an image reference has no tag, or is
# explicitly pinned to the moving ":latest" tag.
is_untagged(image) if not contains(image, ":")

is_untagged(image) if endswith(image, ":latest")

# image-latest: no container image in a rendered workload may be untagged or
# pinned to :latest.
deny contains msg if {
	is_workload
	not lib.is_exempt(input, "image-latest")
	some c in containers_for(input)
	is_untagged(c.image)
	msg := sprintf("[image-latest] %s: container %s uses image %q without a pinned tag", [lib.id(input), c.name, c.image])
}

# image-latest: also catch image.tag set inside an Application's inline
# `spec.source.helm.values` block (a YAML string), since that's how most
# workloads in this repo configure the remote chart they point to.
deny contains msg if {
	input.kind == "Application"
	input.apiVersion == "argoproj.io/v1alpha1"
	not lib.is_exempt(input, "image-latest")
	raw := object.get(object.get(input.spec, "source", {}), "helm", {}).values
	is_string(raw)
	parsed := yaml.unmarshal(raw)
	tag := object.get(object.get(parsed, "image", {}), "tag", "")
	is_string(tag)
	tag != ""
	is_untagged(sprintf("x:%s", [tag]))
	msg := sprintf("[image-latest] %s: spec.source.helm.values image.tag %q is not pinned", [lib.id(input), tag])
}

missing_resource(c) if not c.resources.requests.cpu

missing_resource(c) if not c.resources.requests.memory

missing_resource(c) if not c.resources.limits.cpu

missing_resource(c) if not c.resources.limits.memory

# container-resources: every container in a rendered workload must set both
# requests and limits for cpu and memory.
deny contains msg if {
	is_workload
	not lib.is_exempt(input, "container-resources")
	some c in containers_for(input)
	missing_resource(c)
	msg := sprintf("[container-resources] %s: container %s is missing resources.requests/limits for cpu and memory", [lib.id(input), c.name])
}
