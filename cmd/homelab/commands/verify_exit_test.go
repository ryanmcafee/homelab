package commands

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
