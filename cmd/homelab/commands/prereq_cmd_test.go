package commands

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ryanmcafee/homelab/internal/prereq"
	"github.com/spf13/cobra"
)

// stubEnv answers every prereq probe from a fixed set of failures.
type stubEnv struct {
	missing map[string]bool
	runErr  map[string]error
}

func (s stubEnv) LookPath(name string) (string, error) {
	if s.missing[name] {
		return "", errors.New("not found: " + name)
	}
	return "/bin/" + name, nil
}
func (s stubEnv) Dial(string, string, time.Duration) error { return nil }
func (s stubEnv) Stat(string) (os.FileInfo, error)         { return nil, nil }
func (s stubEnv) Run(name string, _ ...string) (string, error) {
	if err, ok := s.runErr[name]; ok {
		return "", err
	}
	return "", nil
}

// swapPrereqEnv installs env for one test and restores the real one after.
func swapPrereqEnv(t *testing.T, env prereq.Env) {
	t.Helper()
	old := prereqEnv
	prereqEnv = env
	t.Cleanup(func() { prereqEnv = old })
}

func runPrereqCommand(t *testing.T, args ...string) (error, string) {
	t.Helper()
	root := &cobra.Command{Use: "homelab", SilenceUsage: true, SilenceErrors: true}
	root.SetFlagErrorFunc(UsageErrorFunc)
	root.PersistentFlags().BoolVar(&DryRun, "dry-run", false, "")
	root.PersistentFlags().BoolVarP(&AutoAccept, "yes", "y", false, "")
	root.AddCommand(NewValidateCmd())
	root.AddCommand(NewBootstrapCmd())

	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs(args)
	t.Cleanup(func() { DryRun = false; AutoAccept = false })
	return root.ExecuteContext(context.Background()), out.String()
}

// hasRow reports whether the table has a "✔ name" or "✘ name" line.
func hasRow(printed, name string) bool {
	for _, line := range strings.Split(printed, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && (fields[0] == markPass || fields[0] == markFail) && fields[1] == name {
			return true
		}
	}
	return false
}

func TestValidateTable(t *testing.T) {
	tests := []struct {
		name        string
		args        []string
		env         prereq.Env
		wantCode    int
		wantRows    []string
		wantNoRows  []string
		wantMark    string
		wantHint    string
		wantErrText string
	}{
		{
			name:     "all localdev rows pass",
			args:     []string{"validate"},
			env:      stubEnv{},
			wantCode: ExitOK,
			wantRows: []string{"mise", "task", "bun", "docker", "kind", "kubectl", "helm", "argocd", "chainsaw"},
			// localdev never runs the production rows
			wantNoRows: []string{"terragrunt", "talosctl", "op", "proxmox"},
			wantMark:   "✔",
		},
		{
			name:        "a missing tool fails with its hint",
			args:        []string{"validate"},
			env:         stubEnv{missing: map[string]bool{"kind": true}},
			wantCode:    ExitFailure,
			wantMark:    "✘",
			wantHint:    "mise install",
			wantErrText: "1 of",
		},
		{
			name:        "an unreachable docker daemon fails the docker row",
			args:        []string{"validate", "-e", "localdev"},
			env:         stubEnv{runErr: map[string]error{"docker": errors.New("cannot connect to the Docker daemon")}},
			wantCode:    ExitFailure,
			wantMark:    "✘",
			wantHint:    "docker info",
			wantErrText: "prerequisite",
		},
		{
			name:     "the homelab tier adds the production rows",
			args:     []string{"validate", "--environment", "homelab"},
			env:      stubEnv{},
			wantRows: []string{"terragrunt", "talosctl", "ansible-playbook", "op", "age-key", "homelab.yaml", "proxmox"},
			// the file rows depend on this machine, so only the presence of
			// the rows is asserted; the exit code is not
			wantCode: -1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			swapPrereqEnv(t, tc.env)
			err, printed := runPrereqCommand(t, tc.args...)
			if tc.wantCode >= 0 {
				if got := ExitCode(err); got != tc.wantCode {
					t.Errorf("ExitCode = %d, want %d (err: %v)\n%s", got, tc.wantCode, err, printed)
				}
			}
			for _, row := range tc.wantRows {
				if !hasRow(printed, row) {
					t.Errorf("table does not list %q:\n%s", row, printed)
				}
			}
			for _, row := range tc.wantNoRows {
				if hasRow(printed, row) {
					t.Errorf("localdev table must not list %q:\n%s", row, printed)
				}
			}
			if tc.wantMark != "" && !strings.Contains(printed, tc.wantMark) {
				t.Errorf("table has no %q mark:\n%s", tc.wantMark, printed)
			}
			if tc.wantHint != "" && !strings.Contains(printed, tc.wantHint) {
				t.Errorf("failing row does not print its hint %q:\n%s", tc.wantHint, printed)
			}
			if tc.wantErrText != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErrText)) {
				t.Errorf("error %v does not mention %q", err, tc.wantErrText)
			}
		})
	}
}

