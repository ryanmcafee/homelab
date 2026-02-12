package config

import (
	"bufio"
	"net"
	"os"
	"strings"
)

// piiKeyPrefixes are config key prefixes whose values are likely PII (IPs, domains, usernames, emails).
var piiKeyPrefixes = []string{
	"DOMAIN", "ACME_EMAIL", "NFS_MAPALL_USER", "DUCKDNS_SUBDOMAIN",
	"EXTERNAL_DNS_DEFAULT_TARGET", "TRAEFIK_OIDC_ALLOWED_DOMAINS",
}

// piiKeySuffixes are config key suffixes whose values are likely PII.
var piiKeySuffixes = []string{
	"_IP", "_HOSTNAME",
}

// BuildGuardPatterns extracts PII-sensitive values from a resolved config as guard patterns.
// It selects values that look like IPs, domains, usernames, or emails — not generic numbers or paths.
func BuildGuardPatterns(values map[string]string) []string {
	seen := make(map[string]bool)
	var patterns []string

	for key, val := range values {
		if val == "" {
			continue
		}

		isPII := false

		// Check by key name
		for _, prefix := range piiKeyPrefixes {
			if key == prefix || strings.HasPrefix(key, prefix) {
				isPII = true
				break
			}
		}
		if !isPII {
			for _, suffix := range piiKeySuffixes {
				if strings.HasSuffix(key, suffix) {
					isPII = true
					break
				}
			}
		}

		// Also flag anything that parses as a non-loopback IP
		if !isPII {
			if ip := net.ParseIP(val); ip != nil && !ip.IsLoopback() && !ip.IsUnspecified() {
				isPII = true
			}
		}

		if isPII && !seen[val] {
			seen[val] = true
			patterns = append(patterns, val)
		}
	}

	return patterns
}

// ScanFileForPII scans a file for lines containing any of the given PII patterns.
func ScanFileForPII(path string, patterns []string) GuardResult {
	result := GuardResult{File: path}

	f, err := os.Open(path)
	if err != nil {
		return result
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := scanner.Text()
		for _, p := range patterns {
			if strings.Contains(line, p) {
				result.Matches = append(result.Matches, GuardMatch{
					Line:    lineNum,
					Pattern: p,
					Content: line,
				})
			}
		}
	}

	return result
}
