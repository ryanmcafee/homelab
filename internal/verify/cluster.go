package verify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ClusterOptions configures the level-1 and level-2 checks, which read a
// Kind cluster (never production; ADR-009) through kubectl and chainsaw.
type ClusterOptions struct {
	// Runner executes kubectl and chainsaw; tests supply a fake.
	Runner Runner
	// RepoRoot is the repository root; chainsaw runs from here.
	RepoRoot string
	// RenderDir is the level-0 render directory (<RenderDir>/localdev/*.yaml).
	RenderDir string
	// KubeContext is the kubeconfig context of the Kind cluster
	// (kind-homelab-localdev).
	KubeContext string
	// E2EDir holds the chainsaw tests and .chainsaw.yaml. A relative path is
	// resolved against RepoRoot.
	E2EDir string
}

// maxFindings caps the stderr lines copied into a failing check's findings.
const maxFindings = 20

// dryRunFieldManager is the server-side-apply field manager for dry runs. A
// dedicated name keeps `--force-conflicts` from ever contesting a field owned
// by argocd-controller in the live objects' managedFields.
const dryRunFieldManager = "homelab-verify"

// DryRun (level 1) server-side dry-run applies every rendered localdev chart
// file against the Kind cluster, producing one "dryrun/localdev/<chart>"
// check per file. The API server validates the objects against the installed
// CRDs and admission chain, which catches what kubeconform cannot: unknown
// fields on CRs, webhook rejections and immutable-field changes.
//
// Files with no YAML document (a chart that rendered nothing for localdev)
// are skipped silently. A missing kubectl yields one skip check; the first
// failure that looks like an unreachable cluster yields one "dryrun/cluster"
// failure and stops, so a stopped Kind cluster reads as one finding rather
// than one per chart.
func DryRun(ctx context.Context, opts ClusterOptions) []Check {
	start := time.Now()
	const name = "dryrun/localdev"

	if _, err := opts.Runner.LookPath("kubectl"); err != nil {
		return []Check{SkipCheck(name, ToolMissingDetail("kubectl"))}
	}

	envDir := filepath.Join(opts.RenderDir, "localdev")
	files, err := manifestFiles(envDir)
	if err != nil {
		return []Check{FailCheck(name, start, fmt.Sprintf("listing rendered manifests in %s: %v", envDir, err))}
	}

	var checks []Check
	applied := 0
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			checks = append(checks, FailCheck(name, start, fmt.Sprintf("reading %s: %v", file, err)))
			continue
		}
		if !hasYAMLDocument(raw) {
			continue
		}
		applied++
		chart := strings.TrimSuffix(filepath.Base(file), ".yaml")
		checkName := name + "/" + chart
		checkStart := time.Now()

		stdout, stderr, runErr := opts.Runner.Run(ctx, opts.RepoRoot, "kubectl",
			"--context", opts.KubeContext,
			"apply", "--server-side", "--dry-run=server", "--force-conflicts",
			"--field-manager", dryRunFieldManager,
			"-f", file)
		if runErr == nil {
			objects := len(nonEmptyLines(stdout))
			checks = append(checks, PassCheck(checkName, checkStart, fmt.Sprintf("%d object(s) accepted by the API server", objects)))
			continue
		}
		if isShimMissing(stderr) {
			return []Check{SkipCheck(name, ToolMissingDetail("kubectl"))}
		}
		if isClusterUnreachable(stderr) {
			return append(checks, clusterUnreachableCheck("dryrun/cluster", checkStart, opts.KubeContext, stderr))
		}
		lines := nonEmptyLines(stderr)
		detail := fmt.Sprintf("server-side dry run rejected %s (%d line(s) on stderr)", filepath.Base(file), len(lines))
		checks = append(checks, FailCheck(checkName, checkStart, detail, capLines(lines)...))
	}
	if applied == 0 {
		return []Check{FailCheck(name, start, fmt.Sprintf("no rendered manifests with a YAML document in %s", envDir))}
	}
	return checks
}

// argoAppList is the subset of `kubectl get applications.argoproj.io -o json`
// the checks read. It deliberately avoids the ArgoCD API types: only these
// fields matter and pulling in the k8s module graph is not worth it.
type argoAppList struct {
	Items []argoApp `json:"items"`
}

