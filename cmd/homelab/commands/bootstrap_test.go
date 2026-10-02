package commands

import (
	"errors"
	"strings"
	"testing"
)

// withConfirm swaps the confirmation seam for the duration of a test.
func withConfirm(t *testing.T, answer func(string) bool) {
	t.Helper()
	prev := confirmFn
	confirmFn = answer
	t.Cleanup(func() { confirmFn = prev })
}

// withDryRun sets the package-level --dry-run flag for the duration of a test.
func withDryRun(t *testing.T, v bool) {
	t.Helper()
	prev := DryRun
	DryRun = v
	t.Cleanup(func() { DryRun = prev })
}

func alwaysYes(string) bool { return true }
func alwaysNo(string) bool  { return false }

// A failing phase must stop the bring-up. This is the regression that mattered:
// `task tf:apply` used to fail, log a warning, fall through, and finish on
// "Setup complete!" — telling a fork its infrastructure was provisioned when it
// was not.
func TestRunPhasesStopsAtFirstFailure(t *testing.T) {
	withConfirm(t, alwaysYes)
	withDryRun(t, false)

	ran := []string{}
	boom := errors.New("exit status 1")

	_, err := runPhases([]phase{
		{name: "first", component: "ansible", run: func() error { ran = append(ran, "first"); return nil }},
		{name: "second", component: "terragrunt", run: func() error { ran = append(ran, "second"); return boom }},
		{name: "third", component: "argocd", run: func() error { ran = append(ran, "third"); return nil }},
	})

	if err == nil {
		t.Fatal("expected an error when a phase fails, got nil")
	}
	if !errors.Is(err, boom) {
		t.Errorf("error should wrap the phase error, got %v", err)
	}
	// The failure must name the component, not the step number, so the last
	// line an operator reads tells them what to fix.
	if !strings.Contains(err.Error(), "terragrunt") {
		t.Errorf("error should name the failing component, got %q", err)
	}
	if strings.Join(ran, ",") != "first,second" {
		t.Errorf("phases after the failure must not run, ran %v", ran)
	}
}

// Declining an optional phase is a legitimate operator choice: it is recorded
// and reported, and the remaining phases still run.
func TestRunPhasesRecordsDeclinedOptionalPhase(t *testing.T) {
	withDryRun(t, false)
	withConfirm(t, func(msg string) bool { return !strings.Contains(msg, "Ansible") })

	ran := []string{}
	skipped, err := runPhases([]phase{
		{
			name: "config", component: "ansible", confirm: "Run Ansible to configure Proxmox?",
			run: func() error { ran = append(ran, "ansible"); return nil }, fixHint: "task ansible:apply",
		},
		{
			name: "provision", component: "terragrunt", confirm: "Run Terragrunt?",
			run: func() error { ran = append(ran, "terragrunt"); return nil }, fixHint: "task tf:apply ENV=homelab",
		},
	})

	if err != nil {
		t.Fatalf("declining an optional phase must not fail the run: %v", err)
	}
	if strings.Join(skipped, ",") != "ansible" {
		t.Errorf("skipped should record the declined component, got %v", skipped)
	}
	if strings.Join(ran, ",") != "terragrunt" {
		t.Errorf("the declined phase must not run and later phases must, ran %v", ran)
	}
}

// The Proxmox gate has nothing to execute and nothing after it can mean
// anything without it, so declining it aborts rather than skips.
func TestRunPhasesRequiredConfirmAborts(t *testing.T) {
	withDryRun(t, false)
	withConfirm(t, alwaysNo)

	ran := false
	skipped, err := runPhases([]phase{
		{
			name: "Proxmox installation", component: "proxmox",
			confirm: "Has Proxmox been installed and is it accessible?", confirmRequired: true,
			fixHint: "Install Proxmox first",
		},
		{name: "provision", component: "terragrunt", run: func() error { ran = true; return nil }},
	})

	if err == nil {
		t.Fatal("declining a required confirmation must abort")
	}
	if !strings.Contains(err.Error(), "proxmox") {
		t.Errorf("error should name the component, got %q", err)
	}
	if ran {
		t.Error("phases after a declined required gate must not run")
	}
	if len(skipped) != 0 {
		t.Errorf("an aborted required gate is not a skip, got %v", skipped)
	}
}

// --dry-run must walk every phase to print the resolved order. utils.Confirm
// answers no under DryRun, so prompting would abort the walk at the first gate
// and print nothing about the phases behind it.
func TestRunPhasesDryRunWalksEveryPhaseWithoutPrompting(t *testing.T) {
	withDryRun(t, true)

	prompted := false
	withConfirm(t, func(string) bool { prompted = true; return false })

	seen := 0
	skipped, err := runPhases([]phase{
		{name: "gate", component: "proxmox", confirm: "Installed?", confirmRequired: true, fixHint: "install it"},
		{name: "config", component: "ansible", confirm: "Run Ansible?", run: func() error { seen++; return nil }, fixHint: "task ansible:apply"},
		{name: "provision", component: "terragrunt", confirm: "Run Terragrunt?", run: func() error { seen++; return nil }, fixHint: "task tf:apply ENV=homelab"},
	})

	if err != nil {
		t.Fatalf("--dry-run must not fail: %v", err)
	}
	if prompted {
		t.Error("--dry-run must not prompt")
	}
	if len(skipped) != 0 {
		t.Errorf("--dry-run skips nothing, got %v", skipped)
	}
	// The run funcs are reached, but runTask/utils.ExecCommand no-op under
	// DryRun, so walking them mutates nothing.
	if seen != 2 {
		t.Errorf("every phase with work should be walked, saw %d of 2", seen)
	}
}

// Every phase an operator can skip or that can fail must hand back a command,
// so no exit from bootstrap leaves them without a next step.
func TestProductionPhasesAlwaysOfferANextCommand(t *testing.T) {
	withDryRun(t, false)
	withConfirm(t, alwaysYes)

	for _, p := range homelabPhases() {
		if p.confirm == "" && p.run == nil {
			continue // informational phase, nothing to recover from
		}
		if p.fixHint == "" {
			t.Errorf("phase %q (%s) can be skipped or fail but offers no fixHint", p.name, p.component)
		}
		if p.component == "" {
			t.Errorf("phase %q has no component to name on failure", p.name)
		}
	}
}
