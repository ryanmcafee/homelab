package commands

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/verify"
	"github.com/spf13/cobra"
)

// runVerifySubcommand executes one `homelab verify <sub>` invocation in-process
// and returns the error the command tree produced plus anything it printed.
// The command tree is built exactly as main builds it, including the root
// SetFlagErrorFunc, so the exit-code mapping under test is the real one.
func runVerifySubcommand(t *testing.T, args ...string) (error, string) {
	t.Helper()

	root := &cobra.Command{Use: "homelab", SilenceUsage: true, SilenceErrors: true}
	root.SetFlagErrorFunc(UsageErrorFunc)
	root.AddCommand(NewVerifyCmd())

	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs(args)

	return root.ExecuteContext(context.Background()), out.String()
}

func TestVerifyExitCodes(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		wantCode  int
		wantMsg   string
		wantUsage bool
	}{
		{
			name:      "unknown flag is a usage error",
			args:      []string{"verify", "render", "--bogus"},
			wantCode:  ExitUsage,
			wantMsg:   "unknown flag: --bogus",
			wantUsage: true,
		},
		{
			name:      "unknown flag on snapshot is a usage error",
			args:      []string{"verify", "snapshot", "--nope=1"},
			wantCode:  ExitUsage,
			wantMsg:   "unknown flag: --nope",
			wantUsage: true,
		},
		{
			name:     "unknown environment is a usage error",
			args:     []string{"verify", "render", "--env", "nope", "--skip-schema"},
			wantCode: ExitUsage,
			wantMsg:  "unknown environment",
		},
		{
			name:     "unexpected positional argument is a usage error",
			args:     []string{"verify", "render", "extra"},
			wantCode: ExitUsage,
			wantMsg:  "unexpected argument",
		},
		{
			name:     "negative parallelism is a usage error",
			args:     []string{"verify", "render", "--parallel", "-3"},
			wantCode: ExitUsage,
			wantMsg:  "--parallel",
		},
		{
			name:     "a level above 2 is a usage error",
			args:     []string{"verify", "all", "--level", "3"},
			wantCode: ExitUsage,
			wantMsg:  "--level must be 0, 1 or 2",
		},
		{
			name:     "a negative level is a usage error",
			args:     []string{"verify", "all", "--level", "-1"},
			wantCode: ExitUsage,
			wantMsg:  "--level must be 0, 1 or 2",
		},
		{
			name:     "level 1 without the localdev environment is a usage error",
			args:     []string{"verify", "all", "--level", "1", "--env", "homelab"},
			wantCode: ExitUsage,
			wantMsg:  "localdev",
		},
		{
			name:     "level 2 without the localdev environment is a usage error",
			args:     []string{"verify", "all", "--level", "2", "--env", "homelab"},
			wantCode: ExitUsage,
			wantMsg:  "localdev",
		},
		{
			name:     "a bad environment on level 1 is still a usage error",
			args:     []string{"verify", "all", "--level", "1", "--env", "nope"},
			wantCode: ExitUsage,
			wantMsg:  "unknown environment",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err, printed := runVerifySubcommand(t, tc.args...)
			if err == nil {
				t.Fatalf("expected an error for %v", tc.args)
			}
			if got := ExitCode(err); got != tc.wantCode {
				t.Errorf("ExitCode = %d, want %d (err: %v)", got, tc.wantCode, err)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("error %q does not mention %q", err.Error(), tc.wantMsg)
			}
			// main prints every non-verification error, so the message must be
			// non-empty or the user sees nothing at all.
			if strings.TrimSpace(err.Error()) == "" {
				t.Error("a usage error must carry a printable message")
			}
			// A flag-parse error shows usage, because the caller needs to see
			// which flags exist.
			if tc.wantUsage && !strings.Contains(printed, "Usage:") {
				t.Errorf("expected usage output, got:\n%s", printed)
			}
		})
	}
}

// TestVerifyAllHelpDescribesEveryLevel pins the operator-facing contract:
// the three levels and the two cluster flags are documented in --help.
func TestVerifyAllHelpDescribesEveryLevel(t *testing.T) {
	err, printed := runVerifySubcommand(t, "verify", "all", "--help")
	if err != nil {
		t.Fatalf("--help must not error, got %v", err)
	}
	for _, want := range []string{
		"Level 0", "Level 1", "Level 2",
		"--kube-context", "kind-homelab-localdev",
		"--e2e-dir", "tests/e2e",
		"dryrun/localdev", "argocd/", "e2e/",
	} {
		if !strings.Contains(printed, want) {
			t.Errorf("verify all --help does not mention %q:\n%s", want, printed)
		}
	}
	if strings.Contains(printed, "not available yet") {
		t.Error("the levels are available now; the placeholder wording must go")
	}
}

