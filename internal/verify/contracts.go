package verify

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// EventContractScript is the repo-relative validator for contracts/events/
// (ADR-026, ADR-030); `task contracts:check` runs the same command.
const EventContractScript = "scripts/contract-check.ts"

const eventContractCheck = "contracts/events"

var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// EventContract runs the event-contract validator over the repository's
// contracts/events/ and reports every violation it prints as a finding.
func EventContract(ctx context.Context, r Runner, repoRoot string) Check {
	start := time.Now()
	if _, err := r.LookPath("bun"); err != nil {
		return FailCheck(eventContractCheck, start, ToolMissingDetail("bun"))
	}

	stdout, stderr, runErr := r.Run(ctx, repoRoot, "bun", EventContractScript, "check")
	if runErr != nil && isShimMissing(stderr) {
		return FailCheck(eventContractCheck, start, ToolMissingDetail("bun"))
	}
	output := strings.TrimSpace(ansiEscape.ReplaceAllString(string(stderr)+string(stdout), ""))
	if runErr != nil {
		return FailCheck(eventContractCheck, start,
			fmt.Sprintf("bun %s check failed (%v); `task contracts:check` reproduces it", EventContractScript, runErr),
			nonEmptyLines([]byte(output))...)
	}
	return PassCheck(eventContractCheck, start, output)
}
