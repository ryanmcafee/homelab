package config

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// piiKeyPrefixes are config key prefixes whose values are likely PII (IPs, domains, usernames, emails).
var piiKeyPrefixes = []string{
	"DOMAIN", "ACME_EMAIL", "NFS_MAPALL_USER", "DUCKDNS_SUBDOMAIN",
	"EXTERNAL_DNS_DEFAULT_TARGET",
	// LAN CIDRs: a runbook pasting a real subnet identifies the network as
	// surely as a host address does. LAN_CIDR is the terragrunt tree's own
	// subnet key and holds the same value, so it is judged the same way.
	"NFS_SHARE_ALLOW", "NETWORK_NAMES", "LAN_CIDR",
}

// piiKeySuffixes are config key suffixes whose values are likely PII.
// _VIP covers the control-plane virtual address, which holds a real host
// address but does not end in _IP.
var piiKeySuffixes = []string{
	"_IP", "_VIP", "_HOSTNAME",
}

// MinGuardPatternLen is the shortest literal that may become a value pattern.
// A three-character value carries almost no identifying information and hits
// ordinary prose constantly; the shape rules still cover such a value on a
// PII-shaped key, so dropping it costs no protection.
const MinGuardPatternLen = 4

// isNonIdentifyingValue reports whether a value cannot name real
// infrastructure, whatever key it sits on. It is the gate in front of the
// whole pattern set: a value that clears it must never become a hunt pattern,
// because every occurrence of it anywhere in the repository would be reported.
//
// This ran only for keys that were *not* PII-shaped, which is exactly
// backwards: localdev's `GATEWAY_IP: "127.0.0.1"` is PII-shaped, so loopback
// became the pattern `127.0.0.1` and matched every loopback address in the
// tree. Judging the value first is what makes localdev's config scannable.
func isNonIdentifyingValue(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return true
	}
	// An address is judged as an address: loopback, unspecified, link-local and
	// multicast cannot identify a host, so they are never patterns.
	if net.ParseIP(v) != nil {
		return !isRoutableHostIP(v)
	}
	// A CIDR is judged by its network address for the same reason. This was
	// missing, and it mattered: localdev's `NFS_SHARE_ALLOW: "127.0.0.0/8"` is
	// PII-shaped, ParseIP cannot read a CIDR, so the loopback range became a
	// hunt pattern and reported every file that writes 127.0.0.0/8 down.
	// isExamplePlaceholder already judges a CIDR this way; this makes the
	// plain path agree with it.
	if ip, _, err := net.ParseCIDR(v); err == nil {
		return !isRoutableHostIP(ip.String())
	}
	if hasPlaceholderMarker(v) {
		return true
	}
	host := hostOf(v)
	for _, p := range placeholderHosts {
		if host == p {
			return true
		}
	}
	// Reserved suffixes are documentation or local-network names by definition
	// (RFC 2606, RFC 6761): localdev's `DOMAIN: homelab.local` is one.
	for _, suffix := range reservedHostSuffixes {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	// A host this repository commits on purpose is not a leak when it appears.
	for _, safe := range committedSafeHosts {
		if host == safe || strings.HasSuffix(host, "."+safe) {
			return true
		}
	}
	return false
}

// BuildGuardPatterns extracts PII-sensitive values from a resolved config as guard patterns.
// It selects values that look like IPs, domains, usernames, or emails — not generic numbers or paths.
//
// The returned list is sorted, so two runs over the same config produce the
// same patterns in the same order and therefore byte-identical findings.
func BuildGuardPatterns(values map[string]string) []string {
	seen := make(map[string]bool)
	var patterns []string

	for key, val := range values {
		val = strings.TrimSpace(val)
		if val == "" {
			continue
		}

		// Judge the value before the key. A non-identifying value is never a
		// pattern even on a PII-shaped key.
		if isNonIdentifyingValue(val) {
			continue
		}

		isPII := IsPIIKey(key)

		// Also flag anything that parses as a routable IP, whatever its key.
		if !isPII && isRoutableHostIP(val) {
			isPII = true
		}

		if !isPII || len(val) < MinGuardPatternLen || seen[val] {
			continue
		}
		seen[val] = true
		patterns = append(patterns, val)
	}

	sort.Strings(patterns)
	return patterns
}

// isWordByte reports whether c is a word byte in the regexp \b sense: letters,
// digits and underscore. A dot and a hyphen are separators, so the pattern
// example.com still matches inside sub.example.com (a subdomain of a real
// domain leaks the domain) while the pattern 192.168.1.10 does not match
// inside 192.168.1.100.
func isWordByte(c byte) bool {
	return c == '_' ||
		(c >= '0' && c <= '9') ||
		(c >= 'a' && c <= 'z') ||
		(c >= 'A' && c <= 'Z')
}

// wordByteAt reports whether the byte at index i of s is a word byte. Out of
// range counts as a separator, so a match at the start or end of a line has a
// boundary there.
func wordByteAt(s string, i int) bool {
	return i >= 0 && i < len(s) && isWordByte(s[i])
}

// lineMatchesPattern reports whether line contains pattern at word boundaries
// rather than inside a longer token. A bare strings.Contains made every short
// value a prose magnet: the pattern "localdev" matched the sentence "Override
// per-environment in homelab.yaml or localdev.yaml".
//
// A boundary is required only on a side where the pattern's own edge is a word
// byte, exactly as \b works. That keeps a deliberately open-ended pattern such
// as a subnet prefix ("172.16.100.") matching every address under it.
//
// An occurrence that is the owner segment of a public code-forge URL is not a
// match (see isForgeOwnerAt); the search carries on past it, so the same
// value elsewhere on the line is still found.
func lineMatchesPattern(line, pattern string) bool {
	if pattern == "" {
		return false
	}
	needLeft := isWordByte(pattern[0])
	needRight := isWordByte(pattern[len(pattern)-1])

	for off := 0; off+len(pattern) <= len(line); {
		j := strings.Index(line[off:], pattern)
		if j < 0 {
			return false
		}
		start := off + j
		end := start + len(pattern)
		leftOK := !needLeft || !wordByteAt(line, start-1)
		rightOK := !needRight || !wordByteAt(line, end)
		if leftOK && rightOK && !isForgeOwnerAt(line, start, end) {
			return true
		}
		off = start + 1
	}
	return false
}

