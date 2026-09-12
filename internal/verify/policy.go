package verify

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// conftestFailure is one Rego deny/violation message from `conftest test -o json`.
type conftestFailure struct {
	Msg string `json:"msg"`
}

// conftestResult is one element of `conftest test -o json`'s top-level array:
// one entry per (file, namespace) pair conftest evaluated.
type conftestResult struct {
	Filename  string            `json:"filename"`
	Namespace string            `json:"namespace"`
	Successes int               `json:"successes"`
	Failures  []conftestFailure `json:"failures"`
}

// Policy runs the tests/policy Rego policies (via conftest) against every
// rendered manifest for each env, producing one "policy/<env>" Check.
//
// It expects the renderer to have already written <renderDir>/<env>/*.yaml
// (one file per chart) plus <renderDir>/<env>/_data.yaml (env, domain,
// kubernetes_version), matching RenderedFile/LoadRenderDir's layout. Files
// starting with "_" are metadata, not rendered manifests, and are excluded
// from the file list passed to conftest.
func Policy(ctx context.Context, r Runner, renderDir, policyDir string, envs []Env) []Check {
	var checks []Check
	for _, env := range envs {
		checks = append(checks, policyForEnv(ctx, r, renderDir, policyDir, env))
	}
	return checks
}

func policyForEnv(ctx context.Context, r Runner, renderDir, policyDir string, env Env) Check {
	start := time.Now()
	name := "policy/" + env.Name

	if _, err := r.LookPath("conftest"); err != nil {
		return FailCheck(name, start, ToolMissingDetail("conftest"))
	}

	envDir := filepath.Join(renderDir, env.Name)
	files, err := manifestFiles(envDir)
	if err != nil {
		return FailCheck(name, start, fmt.Sprintf("listing rendered manifests in %s: %v", envDir, err))
	}
	if len(files) == 0 {
		return FailCheck(name, start, fmt.Sprintf("no rendered manifests found in %s", envDir))
	}

	dataFile := filepath.Join(envDir, "_data.yaml")

	args := []string{
		"test",
		"-p", policyDir,
		"--all-namespaces",
		"--data", dataFile,
		"-o", "json",
	}
	args = append(args, files...)

	stdout, stderr, runErr := r.Run(ctx, ".", "conftest", args...)

	var results []conftestResult
	if jsonErr := json.Unmarshal(stdout, &results); jsonErr != nil {
		// conftest test exits non-zero both when policies fail (expected --
		// that's what we're checking for) and when it can't run at all
		// (bad Rego, missing --data file, etc). Only the latter produces
		// non-JSON stdout, so that's the real error case.
		detail := strings.TrimSpace(string(stderr))
		if detail == "" {
			detail = strings.TrimSpace(string(stdout))
		}
		if detail == "" && runErr != nil {
			detail = runErr.Error()
		}
		return FailCheck(name, start, fmt.Sprintf("conftest test failed to run: %s", detail))
	}

	var findings []string
	for _, res := range results {
		base := filepath.Base(res.Filename)
		for _, f := range res.Failures {
			findings = append(findings, fmt.Sprintf("%s: %s", base, f.Msg))
		}
	}
	sort.Strings(findings)

	if len(findings) > 0 {
		return FailCheck(name, start, fmt.Sprintf("%d policy violation(s) across %d file(s)", len(findings), len(files)), findings...)
	}
	return PassCheck(name, start, fmt.Sprintf("%d file(s), 0 policy violations", len(files)))
}

// manifestFiles lists the rendered *.yaml files in dir, excluding metadata
// files (those starting with "_"), sorted for deterministic conftest output.
func manifestFiles(dir string) ([]string, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return nil, err
	}
	var out []string
	for _, m := range matches {
		if strings.HasPrefix(filepath.Base(m), "_") {
			continue
		}
		out = append(out, m)
	}
	sort.Strings(out)
	return out, nil
}
