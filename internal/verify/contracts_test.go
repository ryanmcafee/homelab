package verify

import (
	"context"
	"errors"
	"os/exec"
	"slices"
	"strings"
	"testing"
)

func TestEventContract(t *testing.T) {
	violation := "\x1b[31mFAIL\x1b[0m  1 contract violation(s)\nstream-source-same-origin: PF_AUDIT\n    declares 2 sources entries from PF_EVENTS (ADR-044)\n"
	cases := []struct {
		name         string
		runner       *fakePolicyRunner
		wantStatus   Status
		wantDetail   string
		wantFindings []string
	}{
		{
			name:       "clean contract passes",
			runner:     &fakePolicyRunner{stderr: []byte("\x1b[32mOK\x1b[0m    12 registered types\n")},
			wantStatus: StatusPass,
			wantDetail: "OK    12 registered types",
		},
		{
			name:       "violations fail with each printed line as a finding",
			runner:     &fakePolicyRunner{stderr: []byte(violation), runErr: errors.New("exit status 1")},
			wantStatus: StatusFail,
			wantDetail: "task contracts:check",
			wantFindings: []string{
				"FAIL  1 contract violation(s)",
				"stream-source-same-origin: PF_AUDIT",
				"    declares 2 sources entries from PF_EVENTS (ADR-044)",
			},
		},
		{
			name:       "missing bun fails rather than skipping the gate",
			runner:     &fakePolicyRunner{lookPathErr: exec.ErrNotFound},
			wantStatus: StatusFail,
			wantDetail: "bun not found on PATH",
		},
		{
			name:       "an unset mise shim reads as a missing tool",
			runner:     &fakePolicyRunner{stderr: []byte("mise ERROR No version is set for shim: bun"), runErr: errors.New("exit status 1")},
			wantStatus: StatusFail,
			wantDetail: "bun not found on PATH",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := EventContract(context.Background(), tc.runner, "/repo")
			if got.Name != "contracts/events" || got.Status != tc.wantStatus {
				t.Fatalf("got %s/%s, want contracts/events/%s", got.Name, got.Status, tc.wantStatus)
			}
			if !strings.Contains(got.Detail, tc.wantDetail) {
				t.Errorf("detail %q does not contain %q", got.Detail, tc.wantDetail)
			}
			if tc.wantFindings != nil && !slices.Equal(got.Findings, tc.wantFindings) {
				t.Errorf("findings = %q, want %q", got.Findings, tc.wantFindings)
			}
		})
	}
}

func TestEventContractRunsTheValidatorFromTheRepoRoot(t *testing.T) {
	runner := &fakePolicyRunner{}
	EventContract(context.Background(), runner, "/repo")
	if want := []string{EventContractScript, "check"}; !slices.Equal(runner.lastArgs, want) {
		t.Errorf("args = %q, want %q", runner.lastArgs, want)
	}
}
