package homelab.secret

import data.homelab.lib

# allowed_keys are the fields legitimate for an ArgoCD repository Secret
# (argocd.argoproj.io/secret-type: repository). Anything else on a Secret's
# data/stringData means real secret material is committed inline rather than
# being 1Password/SOPS managed.
allowed_keys := {"name", "url", "type", "enableOCI", "project", "insecure"}

deny contains msg if {
	input.kind == "Secret"
	not lib.is_exempt(input, "inline-secret")
	data_keys := object.keys(object.get(input, "data", {}))
	string_data_keys := object.keys(object.get(input, "stringData", {}))
	all_keys := data_keys | string_data_keys
	bad := all_keys - allowed_keys
	count(bad) > 0
	msg := sprintf("[inline-secret] %s: Secret carries non-repository keys %v", [lib.id(input), bad])
}
