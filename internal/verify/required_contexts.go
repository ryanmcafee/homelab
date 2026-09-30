package verify

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const requiredContextsPath = "docs/contracts/required-status-checks.yaml"

type requiredContext struct {
	Name     string `yaml:"name"`
	Workflow string `yaml:"workflow"`
	Job      string `yaml:"job"`
}

type requiredContextList struct {
	Required []requiredContext `yaml:"required"`
}

type workflowGate struct {
	On   map[string]yaml.Node `yaml:"on"`
	Jobs map[string]struct {
		Name string `yaml:"name"`
		If   string `yaml:"if"`
	} `yaml:"jobs"`
}

// RequiredContexts keeps the documented branch-protection jobs reachable on
// every pull request. The author-claim condition is an exact ADR-032 exception;
// all other required jobs must have no job-level condition.
func RequiredContexts(repoRoot string) Check {
	start := time.Now()
	data, err := os.ReadFile(filepath.Join(repoRoot, requiredContextsPath))
	if err != nil {
		return FailCheck("verify/required-contexts", start, "read the documented required-context list", err.Error())
	}
	var list requiredContextList
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(&list); err != nil {
		return FailCheck("verify/required-contexts", start, "parse the documented required-context list", err.Error())
	}
	if len(list.Required) == 0 {
		return FailCheck("verify/required-contexts", start, "required-context list is empty; declare the live main branch-protection jobs in "+requiredContextsPath)
	}
	var findings []string
	seen := map[string]bool{}
	for _, required := range list.Required {
		if required.Name == "" || required.Workflow == "" || required.Job == "" {
			findings = append(findings, "required context needs name, workflow and job")
			continue
		}
		if seen[required.Name] {
			findings = append(findings, fmt.Sprintf("duplicate required context %q", required.Name))
			continue
		}
		seen[required.Name] = true
		if filepath.Base(required.Workflow) != required.Workflow || !strings.HasSuffix(required.Workflow, ".yml") {
			findings = append(findings, fmt.Sprintf("%q: workflow must be a .github/workflows/*.yml filename", required.Name))
			continue
		}
		path := filepath.Join(repoRoot, ".github", "workflows", required.Workflow)
		data, err := os.ReadFile(path)
		if err != nil {
			findings = append(findings, fmt.Sprintf("%q: read %s: %v", required.Name, required.Workflow, err))
			continue
		}
		var workflow workflowGate
		if err := yaml.Unmarshal(data, &workflow); err != nil {
			findings = append(findings, fmt.Sprintf("%q: parse %s: %v", required.Name, required.Workflow, err))
			continue
		}
		trigger, ok := workflow.On["pull_request"]
		if !ok {
			findings = append(findings, fmt.Sprintf("%q: %s has no pull_request trigger", required.Name, required.Workflow))
		} else if trigger.Kind == yaml.MappingNode {
			for i := 0; i+1 < len(trigger.Content); i += 2 {
				if trigger.Content[i].Value == "paths" || trigger.Content[i].Value == "paths-ignore" {
					findings = append(findings, fmt.Sprintf("%q: %s pull_request has %s filter; remove it so the required check runs on every PR", required.Name, required.Workflow, trigger.Content[i].Value))
				}
			}
		}
		job, ok := workflow.Jobs[required.Job]
		if !ok {
			findings = append(findings, fmt.Sprintf("%q: %s has no job %q", required.Name, required.Workflow, required.Job))
			continue
		}
		if job.Name != required.Name {
			findings = append(findings, fmt.Sprintf("%q: %s job %q publishes name %q", required.Name, required.Workflow, required.Job, job.Name))
		}
		allowedIf := ""
		if required.Name == "Verification claim matches level 0" && required.Workflow == "pr-contract.yml" && required.Job == "claim" {
			// This one author-claim job deliberately skips drafts and Renovate.
			// Keep the exception fixed in code so the documented list cannot
			// silently widen it to an arbitrary condition.
			allowedIf = "github.event_name == 'merge_group' || (github.event.pull_request.draft == false\n    && !startsWith(github.head_ref, 'renovate/'))"
		}
		if job.If != allowedIf {
			findings = append(findings, fmt.Sprintf("%q: %s job %q has unexpected job-level if %q; remove it or restore the documented ADR-032 exemption", required.Name, required.Workflow, required.Job, job.If))
		}
	}
	if len(findings) > 0 {
		return FailCheck("verify/required-contexts", start, "required checks must publish on every PR", findings...)
	}
	return PassCheck("verify/required-contexts", start, fmt.Sprintf("%d documented required contexts match reachable workflow jobs", len(list.Required)))
}
