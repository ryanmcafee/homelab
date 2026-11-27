package verify

import (
	"context"
	"regexp"
	"time"
)

// helmPullRetryDelays are the pauses before each retry; a chart is fetched at most len+1 times.
var helmPullRetryDelays = []time.Duration{2 * time.Second, 5 * time.Second}

var (
	nonRetryableHelmError = regexp.MustCompile(`(?i)manifest unknown|not found|status(?: code)?:? 40[134]\b|\b404 Not Found`)
	transientHelmErrors   = []*regexp.Regexp{
		regexp.MustCompile(`(?i)connection reset|broken pipe|unexpected EOF`),
		regexp.MustCompile(`(?i)i/o timeout|TLS handshake timeout|timed out|deadline exceeded`),
		regexp.MustCompile(`(?i)status(?: code)?:? (?:5\d\d|429)\b`),
		regexp.MustCompile(`(?i)\b(?:5\d\d|429) (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Too Many Requests)`),
	}
)

// isTransientHelmError reports a chart fetch worth repeating: a reset, a timeout, a 5xx or a 429.
func isTransientHelmError(stderr []byte) bool {
	if nonRetryableHelmError.Match(stderr) {
		return false
	}
	for _, re := range transientHelmErrors {
		if re.Match(stderr) {
			return true
		}
	}
	return false
}

// runHelmWithRetry runs helm, repeating it while the registry answers with a transient error.
func runHelmWithRetry(ctx context.Context, r Runner, workDir string, args []string) (stdout, stderr []byte, err error) {
	for attempt := 0; ; attempt++ {
		stdout, stderr, err = r.Run(ctx, workDir, "helm", args...)
		if err == nil || attempt >= len(helmPullRetryDelays) || !isTransientHelmError(stderr) {
			return stdout, stderr, err
		}
		select {
		case <-ctx.Done():
			return stdout, stderr, err
		case <-time.After(helmPullRetryDelays[attempt]):
		}
	}
}
