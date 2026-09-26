package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// VerifyWorkflowPath is the workflow that carries the merge-result level-0 job.
const VerifyWorkflowPath = ".github/workflows/verify.yml"

// Level0JobID is the job key this file guards, and Level0ContextName is the
// `name:` GitHub publishes for it — which is the exact string `main`'s required
// status checks name (ADR-039, MCAA-164). The two are checked together because
// a required context is matched by that string: rename the job and the context
// does not go red, it goes *absent*, and GitHub leaves a required context that
// never reports pending forever.
const (
	Level0JobID       = "level-0"
	Level0ContextName = "Level 0 (render, schema, gitops, snapshot, policy)"
)

// checkoutAction is the action whose *absence of a ref* is the property this
// file exists to protect.
const checkoutAction = "actions/checkout"

// MergeResultGate is the level-0 gate on the level-0 gate: it asserts that
// `.github/workflows/verify.yml` still describes a **merge-result** check rather
// than a head-only one.
//
// Two absences make that true, and both of them are invisible:
//
//  1. The level-0 job's `actions/checkout` step has no `with: ref:`. A bare
//     checkout on a `pull_request` event checks out `refs/pull/N/merge` — the
//     merge result. Adding `ref: ${{ github.event.pull_request.head.sha }}`
//     silently demotes the job to a head gate. It is a normal-looking edit:
//     pr-contract.yml's `claim` job pins exactly that ref two files over, so
//     copying it reads as consistency rather than as a regression.
//
//  2. The `pull_request` trigger has no `paths:` filter, so the job runs on
//     every pull request. A job skipped by a job-level `if:` still publishes a
//     `skipped` check run, which *satisfies* a required context; a workflow
//     filtered out by `paths:` publishes no check run at all, and a required
//     context that never reports leaves the pull request pending forever.
//
// Neither absence can be seen in a diff review and neither turns anything red
// on its own: reintroduce the ref pin and **every check stays green** while the
// gate stops seeing merge-result-only failures (the ADR-number collision of
// ADR-039 is the clearest case — two branches each append "the next ADR number",
// both are green on their own head, and the collision exists only in the merge).
// `#403` wrote the `paths:` half of this as a comment above the trigger and
// MCAA-203 added the `ref:` half; a comment is documentation, not enforcement,
// so the same two properties are asserted here where a machine reads them.
//
// Known bound, stated rather than implied: this reads the `uses:`/`with:` pair.
// A `run:` step that does its own `git fetch && git checkout <head sha>` would
// defeat the gate the same way and is not detected. The ref pin is the edit that
// has actually been proposed; an open-coded checkout is not a plausible accident.
//
// The emergency path is in docs/runbooks/verification.md: these checks read the
// repository, so there is no per-file exemption annotation. Deliberate change to
// the gate's design means moving the constants above in the same commit as an
// ADR; a genuine emergency merge means the repository owner merging past the
// required check with the reason in the merging issue.
func MergeResultGate(repoRoot string) []Check {
	start := time.Now()
	path := filepath.Join(repoRoot, filepath.FromSlash(VerifyWorkflowPath))
	data, err := os.ReadFile(path)
	if err != nil {
		return []Check{FailCheck(gateFloorCheck, start, "reading "+VerifyWorkflowPath, err.Error())}
	}
	gate, err := ParseMergeResultGate(data)
	if err != nil {
		return []Check{FailCheck(gateFloorCheck, start, floorDetail, err.Error())}
	}
	return gate.checks(start)
}

// The three rule ids. gateFloorCheck is the floor: it answers "did this parse
// find the job at all", and it is emitted *instead of* the other two whenever
// the answer is no. Without it a renamed job, an empty `steps:` list or a
// missing `on: pull_request:` would make both rules below vacuously true and the
// gate would report a confident green for a file it never looked into — the same
// failure mode decisions/adr-record exists to prevent.
const (
	gateFloorCheck = "workflows/merge-result-gate"
	gateRefCheck   = "workflows/level0-merge-ref"
	gatePathsCheck = "workflows/level0-pull-request-paths"
)

const floorDetail = "the level-0 job could not be located in " + VerifyWorkflowPath + ", so neither `" +
	gateRefCheck + "` nor `" + gatePathsCheck + "` can be answered. A green from a parse that found no job proves nothing."

