package verify

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

// ProdKubeContext is the kubeconfig context `task prod:kubeconfig`
// (scripts/prod-readonly.ts) writes into ~/.kube/homelab-readonly.yaml. It
// authenticates as the agent-readonly ServiceAccount (charts/agent-readonly)
// through the Tailscale operator's API server proxy.
const ProdKubeContext = "homelab-readonly"

// ProdCheckPrefix names the production Application checks: prod/argocd/<app>.
const ProdCheckPrefix = "prod/argocd"

// prodSetupHint ends every failure that means the read-only path to
// production is not set up or not reachable.
const prodSetupHint = "run `task prod:kubeconfig`, check that Tailscale is connected, and see docs/runbooks/readonly-access.md"

// ProdOptions configures ProdArgoCDApps.
type ProdOptions struct {
	// Runner executes kubectl; tests supply a fake.
	Runner Runner
	// Dir is the working directory for kubectl.
	Dir string
	// Kubeconfig is passed as --kubeconfig when non-empty; it must exist.
	Kubeconfig string
	// KubeContext selects the read-only context (homelab-readonly).
	KubeContext string
	// RequestTimeout is kubectl's --request-timeout (e.g. "30s"); empty omits it.
	RequestTimeout string
	// RequireSynced also fails Applications whose sync status is not Synced.
	RequireSynced bool
}

// prodAppRules evaluates production Applications: the same Healthy +
// Succeeded contract as level 2, with production wording and an opt-in
// Synced requirement (automated sync is on in homelab, so OutOfSync there is
// drift or a pending sync rather than the local-sync artefact it is in Kind).
func prodAppRules(requireSynced bool) argoAppRules {
	return argoAppRules{
		prefix:          ProdCheckPrefix,
		noOperationHint: "no sync operation recorded (the Application has never been synced)",
		requireSynced:   requireSynced,
	}
}

// ProdKubectlArgs is the only kubectl invocation `homelab verify prod` makes:
// a read of the Applications in namespace argocd. There is no write path.
func ProdKubectlArgs(opts ProdOptions) []string {
	var args []string
	if opts.Kubeconfig != "" {
		args = append(args, "--kubeconfig", opts.Kubeconfig)
	}
	args = append(args, "--context", opts.KubeContext)
	if opts.RequestTimeout != "" {
		args = append(args, "--request-timeout", opts.RequestTimeout)
	}
	return append(args, "get", "applications.argoproj.io", "-n", "argocd", "-o", "json")
}

// ProdArgoCDApps reads every Application in the production argocd namespace
// through the read-only context and produces one "prod/argocd/<app>" check
// per Application (pass: Healthy and the last operation Succeeded, plus
// Synced with RequireSynced). Anything that prevents the read is a single
// "prod/argocd/apps" failure — never a skip: this command exists to answer
// "is production healthy", and an unanswered question must not exit 0.
func ProdArgoCDApps(ctx context.Context, opts ProdOptions) []Check {
	start := time.Now()
	name := ProdCheckPrefix + "/apps"

	if _, err := opts.Runner.LookPath("kubectl"); err != nil {
		return []Check{FailCheck(name, start, ToolMissingDetail("kubectl"))}
	}
	if opts.Kubeconfig != "" {
		if _, err := os.Stat(opts.Kubeconfig); err != nil {
			return []Check{FailCheck(name, start,
				fmt.Sprintf("read-only kubeconfig %s does not exist", opts.Kubeconfig), prodSetupHint)}
		}
	}

	stdout, stderr, runErr := opts.Runner.Run(ctx, opts.Dir, "kubectl", ProdKubectlArgs(opts)...)
	if runErr != nil {
		return []Check{prodKubectlFailure(name, start, opts.KubeContext, stderr, runErr)}
	}

	var list argoAppList
	if err := json.Unmarshal(stdout, &list); err != nil {
		return []Check{FailCheck(name, start, fmt.Sprintf("parsing kubectl get applications output: %v", err))}
	}
	if len(list.Items) == 0 {
		return []Check{FailCheck(name, start,
			fmt.Sprintf("no Applications in namespace argocd visible through kube context %s", opts.KubeContext),
			"the root gitops Application should always exist in homelab; check the context points at production")}
	}

	rules := prodAppRules(opts.RequireSynced)
	checks := make([]Check, 0, len(list.Items))
	for _, app := range list.Items {
		checks = append(checks, evaluateArgoApp(app, start, rules))
	}
	sort.SliceStable(checks, func(i, j int) bool { return checks[i].Name < checks[j].Name })
	return checks
}

// prodUnreachableMarkers extend unreachableMarkers with what a tailnet path
// adds: a proxy that does not answer times out rather than refusing.
var prodUnreachableMarkers = []string{
	"i/o timeout",
	"context deadline exceeded",
	"TLS handshake timeout",
	"no route to host",
	"Client.Timeout exceeded",
}

// prodKubectlFailure classifies a failed read into one actionable check.
func prodKubectlFailure(name string, start time.Time, kubeContext string, stderr []byte, runErr error) Check {
	s := string(stderr)
	lines := capLines(nonEmptyLines(stderr))
	switch {
	case isShimMissing(stderr):
		return FailCheck(name, start, ToolMissingDetail("kubectl"))
	case isClusterUnreachable(stderr) || containsAny(s, prodUnreachableMarkers):
		return FailCheck(name, start,
			fmt.Sprintf("production API server unreachable via kube context %s", kubeContext),
			append(lines, prodSetupHint)...)
	case strings.Contains(s, "Unauthorized") || strings.Contains(s, "You must be logged in"):
		return FailCheck(name, start,
			"the API server rejected the agent-readonly token (Unauthorized)",
			append(lines, "the token was rotated or revoked: update op://homelab/k8s-agent-readonly/credential and re-run `task prod:kubeconfig`")...)
	case strings.Contains(s, "Forbidden") || strings.Contains(s, "forbidden"):
		return FailCheck(name, start,
			"RBAC denied reading Applications (Forbidden)",
			append(lines, "charts/agent-readonly must grant get/list on applications.argoproj.io; is the homelab-agent-readonly ClusterRoleBinding synced?")...)
	default:
		return FailCheck(name, start, fmt.Sprintf("kubectl get applications failed: %v", runErr), lines...)
	}
}

// containsAny reports whether s contains any of the markers.
func containsAny(s string, markers []string) bool {
	for _, m := range markers {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}