// forgeHosts are the public code forges whose URLs name an account owner:
// the repository form `<host>/<owner>/<repo>` (also `<host>:<owner>/<repo>`
// in an SSH clone URL) and the pages form `<owner>.<pages>`.
//
// This repository is public and lives under its owner's account, so the
// owner name is written on purpose in `global.repoUrl`, in the templates
// that render it and in a `registryUrl=https://<owner>.github.io/...`
// Renovate comment. When a config value (a username, a dynamic-DNS label)
// equals that owner name, hunting for it inside those URLs reports a value
// that is public by definition and blocks every commit touching the file.
var forgeHosts = []struct{ host, pages string }{
	{"github.com", "github.io"},
	{"gitlab.com", "gitlab.io"},
	// Container registries keyed by the same public account name. A pinned
	// image such as ghcr.io/<owner>/homelab-cmp names the owner for the same
	// reason a clone URL does, and is just as public. They have no pages
	// domain, so the pages form below is skipped for them: an empty pages
	// value would build the suffix "." and excuse every <owner>.<anything>,
	// including the real domain.
	{"ghcr.io", ""},
}

// isURLTokenByte reports whether c can continue a hostname or URL path
// segment: word bytes plus the dot and hyphen a DNS label or repository name
// may contain. Anything else ends the token.
func isURLTokenByte(c byte) bool {
	return isWordByte(c) || c == '.' || c == '-'
}

// urlTokenByteAt reports whether the byte at index i of s continues a URL
// token; out of range counts as a token end.
func urlTokenByteAt(s string, i int) bool {
	return i >= 0 && i < len(s) && isURLTokenByte(s[i])
}

// isForgeOwnerAt reports whether line[start:end] is exactly the owner
// segment of a public code-forge URL: `<host>/<owner>` followed by `/`,
// `.git` or the end of the token, or `<owner>.<pages>` with the owner as the
// host label directly before the pages domain. Only a single label can be an
// owner, so a value holding a dot (a domain, a mailbox, an address) is never
// excused, and a hostname that merely starts with the owner
// (`<owner>.example.com`) or an owner that merely starts with the value
// (`<host>/<value>-other/`) is not one either.
func isForgeOwnerAt(line string, start, end int) bool {
	if strings.Contains(line[start:end], ".") {
		return false
	}
	before, after := line[:start], line[end:]
	for _, forge := range forgeHosts {
		// Repository form: the host, one separator, then the owner.
		for _, sep := range []string{"/", ":"} {
			prefix := forge.host + sep
			if len(before) < len(prefix) || !strings.EqualFold(before[len(before)-len(prefix):], prefix) {
				continue
			}
			if urlTokenByteAt(before, len(before)-len(prefix)-1) {
				continue // a longer host, such as notgithub.com
			}
			rest := strings.TrimPrefix(after, ".git")
			if strings.HasPrefix(rest, "/") || !urlTokenByteAt(rest, 0) {
				return true
			}
		}
		// Pages form: the owner is the whole label before the pages domain.
		if forge.pages == "" {
			continue // registry host: no pages domain, and "." would match anything
		}
		suffix := "." + forge.pages
		if urlTokenByteAt(before, len(before)-1) {
			continue // a deeper label, such as sub.<owner>.github.io
		}
		if len(after) < len(suffix) || !strings.EqualFold(after[:len(suffix)], suffix) {
			continue
		}
		rest := after[len(suffix):]
		if strings.HasPrefix(rest, "/") || strings.HasPrefix(rest, ":") || !urlTokenByteAt(rest, 0) {
			return true
		}
	}
	return false
}