type argoApp struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	// Spec carries only the Helm inputs of each source: what verify prod
	// inspects for the Terraform-injected global.domain and for chart
	// placeholders that reached production (prod/argocd/domain).
	Spec struct {
		Source  *argoAppSource  `json:"source"`
		Sources []argoAppSource `json:"sources"`
	} `json:"spec"`
	Status struct {
		Sync struct {
			Status string `json:"status"`
		} `json:"sync"`
		Health struct {
			Status  string `json:"status"`
			Message string `json:"message"`
		} `json:"health"`
		OperationState *struct {
			Phase   string `json:"phase"`
			Message string `json:"message"`
		} `json:"operationState"`
		Conditions []struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"conditions"`
		Resources []struct {
			Kind      string `json:"kind"`
			Namespace string `json:"namespace"`
			Name      string `json:"name"`
			Health    *struct {
				Status  string `json:"status"`
				Message string `json:"message"`
			} `json:"health"`
		} `json:"resources"`
	} `json:"status"`
}

// argoAppSource is one spec.source / spec.sources[] entry, reduced to its
// Helm inputs. valuesObject stays raw: the check only searches it for text.
type argoAppSource struct {
	Helm *struct {
		Values       string          `json:"values"`
		ValuesObject json.RawMessage `json:"valuesObject"`
		Parameters   []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"parameters"`
	} `json:"helm"`
}

// ArgoCDApps (level 2) reads every Application in the argocd namespace and
// produces one "argocd/<name>" check per Application. A check passes only
// when the app is Healthy and its last sync operation Succeeded; an app that
// has never been synced (no operationState) fails, because in localdev
// automated sync is off and `task localdev:sync` must have run.
//
// Findings on a failing app: every status condition, every resource whose
// health is set and not Healthy, and the operation message when the
// operation did not succeed. Zero Applications is a failure of its own
// ("argocd/apps"): the cluster is up but the root app was never installed.
func ArgoCDApps(ctx context.Context, opts ClusterOptions) []Check {
	start := time.Now()
	const name = "argocd/apps"

	if _, err := opts.Runner.LookPath("kubectl"); err != nil {
		return []Check{SkipCheck(name, ToolMissingDetail("kubectl"))}
	}

	stdout, stderr, runErr := opts.Runner.Run(ctx, opts.RepoRoot, "kubectl",
		"--context", opts.KubeContext,
		"get", "applications.argoproj.io", "-n", "argocd", "-o", "json")
	if runErr != nil {
		if isShimMissing(stderr) {
			return []Check{SkipCheck(name, ToolMissingDetail("kubectl"))}
		}
		if isClusterUnreachable(stderr) {
			return []Check{clusterUnreachableCheck(name, start, opts.KubeContext, stderr)}
		}
		lines := nonEmptyLines(stderr)
		return []Check{FailCheck(name, start, fmt.Sprintf("kubectl get applications failed: %v", runErr), capLines(lines)...)}
	}

	var list argoAppList
	if err := json.Unmarshal(stdout, &list); err != nil {
		return []Check{FailCheck(name, start, fmt.Sprintf("parsing kubectl get applications output: %v", err))}
	}
	if len(list.Items) == 0 {
		return []Check{FailCheck(name, start, "no Applications in namespace argocd (run task localdev:up)")}
	}

	checks := make([]Check, 0, len(list.Items))
	for _, app := range list.Items {
		checks = append(checks, argoAppCheck(app, start))
	}
	sort.SliceStable(checks, func(i, j int) bool { return checks[i].Name < checks[j].Name })
	return checks
}

// argoAppRules parameterises evaluateArgoApp for the Kind checks (level 2,
// "argocd/<app>") and the read-only production checks (`verify prod`,
// "prod/argocd/<app>", prod.go).
type argoAppRules struct {
	// prefix names the checks: "<prefix>/<app>".
	prefix string
	// noOperationHint is the finding for an Application with no recorded
	// sync operation.
	noOperationHint string
	// requireSynced also fails an Application whose sync status is not Synced.
	requireSynced bool
}

// kindAppRules: in Kind every Application is OutOfSync against main by design
// (ADR-012), so only health and the last operation count.
var kindAppRules = argoAppRules{
	prefix:          "argocd",
	noOperationHint: "no sync operation recorded (run task localdev:sync)",
}

// argoAppCheck evaluates one Application of the Kind cluster.
func argoAppCheck(app argoApp, start time.Time) Check {
	return evaluateArgoApp(app, start, kindAppRules)
}