func TestValidateAndBootstrapRejectUnknownEnvironment(t *testing.T) {
	swapPrereqEnv(t, stubEnv{})
	for _, args := range [][]string{
		{"validate", "--environment", "prod"},
		{"bootstrap", "--environment", "prod", "--dry-run"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			err, _ := runPrereqCommand(t, args...)
			if err == nil {
				t.Fatalf("%v must fail", args)
			}
			if got := ExitCode(err); got != ExitUsage {
				t.Errorf("ExitCode = %d, want %d (err: %v)", got, ExitUsage, err)
			}
			if !strings.Contains(err.Error(), "unknown environment") {
				t.Errorf("error %q should name the bad environment", err.Error())
			}
		})
	}
}

func TestPrereqHelpShowsTheEnvironmentFlag(t *testing.T) {
	for _, sub := range []string{"validate", "bootstrap"} {
		t.Run(sub, func(t *testing.T) {
			err, printed := runPrereqCommand(t, sub, "--help")
			if err != nil {
				t.Fatalf("--help must not error, got %v", err)
			}
			for _, want := range []string{"--environment", "-e", "localdev", "homelab"} {
				if !strings.Contains(printed, want) {
					t.Errorf("%s --help does not mention %q:\n%s", sub, want, printed)
				}
			}
		})
	}
}

// TestTierPromptOptions pins the prompt contract: localdev is listed first and
// the default index follows the detected tier.
func TestTierPromptOptions(t *testing.T) {
	tests := []struct {
		detected prereq.Tier
		wantIdx  int
	}{
		{detected: prereq.Localdev, wantIdx: 0},
		{detected: prereq.Homelab, wantIdx: 1},
	}
	for _, tc := range tests {
		t.Run(string(tc.detected), func(t *testing.T) {
			options, idx := tierPromptOptions(tc.detected)
			if len(options) != 2 || !strings.HasPrefix(options[0], "localdev") || !strings.HasPrefix(options[1], "homelab") {
				t.Errorf("options = %v, want localdev first then homelab", options)
			}
			if idx != tc.wantIdx {
				t.Errorf("default index = %d, want %d", idx, tc.wantIdx)
			}
			if got := tierFromChoice(idx); got != tc.detected {
				t.Errorf("tierFromChoice(%d) = %q, want %q", idx, got, tc.detected)
			}
		})
	}
}

// TestBootstrapNeverRunsHomelabWithoutTheFlag: --yes alone must stay in the
// Kind loop, whatever the detection says (the bug in the old bootstrap).
func TestBootstrapYesAloneIsLocaldev(t *testing.T) {
	got, err := prereq.ResolveTier("", true, prereq.Homelab, func(def prereq.Tier) prereq.Tier {
		t.Fatal("--yes must not prompt")
		return def
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != prereq.Localdev {
		t.Errorf("ResolveTier(--yes) = %q, want localdev", got)
	}
}

func TestBootstrapHasNoObsoleteReferences(t *testing.T) {
	src, err := os.ReadFile("bootstrap.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, stale := range []string{"plan.md", ".envrc", "TF_VAR_proxmox_api_url", "tilt", "localhost:10350"} {
		if bytes.Contains(src, []byte(stale)) {
			t.Errorf("bootstrap.go still references %q", stale)
		}
	}
	for _, stale := range []string{".envrc", "TF_VAR_proxmox_api_url", "mise run validate"} {
		v, err := os.ReadFile("validate.go")
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(v, []byte(stale)) {
			t.Errorf("validate.go still references %q", stale)
		}
	}
}
