// Package verify implements cluster-free (level 0) verification of the GitOps
// repository: chart rendering, schema validation, GitOps graph linting,
// snapshots and policy. Every check produces a Check; commands aggregate
// them into a Result that is emitted as JSON for autonomous agents.
package verify

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// Status is the outcome of a single check.
type Status string

const (
	StatusPass Status = "pass"
	StatusFail Status = "fail"
	StatusSkip Status = "skip"
)

// Check is one verification unit (e.g. "render/homelab/addons").
type Check struct {
	Name       string   `json:"name"`
	Status     Status   `json:"status"`
	DurationMS int64    `json:"duration_ms"`
	Detail     string   `json:"detail,omitempty"`
	Findings   []string `json:"findings,omitempty"`
}

// Result is the machine-readable summary contract:
// {"level":0,"checks":[...],"pass":bool,"duration_ms":N}
type Result struct {
	Level      int     `json:"level"`
	Checks     []Check `json:"checks"`
	Pass       bool    `json:"pass"`
	DurationMS int64   `json:"duration_ms"`
}

// NewResult creates an empty result for the given level.
func NewResult(level int) *Result {
	return &Result{Level: level, Checks: []Check{}, Pass: true}
}

// Add appends checks and updates Pass.
func (r *Result) Add(checks ...Check) {
	for _, c := range checks {
		r.Checks = append(r.Checks, c)
		if c.Status == StatusFail {
			r.Pass = false
		}
	}
}

// Merge folds another result's checks into r.
func (r *Result) Merge(other *Result) {
	if other == nil {
		return
	}
	r.Add(other.Checks...)
}

// Finalize sorts checks by name for deterministic output and records duration.
func (r *Result) Finalize(start time.Time) {
	sort.SliceStable(r.Checks, func(i, j int) bool { return r.Checks[i].Name < r.Checks[j].Name })
	r.DurationMS = time.Since(start).Milliseconds()
}

// JSON renders the result as indented JSON.
func (r *Result) JSON() ([]byte, error) {
	return json.MarshalIndent(r, "", "  ")
}

// Counts returns pass/fail/skip totals.
func (r *Result) Counts() (pass, fail, skip int) {
	for _, c := range r.Checks {
		switch c.Status {
		case StatusPass:
			pass++
		case StatusFail:
			fail++
		case StatusSkip:
			skip++
		}
	}
	return
}

// WriteText renders a human-readable summary (failures first, with findings).
func (r *Result) WriteText(w io.Writer) {
	for _, c := range r.Checks {
		if c.Status != StatusFail {
			continue
		}
		fmt.Fprintf(w, "[FAIL] %s (%dms)\n", c.Name, c.DurationMS)
		if c.Detail != "" {
			fmt.Fprintf(w, "       %s\n", c.Detail)
		}
		for _, f := range c.Findings {
			fmt.Fprintf(w, "       - %s\n", f)
		}
	}
	for _, c := range r.Checks {
		if c.Status == StatusSkip {
			fmt.Fprintf(w, "[SKIP] %s: %s\n", c.Name, c.Detail)
		}
	}
	// Passing checks that skipped part of their input disclose it in Detail;
	// surface those so text-mode readers see what was not checked.
	for _, c := range r.Checks {
		if c.Status == StatusPass && strings.Contains(c.Detail, "skipped") && !strings.Contains(c.Detail, " 0 skipped") {
			fmt.Fprintf(w, "[INFO] %s: %s\n", c.Name, c.Detail)
		}
	}
	pass, fail, skip := r.Counts()
	verdict := "PASS"
	if !r.Pass {
		verdict = "FAIL"
	}
	fmt.Fprintf(w, "level %d: %s (%d passed, %d failed, %d skipped, %dms)\n", r.Level, verdict, pass, fail, skip, r.DurationMS)
}

// PassCheck builds a passing check.
func PassCheck(name string, start time.Time, detail string) Check {
	return Check{Name: name, Status: StatusPass, DurationMS: time.Since(start).Milliseconds(), Detail: detail}
}

// FailCheck builds a failing check with findings.
func FailCheck(name string, start time.Time, detail string, findings ...string) Check {
	return Check{Name: name, Status: StatusFail, DurationMS: time.Since(start).Milliseconds(), Detail: detail, Findings: findings}
}

// SkipCheck builds a skipped check (tool missing, not applicable).
func SkipCheck(name, detail string) Check {
	return Check{Name: name, Status: StatusSkip, Detail: detail}
}

// Env is a verification environment. Level 0 renders every chart for each Env.
type Env struct {
	// Name is the environment identifier and the values-file suffix
	// (values-<Name>.yaml). "localdev" or "homelab".
	Name string
	// ConfigSet is the value passed to `homelab config export --set`.
	ConfigSet string
	// EnvFile, relative to the repo root, overrides
	// configuration/environments/<ConfigSet>.yaml. The homelab env MUST use
	// the PII-free example file so level 0 never touches real values.
	EnvFile string
	// TwoStage selects config-export -> helm template for the addons and
	// applications parents (mirrors the CMP). When false those parents render
	// with values.yaml + values-<Name>.yaml (mirrors plain-Helm ArgoCD mode).
	TwoStage bool
}

// Envs lists the level-0 environments in render order.
var Envs = []Env{
	{Name: "localdev", ConfigSet: "localdev", EnvFile: "configuration/environments/localdev.yaml", TwoStage: false},
	{Name: "homelab", ConfigSet: "homelab", EnvFile: "configuration/environments/homelab.yaml.example", TwoStage: true},
}

// EnvByName looks up an Env.
func EnvByName(name string) (Env, bool) {
	for _, e := range Envs {
		if e.Name == name {
			return e, true
		}
	}
	return Env{}, false
}

// ParseEnvs converts a comma-separated list ("" => all) into Envs.
func ParseEnvs(list string) ([]Env, error) {
	if list == "" || list == "all" {
		return Envs, nil
	}
	var out []Env
	for _, n := range splitComma(list) {
		e, ok := EnvByName(n)
		if !ok {
			return nil, fmt.Errorf("unknown environment %q (want one of localdev, homelab)", n)
		}
		out = append(out, e)
	}
	return out, nil
}