// evaluateArgoApp passes an Application that is Healthy with a Succeeded
// last operation (and Synced when rules.requireSynced); otherwise it fails
// with its conditions, unhealthy resources and operation message.
func evaluateArgoApp(app argoApp, start time.Time, rules argoAppRules) Check {
	name := rules.prefix + "/" + app.Metadata.Name
	phase := ""
	opMessage := ""
	if app.Status.OperationState != nil {
		phase = app.Status.OperationState.Phase
		opMessage = app.Status.OperationState.Message
	}
	health := app.Status.Health.Status
	detail := fmt.Sprintf("sync=%s health=%s op=%s", app.Status.Sync.Status, health, phase)
	synced := !rules.requireSynced || app.Status.Sync.Status == "Synced"

	if health == "Healthy" && phase == "Succeeded" && synced {
		return PassCheck(name, start, detail)
	}
	// A chart that renders nothing (charts/traefik-internal-dependencies in
	// homelab is a comment-only placeholder) never gets a sync operation:
	// ArgoCD has nothing to apply. Synced + Healthy with no resources is
	// therefore complete, not "never synced". Sync status is required here even
	// when rules.requireSynced is false: without resources or an operation it
	// is the only evidence that ArgoCD reconciled the Application at all.
	if health == "Healthy" && phase == "" && opMessage == "" &&
		len(app.Status.Resources) == 0 && app.Status.Sync.Status == "Synced" {
		return PassCheck(name, start, detail+" (no resources: nothing to sync)")
	}

	var findings []string
	if !synced {
		status := app.Status.Sync.Status
		if status == "" {
			status = "unknown"
		}
		findings = append(findings, fmt.Sprintf("sync status %s (want Synced)", status))
	}
	for _, cond := range app.Status.Conditions {
		findings = append(findings, fmt.Sprintf("%s: %s", cond.Type, cond.Message))
	}
	for _, res := range app.Status.Resources {
		if res.Health == nil || res.Health.Status == "" || res.Health.Status == "Healthy" {
			continue
		}
		line := fmt.Sprintf("%s/%s/%s: %s", res.Kind, res.Namespace, res.Name, res.Health.Status)
		if res.Health.Message != "" {
			line += " " + res.Health.Message
		}
		findings = append(findings, line)
	}
	if phase != "Succeeded" && opMessage != "" {
		findings = append(findings, fmt.Sprintf("operation %s: %s", phase, opMessage))
	}
	if phase == "" && opMessage == "" {
		findings = append(findings, rules.noOperationHint)
	}
	return FailCheck(name, start, detail, findings...)
}

// chainsawReport mirrors the JSON `chainsaw test --report-format JSON`
// (v0.2.15) writes: tests[] -> steps[] -> operations[], each with a status
// of "passed" or "failed" and, on failure, failure.error.
type chainsawReport struct {
	Name  string         `json:"name"`
	Tests []chainsawTest `json:"tests"`
}

type chainsawTest struct {
	BasePath  string         `json:"basePath"`
	Name      string         `json:"name"`
	Status    string         `json:"status"`
	StartTime time.Time      `json:"startTime"`
	EndTime   time.Time      `json:"endTime"`
	Steps     []chainsawStep `json:"steps"`
}

type chainsawStep struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Operations []struct {
		Name    string `json:"name"`
		Type    string `json:"type"`
		Status  string `json:"status"`
		Failure *struct {
			Error string `json:"error"`
		} `json:"failure"`
	} `json:"operations"`
}

// Chainsaw (level 2) runs the tests/e2e chainsaw suite against the Kind
// cluster and produces one "e2e/<test>" check per test from the JSON report.
// Chainsaw exits non-zero whenever a test fails, so the exit status is only
// consulted when no report was written (a configuration or cluster error).
func Chainsaw(ctx context.Context, opts ClusterOptions) []Check {
	start := time.Now()
	const name = "e2e/chainsaw"

	if _, err := opts.Runner.LookPath("chainsaw"); err != nil {
		return []Check{SkipCheck(name, ToolMissingDetail("chainsaw"))}
	}

	e2eDir := opts.E2EDir
	if !filepath.IsAbs(e2eDir) {
		e2eDir = filepath.Join(opts.RepoRoot, e2eDir)
	}

	reportDir, err := os.MkdirTemp("", "homelab-chainsaw-")
	if err != nil {
		return []Check{FailCheck(name, start, fmt.Sprintf("creating report directory: %v", err))}
	}
	defer os.RemoveAll(reportDir)

	args := []string{"test"}
	if config := filepath.Join(e2eDir, ".chainsaw.yaml"); fileExists(config) {
		args = append(args, "--config", config)
	}
	args = append(args, e2eDir,
		"--report-format", "JSON",
		"--report-path", reportDir,
		"--report-name", "report",
		"--no-color")
	if opts.KubeContext != "" {
		args = append(args, "--kube-context", opts.KubeContext)
	}

	stdout, stderr, runErr := opts.Runner.Run(ctx, opts.RepoRoot, "chainsaw", args...)
	if runErr != nil && isShimMissing(stderr) {
		return []Check{SkipCheck(name, ToolMissingDetail("chainsaw"))}
	}

	raw, readErr := os.ReadFile(filepath.Join(reportDir, "report.json"))
	if readErr != nil {
		if !errors.Is(readErr, os.ErrNotExist) {
			return []Check{FailCheck(name, start, fmt.Sprintf("reading chainsaw report: %v", readErr))}
		}
		tail := tailLines(stderr, maxFindings)
		if len(tail) == 0 {
			tail = tailLines(stdout, maxFindings)
		}
		if runErr != nil {
			return []Check{FailCheck(name, start, fmt.Sprintf("chainsaw exited with %v and wrote no report", runErr), tail...)}
		}
		return []Check{FailCheck(name, start, "chainsaw exited 0 but wrote no report", tail...)}
	}

	var report chainsawReport
	if err := json.Unmarshal(raw, &report); err != nil {
		return []Check{FailCheck(name, start, fmt.Sprintf("parsing chainsaw report: %v", err))}
	}
	if len(report.Tests) == 0 {
		return []Check{FailCheck(name, start, fmt.Sprintf("chainsaw found no tests in %s", e2eDir))}
	}

	checks := make([]Check, 0, len(report.Tests))
	for _, test := range report.Tests {
		checks = append(checks, chainsawTestCheck(test))
	}
	sort.SliceStable(checks, func(i, j int) bool { return checks[i].Name < checks[j].Name })
	return checks
}