func TestVerificationFailureIsNotAUsageError(t *testing.T) {
	if got := ExitCode(ErrVerificationFailed); got != ExitFailure {
		t.Errorf("ExitCode(ErrVerificationFailed) = %d, want %d", got, ExitFailure)
	}
	var ue *UsageError
	if errors.As(ErrVerificationFailed, &ue) {
		t.Error("a verification failure must not be classified as a usage error")
	}
	// main suppresses only this error's message, because its findings were
	// already printed.
	if !errors.Is(ErrVerificationFailed, ErrVerificationFailed) {
		t.Error("ErrVerificationFailed must be matchable with errors.Is")
	}
}

func TestUsageErrorDoesNotLeakTempRenderDir(t *testing.T) {
	// A usage error used to call os.Exit(2) from inside RunE, which skipped the
	// deferred cleanup of the temp render directory.
	before := countVerifyTempDirs(t)

	err, _ := runVerifySubcommand(t, "verify", "render", "--env", "nope")
	if ExitCode(err) != ExitUsage {
		t.Fatalf("expected a usage error, got %v", err)
	}

	if after := countVerifyTempDirs(t); after != before {
		t.Errorf("temp render directories went from %d to %d; a usage error must not leak one", before, after)
	}
}

// countVerifyTempDirs counts leftover homelab-verify-* temp directories.
func countVerifyTempDirs(t *testing.T) int {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(os.TempDir(), "homelab-verify-*"))
	if err != nil {
		t.Fatalf("globbing temp dirs: %v", err)
	}
	return len(matches)
}

func TestOrphanModeNeverPrunesAfterAFailedRender(t *testing.T) {
	tests := []struct {
		name         string
		update       bool
		renderPassed bool
		want         verify.OrphanMode
	}{
		{name: "check only", update: false, renderPassed: true, want: verify.OrphanReport},
		{name: "check only after a failed render", update: false, renderPassed: false, want: verify.OrphanReport},
		{name: "update after a clean render prunes", update: true, renderPassed: true, want: verify.OrphanPrune},
		{name: "update after a failed render keeps", update: true, renderPassed: false, want: verify.OrphanKeep},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := orphanMode(tc.update, tc.renderPassed)
			if got != tc.want {
				t.Errorf("orphanMode(update=%v, renderPassed=%v) = %v, want %v",
					tc.update, tc.renderPassed, got, tc.want)
			}
			if !tc.renderPassed && got == verify.OrphanPrune {
				t.Error("a failed render must never lead to deleting a snapshot")
			}
		})
	}
}

func TestGuardFailsOnUnreadableFile(t *testing.T) {
	// The guard used to swallow the open error and print "[OK] ... 1 file(s)".
	root := &cobra.Command{Use: "homelab", SilenceUsage: true, SilenceErrors: true}
	root.SetFlagErrorFunc(UsageErrorFunc)
	root.AddCommand(NewConfigCmd())

	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	missing := filepath.Join(t.TempDir(), "does-not-exist.yaml")
	root.SetArgs([]string{
		"config", "guard",
		"--env-file", filepath.Join(t.TempDir(), "absent.yaml"),
		"--", missing,
	})

	err := root.ExecuteContext(context.Background())
	if err == nil {
		t.Fatal("scanning a file that cannot be read must fail, not report success")
	}
	if got := ExitCode(err); got != ExitFailure {
		t.Errorf("ExitCode = %d, want %d", got, ExitFailure)
	}
	if !strings.Contains(err.Error(), "could not be read") {
		t.Errorf("error %q should say the file could not be read", err.Error())
	}
}

// runCommandTree executes one invocation against a root built the way main
// builds it, so the exit-code mapping under test is the real one.
func runCommandTree(t *testing.T, args ...string) (error, string) {
	t.Helper()

	root := &cobra.Command{Use: "homelab", SilenceUsage: true, SilenceErrors: true}
	root.SetFlagErrorFunc(UsageErrorFunc)
	root.AddCommand(NewVerifyCmd())
	root.AddCommand(NewConfigCmd())

	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs(args)

	return root.ExecuteContext(context.Background()), out.String()
}

// TestGroupCommandsRejectBadInvocations is the regression for the exit-code
// hole: a command group declared neither Args nor RunE, so cobra printed help
// and exited 0. `homelab verify rendr` therefore reported success, which to an
// autonomous caller is indistinguishable from a clean verification.
func TestGroupCommandsRejectBadInvocations(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		wantMsg string
	}{
		{
			name:    "verify with no subcommand",
			args:    []string{"verify"},
			wantMsg: "requires a subcommand",
		},
		{
			name:    "verify with an unknown subcommand",
			args:    []string{"verify", "rendr"},
			wantMsg: `unknown verify subcommand "rendr"`,
		},
		{
			name:    "config with no subcommand",
			args:    []string{"config"},
			wantMsg: "requires a subcommand",
		},
		{
			name:    "config with an unknown subcommand",
			args:    []string{"config", "gaurd"},
			wantMsg: `unknown config subcommand "gaurd"`,
		},
		{
			name:    "an unexpected argument to verify all",
			args:    []string{"verify", "all", "bogusarg"},
			wantMsg: `unknown command "bogusarg"`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err, printed := runCommandTree(t, tc.args...)
			if err == nil {
				t.Fatalf("%v must not succeed", tc.args)
			}
			if got := ExitCode(err); got != ExitUsage {
				t.Errorf("ExitCode = %d, want %d (err: %v)", got, ExitUsage, err)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("error %q does not mention %q", err.Error(), tc.wantMsg)
			}
			// The caller has to be able to see what the valid subcommands are.
			if !strings.Contains(printed, "Available Commands:") && !strings.Contains(printed, "Usage:") {
				t.Errorf("expected help output, got:\n%s", printed)
			}
		})
	}
}