// CheckoutStep is one `uses: actions/checkout@…` step of the level-0 job.
type CheckoutStep struct {
	// Step is the 1-based position in the job's `steps:` list.
	Step int
	// Line is the 1-based line of the `uses:` scalar.
	Line int
	// Ref is the `with: ref:` value, empty when the step has none. Empty is the
	// correct, load-bearing state.
	Ref string
	// RefLine is the 1-based line of the `ref:` scalar, 0 when absent.
	RefLine int
}

// PathFilter is a `paths:`/`paths-ignore:` key found under the `pull_request`
// trigger.
type PathFilter struct {
	// Key is "paths" or "paths-ignore".
	Key string
	// Line is the 1-based line of the key.
	Line int
}

// MergeResultGateFile is what the guard needs from verify.yml.
type MergeResultGateFile struct {
	// JobName is the level-0 job's `name:` — the published check-run name.
	JobName string
	// Checkouts are the level-0 job's actions/checkout steps, in file order.
	Checkouts []CheckoutStep
	// PullRequestFilters are the path filters on the `pull_request` trigger.
	// Empty is the correct state.
	PullRequestFilters []PathFilter
}

// ParseMergeResultGate extracts the level-0 job's checkout steps and the
// `pull_request` trigger's path filters from a workflow file.
//
// Every "the file does not look like the gate" condition is an error, never a
// zero-valued result: a nil `jobs:` map, a missing `level-0` key, a job name
// that is not the required context string, a job with no actions/checkout step,
// and a missing `on: pull_request:` key all mean the guard is no longer pointed
// at the thing it guards, which must be red rather than silently vacuous.
func ParseMergeResultGate(data []byte) (*MergeResultGateFile, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", VerifyWorkflowPath, err)
	}
	root := documentRoot(&doc)
	if root == nil || root.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s is not a YAML mapping", VerifyWorkflowPath)
	}

	jobs := mapValue(root, "jobs")
	if jobs == nil || jobs.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s has no `jobs:` mapping", VerifyWorkflowPath)
	}
	job := mapValue(jobs, Level0JobID)
	if job == nil || job.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s has no `jobs.%s:` job — the merge-result gate is matched by that key and by its `name:`", VerifyWorkflowPath, Level0JobID)
	}

	gate := &MergeResultGateFile{}
	if name := mapValue(job, "name"); name != nil {
		gate.JobName = name.Value
	}
	if gate.JobName != Level0ContextName {
		return nil, fmt.Errorf(
			"%s `jobs.%s.name` is %q, expected %q — that string is the required status check on main, so renaming the job makes the required context *absent* (pending forever) rather than red",
			VerifyWorkflowPath, Level0JobID, gate.JobName, Level0ContextName)
	}

	steps := mapValue(job, "steps")
	if steps == nil || steps.Kind != yaml.SequenceNode || len(steps.Content) == 0 {
		return nil, fmt.Errorf("%s `jobs.%s.steps` is empty or not a sequence", VerifyWorkflowPath, Level0JobID)
	}
	for i, step := range steps.Content {
		if step.Kind != yaml.MappingNode {
			continue
		}
		uses := mapValue(step, "uses")
		if uses == nil || !isCheckoutAction(uses.Value) {
			continue
		}
		found := CheckoutStep{Step: i + 1, Line: uses.Line}
		if ref := mapValue(mapValue(step, "with"), "ref"); ref != nil {
			found.Ref = ref.Value
			found.RefLine = ref.Line
		}
		gate.Checkouts = append(gate.Checkouts, found)
	}
	if len(gate.Checkouts) == 0 {
		return nil, fmt.Errorf(
			"%s `jobs.%s` has no `uses: %s@…` step — this guard reads that step's `with: ref:`, so it cannot answer anything about a job that checks the repository out some other way",
			VerifyWorkflowPath, Level0JobID, checkoutAction)
	}

	// `on` is a plain string key under gopkg.in/yaml.v3 (measured: the key node
	// comes back with tag !!str), not the YAML 1.1 boolean the name suggests.
	// A miss is an error rather than "no filters found", so a parser that ever
	// resolved it differently would fail this gate loudly instead of turning
	// gatePathsCheck into a green that checks nothing.
	on := mapValue(root, "on")
	if on == nil || on.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s has no `on:` trigger mapping", VerifyWorkflowPath)
	}
	pr := mapValue(on, "pull_request")
	if pr == nil {
		return nil, fmt.Errorf(
			"%s has no `on.pull_request` trigger — the level-0 job is the merge-result gate, and only a `pull_request` event produces a `refs/pull/N/merge` ref to check out",
			VerifyWorkflowPath)
	}
	// `pull_request:` with no body is the correct, most common form; it parses
	// as a null node and carries no filters.
	if pr.Kind == yaml.MappingNode {
		for _, key := range []string{"paths", "paths-ignore"} {
			if f := mapValue(pr, key); f != nil {
				gate.PullRequestFilters = append(gate.PullRequestFilters, PathFilter{Key: key, Line: f.Line})
			}
		}
	}
	return gate, nil
}