// ScanFileForPII scans a file for lines containing any of the given PII patterns.
// The open and read errors are returned rather than swallowed: a file the
// guard cannot read is a file it cannot clear, and reporting it as clean is
// the one failure mode a PII guard must not have.
func ScanFileForPII(path string, patterns []string) (GuardResult, error) {
	result := GuardResult{File: path}

	f, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := scanner.Text()
		for _, p := range patterns {
			if lineMatchesPattern(line, p) {
				result.Matches = append(result.Matches, GuardMatch{
					Line:    lineNum,
					Pattern: p,
					Content: line,
				})
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}

	return result, nil
}

// IsPIIKey reports whether a config key name is PII-shaped, i.e. its value is
// expected to identify a real host, domain, user or mailbox. Key names ending
// in _CIDR, _ASN, _PORT or _PATH are deliberately not PII-shaped: they carry
// topology constants and vault references that are committed on purpose.
func IsPIIKey(key string) bool {
	for _, prefix := range piiKeyPrefixes {
		if key == prefix || strings.HasPrefix(key, prefix) {
			return true
		}
	}
	for _, suffix := range piiKeySuffixes {
		if strings.HasSuffix(key, suffix) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Scan scope
// ---------------------------------------------------------------------------

// DefaultGuardPathspecs is the CI scan scope. It mirrors the pre-commit hook's
// `files:` pattern so the hook and CI agree on what is guarded; change the two
// together or they drift.
//
// The chart files are in scope because they are committed and rendered into
// the production environment without passing through the CMP: a child
// `*-config` chart reads them through plain helm.valueFiles, so anything
// derived from configuration/ (domain, hostnames, addresses, mailboxes) must
// reach it through the parent Application's helm.valuesObject instead, and a
// real value pasted into one of these files is a leak the same as one pasted
// into configuration/.
//
// scripts/ is in scope because a TypeScript script is just as able to hardcode a
// real address as a values file, and nothing rendered it through the CMP
// either. Leaving scripts/ out hid three scripts that defaulted --api-url to
// the real TrueNAS hostname, and a migration script that hardcoded the whole
// control-plane topology. Scripts take these values from
// configuration/environments/homelab.yaml at runtime instead (see
// scripts/tailscale-dns.ts and scripts/prod-readonly.ts for the pattern).
//
// docs/ is in scope because a runbook is the easiest place of all to paste a
// real address, and this repository is public: 189 occurrences across 20 files
// were committed before it was guarded. Documentation writes them as <KEY>
// placeholders naming the configuration key instead (see
// docs/runbooks/tailscale-dns.md). Note the value detector only matches the
// values the environment file currently holds, so a stale address that no key
// resolves to is not reported - the guard raises the floor, it is not a
// substitute for reading what you commit.
//
// .github/ is in scope because the README header (.github/homelab.svg) is a
// hand-written picture of the real cluster: every hostname in it is a
// <DOMAIN> placeholder, and the guard is what keeps it that way. The workflow
// files and issue templates live there too, and a workflow that pins a real
// hostname in an env: block is as public as a runbook.
//
// Taskfile.yml is in scope because its production-facing tasks (TrueNAS,
// Talos, the Proxmox template) address real hosts; those values now come from
// the gitignored homelab.yaml through Taskfile vars, and the guard is what
// keeps a literal from creeping back.
var DefaultGuardPathspecs = []string{
	"configuration/**",
	"charts/**/values-homelab.yaml",
	"scripts/**",
	"docs/**",
	".github/**",
	"Taskfile.yml",
	// The inventory is rendered from configuration/ and gitignored; what is
	// committed under ansible/ (group_vars, roles, playbooks) must stay free of
	// addresses.
	"ansible/**",
	// cmd/ and internal/ are in scope because ADR-030 makes the Go CLI the
	// thing a stranger runs first, and a Go flag default is the same construct
	// as the TypeScript flag default that put scripts/ in scope: `--node
	// worker-1` in cmd/homelab/commands/talos.go is a node name written into
	// the binary. Go source also carries the embedded templates and testdata
	// that render into a cluster, so the YAML under internal/ is as much a
	// leak surface as the YAML under configuration/.
	"cmd/**",
	"internal/**",
}

// guardScanExtensions are the file types the guard knows how to read. Anything
// else (templates, binaries, .example files) is out of scope.
var guardScanExtensions = map[string]bool{
	".yaml": true,
	".yml":  true,
	".json": true,
	".md":   true,
	// .ts because scripts/ is in scope: a TypeScript script that hardcodes a real
	// address or hostname as a flag default is a leak the same as one pasted
	// into configuration/, and three of them did exactly that before the
	// scope was widened.
	".ts": true,
	// .svg because .github/ is in scope: the README header is an SVG whose
	// text nodes name hostnames, and the scan is line-based text matching, so
	// XML needs no parser of its own.
	".svg": true,
	// .go because cmd/ and internal/ are in scope (ADR-032). The same
	// reasoning as .ts: a flag default, a const or a struct literal that
	// pins a real address is a leak the same as one pasted into
	// configuration/, and the Go half of the repository is what a stranger
	// runs first. Go is a code file for shape detection (isShapeCodeFile), so
	// only a quoted literal is judged and an identifier is not.
	".go": true,
}

// hasScannableExtension reports whether a path is a file type the guard can
// read. A template suffix is looked through first, so homelab.yaml.example is
// scanned as YAML: that file is the likeliest place for a real value to be
// pasted, so it must never fall out of scope on its name alone.
func hasScannableExtension(path string) bool {
	name := strings.ToLower(filepath.Base(path))
	for _, suffix := range templateFileSuffixes {
		name = strings.TrimSuffix(name, suffix)
	}
	return guardScanExtensions[filepath.Ext(name)]
}

// FileLister enumerates repository-tracked files matching git pathspecs.
type FileLister func(repoRoot string, pathspecs []string) ([]string, error)

// TrackedFiles resolves the scan scope. It is a package-level var so tests can
// substitute a deterministic lister instead of shelling out to git.
var TrackedFiles FileLister = gitLsFiles

// gitLsFiles is the production FileLister.
func gitLsFiles(repoRoot string, pathspecs []string) ([]string, error) {
	args := append([]string{"-C", repoRoot, "ls-files", "--"}, pathspecs...)
	out, err := exec.Command("git", args...).Output()
	if err != nil {
		return nil, fmt.Errorf("git ls-files %s: %w", strings.Join(pathspecs, " "), err)
	}
	var files []string
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			files = append(files, line)
		}
	}
	return files, nil
}

// guardSelfPaths are the guard's own definition and its tests. They are
// excluded for the same reason configuration/environments/homelab.yaml is:
// they legitimately hold the values being guarded.
//
// guard.go carries committedSafeHosts, placeholderHosts and
// examplePlaceholderSubnets — a list of the exact hostnames and ranges the
// scan is deciding about. guard_test.go carries both sides of every rule: the
// committed-safe target the guard must clear (homelab-dev.duckdns.org) and a
// real domain and mailbox it must report, because a test that cannot name a
// real value cannot prove the guard finds one.
//
// This is not a blind spot the widening introduced, it is the widening
// meeting the one file pair that cannot be written any other way. Both are
// still reviewed by the humans and agents who change them, and a new
// committed-safe host is a deliberate, commented addition by construction.
var guardSelfPaths = map[string]bool{
	"internal/config/guard.go":      true,
	"internal/config/guard_test.go": true,
}

// isFixtureDir reports whether a path sits under a Go testdata/ directory.
//
// testdata/ is the toolchain's own marker for a fixture — the go command
// ignores it when building — so it is "a fixture clearly marked as one" in
// the words of docs/contracts/fork-ability.md, the same category as an
// .example file. The fixtures are addresses on purpose: a guard test needs a
// GATEWAY_IP with something in it.
func isFixtureDir(path string) bool {
	return path == "testdata" ||
		strings.HasPrefix(path, "testdata/") ||
		strings.Contains(path, "/testdata/")
}

// IsGuardExcluded mirrors the pre-commit hook's exclude list: the real
// environment file (which legitimately holds the values being guarded), any
// generated export, the guard's own source and tests, and Go testdata
// fixtures.
//
// Only homelab.yaml is out of scope among environment files, because only it
// is gitignored. Every other environment file is committed and is scanned —
// by shape always, and by value whenever it did not itself supply the
// patterns (see patternSources).
func IsGuardExcluded(path string) bool {
	clean := filepath.ToSlash(filepath.Clean(path))
	if clean == "configuration/environments/homelab.yaml" {
		return true
	}
	if guardSelfPaths[clean] || isFixtureDir(clean) {
		return true
	}
	// Any path component may carry the marker, so a generated directory such
	// as exports.generated.d/values.yaml is excluded too, not just a file
	// whose own name contains it.
	return strings.Contains(clean, ".generated.")
}

// ListGuardFiles returns the sorted, deduplicated tracked files in scope.
// Passing nil pathspecs uses DefaultGuardPathspecs.
func ListGuardFiles(repoRoot string, pathspecs []string) ([]string, error) {
	if len(pathspecs) == 0 {
		pathspecs = DefaultGuardPathspecs
	}
	tracked, err := TrackedFiles(repoRoot, pathspecs)
	if err != nil {
		return nil, err
	}

	seen := make(map[string]bool, len(tracked))
	var files []string
	for _, f := range tracked {
		if !hasScannableExtension(f) {
			continue
		}
		if IsGuardExcluded(f) || seen[f] {
			continue
		}
		seen[f] = true
		files = append(files, f)
	}
	sort.Strings(files)
	return files, nil
}

// ---------------------------------------------------------------------------
// Shape-based detection
// ---------------------------------------------------------------------------

// configKeyLine matches a flat `KEY: value` assignment with a value on the same
// line. Schema declarations (`GATEWAY_IP:` with the value nested underneath),
// lowercase YAML keys and markdown table rows deliberately do not match.
var configKeyLine = regexp.MustCompile(`^\s*([A-Z][A-Z0-9_]*)\s*:\s*(\S.*)$`)

// reservedHostSuffixes are domain suffixes reserved for documentation, testing
// and local networks (RFC 2606, RFC 6761). A value under one of them cannot
// name real infrastructure.
var reservedHostSuffixes = []string{
	".local", ".localhost", ".localdomain", ".internal", ".intranet",
	".test", ".invalid", ".example", ".example.com", ".example.org", ".example.net",
	// Kubernetes in-cluster service names (<svc>.<ns>.svc, with or without
	// .cluster.local) never leave the cluster and identify nothing outside it.
	".svc",
}

// placeholderHosts are exact hostnames used as documentation placeholders.
var placeholderHosts = []string{"example.com", "example.org", "example.net", "localhost"}

// placeholderMarkers is this repository's fill-me-in convention: REPLACEME,
// on its own or as a REPLACEME-something prefix. Values are compared
// lowercased, so the templates write it in capitals for visibility while the
// markers here stay lower case.
//
// One deliberately unpronounceable token, rather than a set of natural-language
// guesses. The earlier list (your-, yourdomain, changeme, replace-me, todo) all
// collide with registrable domains: yourdomain.com, changeme.io and
// custodoservices.com are real hosts, so every one of those markers was a
// channel for a real value to be waved through. REPLACEME- has no plausible
// collision, which is the point.
//
// Markers are matched at DNS label boundaries, never as a bare substring. A
// marker ending in "-" is a prefix form and matches a label starting with it;
// every other marker must be a whole label.
var placeholderMarkers = []string{"replaceme", "replaceme-"}

// hasPlaceholderMarker reports whether any label of host is a fill-me-in
// marker. An angle bracket anywhere is also a placeholder, since it cannot
// appear in a real hostname.
func hasPlaceholderMarker(host string) bool {
	host = strings.ToLower(host) // templates write REPLACEME in capitals; markers are lower case
	if strings.ContainsAny(host, "<>") {
		return true
	}
	for _, label := range strings.Split(host, ".") {
		for _, marker := range placeholderMarkers {
			if label == marker {
				return true
			}
			if strings.HasSuffix(marker, "-") && strings.HasPrefix(label, marker) {
				return true
			}
		}
	}
	return false
}

// committedSafeHosts are real public hostnames this repository commits on
// purpose. Each entry is a deliberate exception to hostname detection: add one
// only after confirming the value is not sensitive, and record why.
var committedSafeHosts = []string{
	// localdev's external-dns target: a fixed fake subdomain of a real
	// dynamic-DNS provider, committed so local development resolves.
	"homelab-dev.duckdns.org",

	// Public container registries. These name a global service, never this
	// infrastructure, and the localdev registry pull-through caches must
	// spell them out (scripts/localdev-kind.ts registryUpstreams, the Talos
	// registry mirrors in terragrunt). Guarding scripts/ brought them into
	// scope; they are public by definition.
	"docker.io",
	"registry-1.docker.io",
	"ghcr.io",
	"quay.io",
	"gcr.io",
	"registry.k8s.io",
}

// templateFileSuffixes mark a file whose values are placeholders by
// construction.
var templateFileSuffixes = []string{".example", ".template", ".sample", ".dist"}

// IsTemplateFile reports whether a path is an example or template file.
//
// These are held to a stricter rule rather than skipped. A documentation
// address such as 192.168.1.100 cannot be told from a real one by shape, so
// instead of clearing template files by shape the guard requires every
// PII-shaped key in them to carry a value from examplePlaceholder's closed
// set. That matters most for configuration/environments/homelab.yaml.example:
// it is the likeliest place for a real value to be pasted, and level 0 renders
// the homelab environment from it, so a paste there would flow straight into
// the committed snapshots.
func IsTemplateFile(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	for _, suffix := range templateFileSuffixes {
		if strings.HasSuffix(base, suffix) {
			return true
		}
	}
	return false
}

// examplePlaceholderSubnets are the address ranges a template file may use.
// 192.168.1.0/24 is this repository's documentation subnet, used throughout
// configuration/environments/homelab.yaml.example. It is private and routable,
// so shape detection cannot clear it on its own; listing it here is what makes
// every other address in a template a finding.
var examplePlaceholderSubnets = []string{
	"192.168.1.0/24",
	"127.0.0.0/8",
	// RFC 5737 TEST-NET-1, reserved for documentation and unroutable by
	// definition — so unlike 192.168.1.0/24 it cannot be a real address a paste
	// smuggled in. configuration/environments/single-node.yaml.example uses it,
	// deliberately distinct from the RFC 1918 range in homelab.yaml.example:
	// docs/contracts/fork-ability.md requires the two not to overlap, or the
	// grep cannot tell a leaked real value from a placeholder.
	//
	// Only TEST-NET-1 is listed. TEST-NET-2 (198.51.100.0/24) and TEST-NET-3
	// (203.0.113.0/24) are equally reserved but unused here, and 203.0.113.10
	// is an existing isExamplePlaceholder case asserting a public address is
	// NOT a placeholder — widening to all three would silently retire it.
	"192.0.2.0/24",
}

// examplePlaceholderHosts are the documented placeholder domains a template
// file may name, including mailboxes on them such as you@example.com. The
// REPLACEME convention is handled by placeholderMarkers, which both the
// template and the plain path share, so REPLACEME-domain.com needs no entry
// here.
var examplePlaceholderHosts = []string{
	"example.com",
	"example.org",
	"example.net",
}

// isExamplePlaceholder reports whether a value is one of the documented
// placeholders a template file is allowed to carry on a PII-shaped key.
//
// The rule is a closed allowlist, not a heuristic: anything a template says
// that is not on this list is reported, because a template has no business
// holding a value nobody wrote down here.
func isExamplePlaceholder(value string) bool {
	v := strings.TrimSpace(strings.ToLower(value))
	if v == "" || v == `""` || v == "''" {
		return true
	}
	// The REPLACEME convention, judged on the reduced host so that a marker in
	// a mailbox local part or a URL path cannot excuse a real host. Shared with
	// the plain path, so neither can be laxer than the other.
	if hasPlaceholderMarker(hostOf(v)) {
		return true
	}

	// An address, bare or with a port, must fall inside a placeholder subnet.
	if ip := net.ParseIP(hostOf(v)); ip != nil {
		return ipInAny(ip, examplePlaceholderSubnets)
	}
	// A CIDR value must sit inside a placeholder subnet too.
	if ip, _, err := net.ParseCIDR(v); err == nil {
		return ipInAny(ip, examplePlaceholderSubnets)
	}
	// A name=CIDR list (NETWORK_NAMES) must keep every CIDR inside one.
	if cidrs, ok := namedCIDRs(v); ok {
		for _, ip := range cidrs {
			if !ipInAny(ip, examplePlaceholderSubnets) {
				return false
			}
		}
		return true
	}

	host := hostOf(v)
	for _, h := range examplePlaceholderHosts {
		if host == h || strings.HasSuffix(host, "."+h) {
			return true
		}
	}
	// Reserved suffixes are placeholders by definition (RFC 2606, RFC 6761).
	for _, suffix := range reservedHostSuffixes {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	return false
}

// namedCIDRs parses a comma-separated name=CIDR list into the network addresses.
func namedCIDRs(v string) ([]net.IP, bool) {
	var ips []net.IP
	for _, item := range strings.Split(v, ",") {
		_, cidr, found := strings.Cut(item, "=")
		ip, _, err := net.ParseCIDR(strings.TrimSpace(cidr))
		if !found || err != nil {
			return nil, false
		}
		ips = append(ips, ip)
	}
	return ips, true
}

// ipInAny reports whether ip falls inside any of the given CIDRs.
func ipInAny(ip net.IP, cidrs []string) bool {
	for _, cidr := range cidrs {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// hostOf reduces a value to the hostname it contains, dropping a URL scheme
// and path, an email mailbox and a trailing port.
func hostOf(v string) string {
	v = strings.TrimSpace(strings.ToLower(v))
	if i := strings.Index(v, "://"); i >= 0 {
		v = v[i+3:]
	}
	if i := strings.IndexAny(v, "/?#"); i >= 0 {
		v = v[:i]
	}
	if i := strings.LastIndex(v, "@"); i >= 0 {
		v = v[i+1:]
	}
	// Strip a port, but leave an IPv6 literal alone.
	if strings.Count(v, ":") == 1 {
		v = v[:strings.LastIndex(v, ":")]
	}
	return strings.Trim(v, ".")
}

// isRealHostname reports whether a value names a host, domain or mailbox that
// could identify real infrastructure. Documentation placeholders, reserved
// suffixes and the committed-safe allowlist are excluded. IP addresses are
// handled by isRoutableHostIP instead.
func isRealHostname(v string) bool {
	host := hostOf(v)
	if host == "" || !strings.Contains(host, ".") {
		return false
	}
	if net.ParseIP(host) != nil {
		return false
	}
	if hasPlaceholderMarker(host) {
		return false
	}
	for _, p := range placeholderHosts {
		if host == p {
			return false
		}
	}
	for _, suffix := range reservedHostSuffixes {
		if strings.HasSuffix(host, suffix) {
			return false
		}
	}
	for _, safe := range committedSafeHosts {
		if host == safe || strings.HasSuffix(host, "."+safe) {
			return false
		}
	}
	// Require a plausible alphabetic TLD, so a version string or a filename
	// does not read as a domain.
	tld := host[strings.LastIndex(host, ".")+1:]
	if len(tld) < 2 {
		return false
	}
	for _, r := range tld {
		if r < 'a' || r > 'z' {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Helm values keys
// ---------------------------------------------------------------------------

// chartPIIKeys are the lowercase and camelCase Helm values keys whose scalar
// value names a host, address or mailbox. They are the keys the child charts'
// values-homelab.yaml files hand to routes, iSCSI volumes, cluster issuers
// and gateways, which is where the production identity used to live.
// Keys are compared lowercased, so `staticIP`, `staticip` and `StaticIP` are
// the same entry.
//
// The set is closed on purpose. `repoUrl`, `server`, `providerURL`, `url` and
// `description` legitimately carry github.com, letsencrypt.org and
// accounts.google.com, so they are not here: a key earns an entry only when
// every real value it can hold would identify this installation.
var chartPIIKeys = map[string]bool{
	"domain":         true,
	"host":           true,
	"hostname":       true,
	"portal":         true,
	"portals":        true,
	"targetportal":   true,
	"staticip":       true,
	"ip":             true,
	"address":        true,
	"email":          true,
	"dnsname":        true,
	"subdomain":      true,
	"loadbalancerip": true,
	"externalip":     true,
}

// chartPIIListKeys are the Helm values keys whose value is a list of hosts or
// domains rather than one scalar: each bare `- item` nested under them is
// judged on its own. A flow-style list (`dnsZones: [a, b]`, on one line or
// spanning several) is judged item by item too, as is a list inside a flow
// mapping (`- {hosts: [a], secretName: x}`).
var chartPIIListKeys = map[string]bool{
	"dnszones":           true,
	"alloweddomains":     true,
	"alloweduserdomains": true,
	"hosts":              true,
	"dnsnames":           true,
	"portals":            true,
}

// chartKeyLine matches a `key: value` line in Helm values, optionally as a
// list item (`- host: value`), capturing the indentation, the key and the
// value. The value is optional so a key opening a nested block or a list
// (`dnsZones:`) matches too. A key may be an annotation name such as
// external-dns.alpha.kubernetes.io/hostname; only its last path segment is
// looked up, so that form is judged as `hostname`. The key may be quoted, as
// annotation names often are.
var chartKeyLine = regexp.MustCompile(`^(\s*)(?:-\s+)?["']?([A-Za-z][A-Za-z0-9_./-]*)["']?\s*:(?:\s+(.*?))?\s*$`)

// chartListItemLine matches a bare YAML sequence item, capturing the
// indentation and the item.
var chartListItemLine = regexp.MustCompile(`^(\s*)-\s+(\S.*?)\s*$`)

// chartKeyName reduces a key as written to the name looked up in the key
// sets: lowercased, and for an annotation-style key only the segment after
// the last slash.
func chartKeyName(key string) string {
	if i := strings.LastIndex(key, "/"); i >= 0 {
		key = key[i+1:]
	}
	return strings.ToLower(key)
}

// isScreamingKey reports whether a key is SCREAMING_SNAKE, the shape of a
// configuration/ key. Such a key belongs to the config rule (IsPIIKey)
// whichever way that rule decides, so the Helm rule never second-guesses it.
func isScreamingKey(key string) bool {
	return key == strings.ToUpper(key)
}

// flowListItems splits a flow-style YAML sequence (`[a, b]`) into its items,
// each stripped of quotes. A value that is not a flow sequence yields nil.
func flowListItems(value string) []string {
	v := strings.TrimSpace(value)
	if len(v) < 2 || v[0] != '[' || v[len(v)-1] != ']' {
		return nil
	}
	return splitFlowItems(v[1 : len(v)-1])
}

// splitFlowItems splits the body of a flow-style sequence (the text between
// `[` and `]`, or one line of a sequence that spans lines) into its items,
// each stripped of quotes.
func splitFlowItems(body string) []string {
	var items []string
	for _, item := range strings.Split(body, ",") {
		if item = stripValue(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}

// flowMapPair matches one `key: value` pair inside a flow mapping
// (`{host: a, paths: [/]}`). A value runs to the next comma or brace, or is
// one whole bracketed flow list, so a list-valued key is judged item by item.
var flowMapPair = regexp.MustCompile(`([A-Za-z][A-Za-z0-9_./-]*)\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|[^,{}]+)`)

// classifyHostValue reports what kind of real infrastructure a Helm value
// names, or "" when it is safe to commit. The value is reduced with hostOf
// first, so an iSCSI portal with a port (`192.0.2.150:3260`) or a URL
// wrapping an address (`https://192.0.2.1`) is judged on its address.
func classifyHostValue(value string) string {
	// A CIDR names a network, not a host. The config rule never flags one
	// (isRoutableHostIP cannot parse it) and isExamplePlaceholder handles it
	// on its own, so this rule agrees rather than reducing it to its address.
	if _, _, err := net.ParseCIDR(strings.TrimSpace(value)); err == nil {
		return ""
	}
	switch {
	case isRoutableHostIP(hostOf(value)):
		return "routable host IP"
	case isRealHostname(value):
		return "real hostname"
	}
	return ""
}

// ScanFileForPIIShape reports PII-shaped keys whose value looks like real
// infrastructure: a routable host address, or a hostname, domain or mailbox
// outside the placeholder and allowlisted sets. It needs no resolved config,
// so it keeps working in a clone without the real environment file, where
// value-based detection is impossible.
//
// Two key rules run over the same line loop. A SCREAMING_SNAKE key is a
// configuration/ key and is judged by IsPIIKey exactly as before; any other
// key is a Helm values key and is judged by chartPIIKeys, or, for a bare
// `- item` nested under one of chartPIIListKeys, by that list. Each line is
// decided by one rule, so a line is never reported twice.
//
// In a template file the test inverts: every PII-shaped key must carry a
// documented placeholder, and anything else is reported. See IsTemplateFile.
// An unreadable file is an error, never an empty (clean) result.
func ScanFileForPIIShape(path string) (GuardResult, error) {
	result := GuardResult{File: path}
	template := IsTemplateFile(path)
	// In a code file only a quoted literal can be a real value; see
	// isShapeCodeFile.
	code := isShapeCodeFile(path)

	f, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer f.Close()

	// judge decides one value on one key and records the finding. In a
	// template file the value is judged against the closed placeholder set
	// rather than by shape, so a real value pasted into it is reported even
	// when it is neither an address nor a hostname (a real username, say).
	judge := func(lineNum int, line, key, value string) {
		if template {
			if isExamplePlaceholder(value) {
				return
			}
			result.Matches = append(result.Matches, GuardMatch{
				Line:    lineNum,
				Pattern: key + " (non-placeholder value in example file)",
				Content: line,
				Note:    fmt.Sprintf("non-placeholder value in example file (%s)", value),
			})
			return
		}
		kind := classifyHostValue(value)
		if kind == "" {
			return
		}
		result.Matches = append(result.Matches, GuardMatch{
			Line:    lineNum,
			Pattern: key + " (" + kind + ")",
			Content: line,
		})
	}

	// judgeItems judges the items of a flow list on key. The list sits on one
	// line and a line is reported once, so it stops at the first finding.
	judgeItems := func(lineNum int, line, key string, items []string) {
		before := len(result.Matches)
		for _, item := range items {
			judge(lineNum, line, key+"[]", item)
			if len(result.Matches) > before {
				return
			}
		}
	}

	// judgeFlowMapping judges every `key: value` pair of a flow mapping
	// (`- {host: a, paths: [/]}`) by the same key sets as the block form,
	// stopping at the first finding so a line is reported once.
	judgeFlowMapping := func(lineNum int, line, mapping string) {
		before := len(result.Matches)
		for _, pair := range flowMapPair.FindAllStringSubmatch(mapping, -1) {
			key, raw := pair[1], pair[2]
			if isScreamingKey(key) {
				continue
			}
			name := chartKeyName(key)
			if code && !isQuotedLiteral(raw) {
				continue // an identifier, not a value; see isShapeCodeFile
			}
			switch {
			case chartPIIListKeys[name]:
				judgeItems(lineNum, line, key, flowListItems(raw))
			case chartPIIKeys[name]:
				if value := stripValue(raw); value != "" {
					judge(lineNum, line, key, value)
				}
			}
			if len(result.Matches) > before {
				return
			}
		}
	}

	// The list the scanner is inside, if any: the key as written (for the
	// Pattern) and the column of that key. Items belong to the list while they
	// sit at or right of that column; the first key line, or a shallower item,
	// closes it. Blank and comment lines are transparent.
	//
	// flowKey is the list key whose flow sequence opened on an earlier line
	// (`dnsZones: [`) and has not reached its closing bracket yet.
	var (
		listKey    string
		listIndent int
		flowKey    string
	)

	scanner := bufio.NewScanner(f)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}

		// The rest of a flow list that opened on an earlier line: every line
		// up to the closing bracket carries items.
		if flowKey != "" {
			body, _, closed := strings.Cut(trimmed, "]")
			judgeItems(lineNum, line, flowKey, splitFlowItems(body))
			if closed {
				flowKey = ""
			}
			continue
		}

		// Config rule: a SCREAMING_SNAKE key with an inline value.
		if m := configKeyLine.FindStringSubmatch(line); m != nil {
			listKey = ""
			if !IsPIIKey(m[1]) {
				continue
			}
			rawValue := m[2]
			if code {
				rawValue = strings.TrimSuffix(strings.TrimSpace(rawValue), ",")
				if !isQuotedLiteral(rawValue) {
					continue // an identifier, not a value
				}
			}
			value := stripValue(rawValue)

			if template {
				if isExamplePlaceholder(value) {
					continue
				}
				result.Matches = append(result.Matches, GuardMatch{
					Line:    lineNum,
					Pattern: m[1] + " (non-placeholder value in example file)",
					Content: line,
					Note:    fmt.Sprintf("non-placeholder value in example file (%s)", value),
				})
				continue
			}

			var kind string
			switch {
			case isRoutableHostIP(value):
				kind = "routable host IP"
			case isRealHostname(value):
				kind = "real hostname"
			default:
				continue
			}

			result.Matches = append(result.Matches, GuardMatch{
				Line:    lineNum,
				Pattern: m[1] + " (" + kind + ")",
				Content: line,
			})
			continue
		}

		// Helm rule: a `key: value` line, possibly itself a list item.
		if m := chartKeyLine.FindStringSubmatch(line); m != nil {
			listKey = ""
			// In a code file a trailing comma belongs to the object literal,
			// not to the value: without stripping it "host.name", never
			// parses as a hostname.
			rawValue := m[3]
			if code {
				rawValue = strings.TrimSuffix(strings.TrimSpace(rawValue), ",")
			}
			indent, key, value := len(m[1]), m[2], stripValue(rawValue)
			if isScreamingKey(key) {
				continue
			}
			name := chartKeyName(key)
			raw := strings.TrimSpace(rawValue)
			if code && raw != "" && !strings.HasPrefix(raw, "{") &&
				!isQuotedLiteral(raw) {
				continue // an identifier, not a value; see isShapeCodeFile
			}
			if strings.HasPrefix(raw, "{") {
				// A flow mapping value (`dashboard: {host: a}`) is judged by
				// the keys inside it.
				judgeFlowMapping(lineNum, line, raw)
				continue
			}
			switch {
			case chartPIIListKeys[name] && value == "":
				// The list opens here; its items follow on their own lines.
				listKey = key
				listIndent = indent
				if strings.HasPrefix(trimmed, "-") {
					listIndent += 2 // the key sits after the `- ` marker
				}
			case chartPIIListKeys[name] && strings.HasPrefix(raw, "[") && !strings.Contains(raw, "]"):
				// The flow list opens here and continues on the following
				// lines; whatever items share this line are judged now.
				flowKey = key
				judgeItems(lineNum, line, key, splitFlowItems(raw[1:]))
			case chartPIIListKeys[name]:
				judgeItems(lineNum, line, key, flowListItems(raw))
			case chartPIIKeys[name] && value != "":
				judge(lineNum, line, key, value)
			}
			continue
		}

		// A bare item: a flow mapping (`- {host: a, paths: [/]}`) is judged by
		// its own keys whichever list it sits in; a scalar belongs to the open
		// list, if any.
		if m := chartListItemLine.FindStringSubmatch(line); m != nil {
			if strings.HasPrefix(m[2], "{") {
				judgeFlowMapping(lineNum, line, m[2])
				continue
			}
			if listKey != "" {
				if len(m[1]) < listIndent {
					listKey = ""
					continue
				}
				judge(lineNum, line, listKey+"[]", stripValue(m[2]))
				continue
			}
		}

		// Anything else (a block scalar line, prose) closes the list.
		listKey = ""
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}

	return result, nil
}

// stripValue removes an inline comment and surrounding quotes from a YAML
// scalar so the bare value can be classified.
// isShapeCodeFile reports whether shape rules must see a quoted string literal
// before they judge a `key: value` line.
//
// Shape detection was written for YAML and Helm values, where `host: foo.bar`
// means the value foo.bar. In TypeScript the same line is a property
// assignment: `host: args.proxmoxHost` names an identifier that has the shape
// of a hostname without being one, and flagging it blocks a commit over a
// variable reference. Only a quoted literal in a code file can be a real
// value, so `host: "truenas.example.com"` is still judged.
//
// Go is here for the same reason and it is not optional: a Go composite
// literal writes `Host: cfg.ProxmoxHost`, and `cfg.ProxmoxHost` has the shape
// of a hostname — a dotted name whose last label is all letters — so without
// this every struct field assignment from a variable would be reported as a
// real hostname. Adding .go to guardScanExtensions without adding it here
// makes the guard unusable on Go, not stricter.
func isShapeCodeFile(path string) bool {
	ext := filepath.Ext(path)
	return strings.EqualFold(ext, ".ts") || strings.EqualFold(ext, ".go")
}

// isQuotedLiteral reports whether a raw value, as written before stripValue
// removes the quotes, is a quoted string. A trailing comma from an object
// literal is ignored.
func isQuotedLiteral(raw string) bool {
	v := strings.TrimSpace(raw)
	v = strings.TrimSpace(strings.TrimSuffix(v, ","))
	if len(v) < 2 {
		return false
	}
	q := v[0]
	return (q == '"' || q == '\'' || q == '`') && v[len(v)-1] == q
}

func stripValue(v string) string {
	if i := strings.Index(v, " #"); i >= 0 {
		v = v[:i]
	}
	v = strings.TrimSpace(v)
	// The backtick is here because isQuotedLiteral already accepts one: a Go
	// raw string and a TypeScript template literal are quoted literals, so a
	// hostname written in one must reduce to the hostname rather than keeping
	// its quotes and failing to parse as a host.
	return strings.Trim(v, "\"'`")
}

// isRoutableHostIP reports whether a value is an IP address that could identify
// a real host. Loopback, unspecified, link-local and multicast addresses are
// safe to commit; a CIDR does not parse and is therefore never flagged.
func isRoutableHostIP(v string) bool {
	ip := net.ParseIP(v)
	if ip == nil {
		return false
	}
	return !ip.IsLoopback() && !ip.IsUnspecified() &&
		!ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsMulticast()
}

// ---------------------------------------------------------------------------
// Scan driver
// ---------------------------------------------------------------------------

// ErrGuardNoFiles means the scan scope resolved to nothing. In CI that is a
// failure, never a pass: a guard that scans zero files proves nothing.
var ErrGuardNoFiles = errors.New("guard scan scope is empty")

// patternSources are the files the value pattern set was built from. Scanning
// one of them against its own values reports every line of it, which is how
// `config guard --set localdev --ci` came to fail on a clean tree: the
// patterns were built from localdev.yaml and then hunted for in localdev.yaml.
//
// Shape rules still apply to these files. Those are the rules that matter
// here: a real routable address or a real hostname in an environment file is
// reported by shape whether or not the file also defines the pattern.
//
// Identity is compared with os.SameFile rather than by string, so an absolute
// --env-file, a repository-relative path and a symlinked temp directory all
// resolve to the same file.
type patternSources struct {
	infos []os.FileInfo
	names []string
}

// newPatternSources resolves the files that contribute to the value patterns:
// the environment file the caller selected (via --set or --env-file) and the
// defaults layer merged underneath it.
func newPatternSources(repoRoot, envPath string) patternSources {
	var ps patternSources
	add := func(p string) {
		if p == "" {
			return
		}
		if !filepath.IsAbs(p) && repoRoot != "" {
			p = filepath.Join(repoRoot, p)
		}
		fi, err := os.Stat(p)
		if err != nil {
			return
		}
		ps.infos = append(ps.infos, fi)
		ps.names = append(ps.names, filepath.Clean(p))
	}
	add(envPath)
	// defaults.yaml sits next to the environment file. Fall back to the
	// conventional location when no environment file was given.
	if envPath != "" {
		add(filepath.Join(filepath.Dir(envPath), "defaults.yaml"))
	} else {
		add(filepath.Join("configuration", "environments", "defaults.yaml"))
	}
	return ps
}

// contains reports whether path names one of the pattern source files.
func (ps patternSources) contains(path string) bool {
	if len(ps.infos) == 0 {
		return false
	}
	fi, err := os.Stat(path)
	if err != nil {
		return false
	}
	for _, other := range ps.infos {
		if os.SameFile(fi, other) {
			return true
		}
	}
	return false
}

// dropSetName removes the environment's own name from the value patterns. The
// set name is the stem of the environment file (localdev.yaml -> localdev) and
// is written all over the repository on purpose: schema comments, task names,
// values-<set>.yaml file names, docs. A value that merely equals it (localdev
// uses it as NFS_MAPALL_USER) cannot name real infrastructure, so hunting for
// it only produces false positives on prose that mentions the environment.
func dropSetName(patterns []string, envPath string) []string {
	set := strings.TrimSuffix(filepath.Base(envPath), filepath.Ext(envPath))
	if set == "" {
		return patterns
	}
	out := patterns[:0:0]
	for _, p := range patterns {
		if p != set {
			out = append(out, p)
		}
	}
	return out
}

// GuardOptions configures a scan.
type GuardOptions struct {
	// RepoRoot is the repository root that pathspecs resolve against.
	RepoRoot string
	// Files is an explicit file list (the pre-commit path). When set,
	// Pathspecs and the tracked-file lister are not consulted.
	Files []string
	// Pathspecs narrows or widens the tracked-file scope. Empty means
	// DefaultGuardPathspecs.
	Pathspecs []string
	// CI derives the file list from tracked files and makes an empty scope an
	// error rather than a silent pass.
	CI bool
	// EnvPath is the environment file supplying value-based patterns. A
	// missing file degrades to shape-based detection instead of failing.
	EnvPath string
}

// GuardReport is the outcome of a scan.
type GuardReport struct {
	// Files are the paths actually scanned.
	Files []string
	// ValuePatterns is the number of literal values guarded against.
	ValuePatterns int
	// EnvMissing is true when EnvPath did not exist, so value-based detection
	// was unavailable and only shape-based detection ran.
	EnvMissing bool
	// EnvPath echoes the environment file that was attempted.
	EnvPath string
	// Results holds one entry per file with at least one match.
	Results []GuardResult
	// Unreadable holds files the guard could not read. These are failures, not
	// passes: an unscanned file has not been cleared.
	Unreadable []GuardUnreadable
}

// GuardUnreadable is a file the guard could not open or read.
type GuardUnreadable struct {
	File string
	Err  error
}

// MatchCount totals the matches across every file.
func (r *GuardReport) MatchCount() int {
	n := 0
	for _, res := range r.Results {
		n += len(res.Matches)
	}
	return n
}

// RunGuard resolves the scan scope, builds the detection patterns and scans
// every file. A missing environment file is reported in the GuardReport rather
// than returned as an error, so a clone without the real values still gets
// shape-based protection.
func RunGuard(opts GuardOptions) (*GuardReport, error) {
	report := &GuardReport{EnvPath: opts.EnvPath}

	files := opts.Files
	if len(files) == 0 && opts.CI {
		listed, err := ListGuardFiles(opts.RepoRoot, opts.Pathspecs)
		if err != nil {
			return report, err
		}
		files = listed
	}
	report.Files = files

	if opts.CI && len(files) == 0 {
		return report, ErrGuardNoFiles
	}

	var patterns []string
	if opts.EnvPath != "" {
		env, err := LoadEnvironment(opts.EnvPath)
		switch {
		case err == nil:
			patterns = dropSetName(BuildGuardPatterns(env), opts.EnvPath)
		case errors.Is(err, fs.ErrNotExist):
			report.EnvMissing = true
		default:
			return report, err
		}
	} else {
		report.EnvMissing = true
	}
	report.ValuePatterns = len(patterns)
	sources := newPatternSources(opts.RepoRoot, opts.EnvPath)

	for _, f := range files {
		// git ls-files yields repository-relative paths, and pre-commit passes
		// paths relative to the repository root too, so resolve against
		// RepoRoot rather than the process working directory. Without this the
		// guard opened nothing when invoked from a subdirectory and reported
		// every file as clean.
		abs := resolveScanPath(opts.RepoRoot, f)

		merged := GuardResult{File: f}
		flagged := map[int]bool{}

		// A file that fed the pattern set is scanned by shape only.
		if len(patterns) > 0 && !sources.contains(abs) {
			res, err := ScanFileForPII(abs, patterns)
			if err != nil {
				report.Unreadable = append(report.Unreadable, GuardUnreadable{File: f, Err: err})
				continue
			}
			for _, m := range res.Matches {
				merged.Matches = append(merged.Matches, m)
				flagged[m.Line] = true
			}
		}
		// Shape-based hits on a line already reported by value-based detection
		// would be the same leak twice.
		shape, err := ScanFileForPIIShape(abs)
		if err != nil {
			report.Unreadable = append(report.Unreadable, GuardUnreadable{File: f, Err: err})
			continue
		}
		for _, m := range shape.Matches {
			if flagged[m.Line] {
				continue
			}
			merged.Matches = append(merged.Matches, m)
		}

		if len(merged.Matches) > 0 {
			// Findings are ordered by (line, pattern) so two runs print the
			// same report: map iteration in the config layer and the two
			// detectors' independent passes otherwise leak their order here.
			sort.SliceStable(merged.Matches, func(i, j int) bool {
				if merged.Matches[i].Line != merged.Matches[j].Line {
					return merged.Matches[i].Line < merged.Matches[j].Line
				}
				return merged.Matches[i].Pattern < merged.Matches[j].Pattern
			})
			report.Results = append(report.Results, merged)
		}
	}

	// ...and by file across the report, which explicit-file invocations
	// (pre-commit) otherwise leave in argument order.
	sort.SliceStable(report.Results, func(i, j int) bool { return report.Results[i].File < report.Results[j].File })
	sort.SliceStable(report.Unreadable, func(i, j int) bool { return report.Unreadable[i].File < report.Unreadable[j].File })

	return report, nil
}

// resolveScanPath turns a scan path into something openable. An absolute path
// is used as given. A relative path is resolved against repoRoot, falling back
// to the working directory only when the repository-relative candidate does
// not exist, so an explicit relative argument still works.
func resolveScanPath(repoRoot, path string) string {
	if filepath.IsAbs(path) || repoRoot == "" {
		return path
	}
	joined := filepath.Join(repoRoot, path)
	if _, err := os.Stat(joined); err == nil {
		return joined
	}
	if _, err := os.Stat(path); err == nil {
		return path
	}
	// Neither exists: name the repository-relative candidate in the error.
	return joined
}