// TestConfigExportRejectsBadInput covers the invocation mistakes that returned
// plain errors (exit 1) or, with no flags at all, exported nothing and exited
// 0. None of them resolves config first, so the exit code does not depend on
// whether the environment file is present.
func TestConfigExportRejectsBadInput(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		wantMsg string
	}{
		{
			name:    "stdout without a format",
			args:    []string{"config", "export", "--stdout"},
			wantMsg: "--stdout requires --format",
		},
		{
			name:    "stdout together with all",
			args:    []string{"config", "export", "--stdout", "--all"},
			wantMsg: "mutually exclusive",
		},
		{
			name:    "an unknown format",
			args:    []string{"config", "export", "--format", "bogus"},
			wantMsg: `unknown format "bogus"`,
		},
		{
			name:    "neither format nor all",
			args:    []string{"config", "export"},
			wantMsg: "requires --format or --all",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err, _ := runCommandTree(t, tc.args...)
			if err == nil {
				t.Fatalf("%v must not succeed", tc.args)
			}
			if got := ExitCode(err); got != ExitUsage {
				t.Errorf("ExitCode = %d, want %d (err: %v)", got, ExitUsage, err)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("error %q does not mention %q", err.Error(), tc.wantMsg)
			}
		})
	}
}

// TestGuardEmptyScopeIsAUsageError: an empty --paths scope is a bad
// invocation, not a broken repository.
func TestGuardEmptyScopeIsAUsageError(t *testing.T) {
	err, _ := runCommandTree(t, "config", "guard", "--ci", "--paths", "no/such/path/**")
	if err == nil {
		t.Fatal("a scan scope of zero files must fail")
	}
	if got := ExitCode(err); got != ExitUsage {
		t.Errorf("ExitCode = %d, want %d (err: %v)", got, ExitUsage, err)
	}
	if !strings.Contains(err.Error(), "scanned 0 files") {
		t.Errorf("error %q should say the scan scope was empty", err.Error())
	}
}

// TestExportFormatListMatchesTheTemplateMap keeps the usage message honest.
func TestExportFormatListMatchesTheTemplateMap(t *testing.T) {
	got := exportFormatList()
	for name := range exportTemplates {
		if !strings.Contains(got, name) {
			t.Errorf("exportFormatList() = %q, missing %q", got, name)
		}
	}
}

// TestExportTargetsAreSetAware pins the output-path contract of
// `config export`: homelab outputs carry PII and stay in gitignored
// *.generated.* files, while every other set writes the committed
// values-<set>.yaml that ArgoCD and Tilt read directly (issue #263).
func TestExportTargetsAreSetAware(t *testing.T) {
	tests := []struct {
		set  string
		want map[string]string
	}{
		{
			set: "homelab",
			want: map[string]string{
				"helm-addons":       "charts/addons/values-homelab.generated.yaml",
				"helm-apps":         "charts/applications/values-homelab.generated.yaml",
				"env":               ".env.generated",
				"json":              "configuration/resolved.json",
				"ansible-inventory": "ansible/inventory/homelab.yml",
			},
		},
		{
			set: "localdev",
			want: map[string]string{
				"helm-addons": "charts/addons/values-localdev.yaml",
				"helm-apps":   "charts/applications/values-localdev.yaml",
				"env":         ".env.localdev.generated",
				"json":        "configuration/resolved.localdev.json",
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.set, func(t *testing.T) {
			targets := exportTargets(tc.set)
			if len(targets) != len(tc.want) {
				t.Fatalf("exportTargets(%q) has %d entries, want %d (ansible-inventory is homelab-only; every other format is exported for every set)", tc.set, len(targets), len(tc.want))
			}
			for _, target := range targets {
				if tmpl, ok := exportTemplates[target.format]; !ok || tmpl != target.template {
					t.Errorf("format %q maps to template %q in exportTargets but %q in exportTemplates", target.format, target.template, tmpl)
				}
				if got, want := target.output, tc.want[target.format]; got != want {
					t.Errorf("exportTargets(%q)[%s] = %q, want %q", tc.set, target.format, got, want)
				}
			}
		})
	}
}