// checks turns a parsed gate into the two assertions plus a passing floor.
func (g *MergeResultGateFile) checks(start time.Time) []Check {
	floor := PassCheck(gateFloorCheck, start, fmt.Sprintf(
		"%s `jobs.%s` is %q with %d actions/checkout step(s) on a `pull_request` trigger",
		VerifyWorkflowPath, Level0JobID, g.JobName, len(g.Checkouts)))

	ref := PassCheck(gateRefCheck, start, fmt.Sprintf(
		"every actions/checkout step in `jobs.%s` is bare, so the job runs against refs/pull/N/merge", Level0JobID))
	var pinned []string
	for _, c := range g.Checkouts {
		if c.Ref == "" {
			continue
		}
		pinned = append(pinned, fmt.Sprintf(
			"%s:%d: step %d pins `ref: %s` (checkout at line %d)",
			VerifyWorkflowPath, c.RefLine, c.Step, c.Ref, c.Line))
	}
	if len(pinned) > 0 {
		ref = FailCheck(gateRefCheck, start,
			"the level-0 job's actions/checkout step must stay bare. A bare checkout on a `pull_request` event checks out `refs/pull/N/merge`, which is what makes this job the merge-result gate in main's required contexts (ADR-039, MCAA-164); pinning `ref:` demotes it to a head gate with every check still green, and a failure that exists only in the merge result — an ADR-number collision is the clearest case — becomes invisible again. Delete the `with: ref:` block. If you copied it from pr-contract.yml's `claim` job: that job is *deliberately* head-pinned and this one is deliberately not, which is why both exist.",
			pinned...)
	}

	paths := PassCheck(gatePathsCheck, start,
		"the `pull_request` trigger has no paths filter, so the level-0 check run is published on every pull request")
	if len(g.PullRequestFilters) > 0 {
		findings := make([]string, 0, len(g.PullRequestFilters))
		for _, f := range g.PullRequestFilters {
			findings = append(findings, fmt.Sprintf("%s:%d: `on.pull_request.%s` is set", VerifyWorkflowPath, f.Line, f.Key))
		}
		paths = FailCheck(gatePathsCheck, start,
			"the `pull_request` trigger must have no paths filter while the level-0 job is a required context. A job skipped by a job-level `if:` still publishes a `skipped` check run, which satisfies the requirement; a workflow filtered out by `paths:` publishes no check run at all, and GitHub leaves a required context that never runs *pending forever* instead of treating it as satisfied. Use a job-level `if:` if you need an exemption, never a paths filter.",
			findings...)
	}
	return []Check{floor, ref, paths}
}

// isCheckoutAction reports whether a `uses:` value names actions/checkout, at
// any pin. The version is deliberately not checked here: this guard is about the
// absence of a ref, and the action pin is Renovate's business.
func isCheckoutAction(uses string) bool {
	name, _, _ := strings.Cut(uses, "@")
	return strings.TrimSpace(name) == checkoutAction
}

// documentRoot unwraps the document node yaml.Unmarshal puts at the top.
func documentRoot(n *yaml.Node) *yaml.Node {
	if n == nil {
		return nil
	}
	if n.Kind == yaml.DocumentNode {
		if len(n.Content) == 0 {
			return nil
		}
		return n.Content[0]
	}
	return n
}

// mapValue returns the value node for a key of a mapping, or nil. It tolerates a
// nil or non-mapping receiver so callers can chain (`mapValue(mapValue(step,
// "with"), "ref")`) without a nil check at every level.
func mapValue(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}