// chainsawTestCheck converts one report entry into a check. Duration comes
// from the report timestamps, so it reflects the test rather than the whole
// suite.
func chainsawTestCheck(test chainsawTest) Check {
	name := "e2e/" + test.Name
	duration := int64(0)
	if !test.StartTime.IsZero() && !test.EndTime.IsZero() {
		duration = test.EndTime.Sub(test.StartTime).Milliseconds()
	}

	failedSteps := 0
	var findings []string
	for _, step := range test.Steps {
		if step.Status == "passed" {
			continue
		}
		failedSteps++
		described := false
		for _, op := range step.Operations {
			if op.Status == "passed" {
				continue
			}
			msg := op.Status
			if op.Failure != nil && op.Failure.Error != "" {
				msg = op.Failure.Error
			}
			findings = append(findings, fmt.Sprintf("%s: %s (%s): %s", step.Name, op.Type, op.Name, msg))
			described = true
		}
		if !described {
			findings = append(findings, fmt.Sprintf("%s: %s", step.Name, step.Status))
		}
	}

	if test.Status == "passed" {
		return Check{Name: name, Status: StatusPass, DurationMS: duration, Detail: fmt.Sprintf("%d step(s) passed", len(test.Steps))}
	}
	detail := fmt.Sprintf("%d of %d step(s) failed", failedSteps, len(test.Steps))
	if failedSteps == 0 {
		detail = fmt.Sprintf("test %s", test.Status)
	}
	return Check{Name: name, Status: StatusFail, DurationMS: duration, Detail: detail, Findings: capLines(findings)}
}

// unreachableMarkers are the kubectl stderr phrases that mean the API server
// could not be reached at all, as opposed to rejecting a request.
var unreachableMarkers = []string{
	"connection refused",
	"was refused",
	"no such host",
	"Unable to connect to the server",
}

// isClusterUnreachable reports whether kubectl's stderr describes a cluster
// that cannot be reached: the connection failed, the host does not resolve,
// or the requested kube context is not in the kubeconfig.
func isClusterUnreachable(stderr []byte) bool {
	s := string(stderr)
	for _, marker := range unreachableMarkers {
		if strings.Contains(s, marker) {
			return true
		}
	}
	return strings.Contains(s, "context \"") && strings.Contains(s, "does not exist")
}

// clusterUnreachableCheck builds the single failure emitted when the Kind
// cluster is down or the context is missing.
func clusterUnreachableCheck(name string, start time.Time, kubeContext string, stderr []byte) Check {
	detail := fmt.Sprintf("cluster unreachable via kube context %s", kubeContext)
	findings := capLines(nonEmptyLines(stderr))
	findings = append(findings, "start the Kind cluster with `task localdev:up` (or pass --kube-context)")
	return FailCheck(name, start, detail, findings...)
}

// hasYAMLDocument reports whether raw contains at least one YAML document
// with content: a line that is not blank, a comment or a `---` separator.
func hasYAMLDocument(raw []byte) bool {
	for _, line := range strings.Split(string(raw), "\n") {
		t := strings.TrimSpace(line)
		if t == "" || t == "---" || t == "..." || strings.HasPrefix(t, "#") {
			continue
		}
		return true
	}
	return false
}

// nonEmptyLines splits output into trimmed, non-blank lines.
func nonEmptyLines(b []byte) []string {
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		if t := strings.TrimRight(line, " \t\r"); strings.TrimSpace(t) != "" {
			out = append(out, t)
		}
	}
	return out
}

// tailLines returns the last n non-empty lines of output.
func tailLines(b []byte, n int) []string {
	lines := nonEmptyLines(b)
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

// capLines truncates findings to maxFindings entries.
func capLines(lines []string) []string {
	if len(lines) > maxFindings {
		return lines[:maxFindings]
	}
	return lines
}

// fileExists reports whether path is an existing regular file.
func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
