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
	"EXTERNAL_DNS_DEFAULT_TARGET", "TRAEFIK_OIDC_ALLOWED_DOMAINS",
}

// piiKeySuffixes are config key suffixes whose values are likely PII.
// _VIP covers the control-plane virtual address, which holds a real host
// address but does not end in _IP.
var piiKeySuffixes = []string{
	"_IP", "_VIP", "_HOSTNAME",
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

		isPII := IsPIIKey(key)

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
			if strings.Contains(line, p) {
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
// `files: ^configuration/` pattern so the hook and CI agree on what is guarded.
// Widen it explicitly with --paths rather than changing this default.
var DefaultGuardPathspecs = []string{"configuration/**"}

// guardScanExtensions are the file types the guard knows how to read. Anything
// else (templates, binaries, .example files) is out of scope.
var guardScanExtensions = map[string]bool{
	".yaml": true,
	".yml":  true,
	".json": true,
	".md":   true,
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

// IsGuardExcluded mirrors the pre-commit hook's exclude list: the real
// environment file (which legitimately holds the values being guarded) and any
// generated export.
func IsGuardExcluded(path string) bool {
	clean := filepath.ToSlash(filepath.Clean(path))
	if clean == "configuration/environments/homelab.yaml" {
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

// ScanFileForPIIShape reports PII-shaped keys whose value looks like real
// infrastructure: a routable host address, or a hostname, domain or mailbox
// outside the placeholder and allowlisted sets. It needs no resolved config,
// so it keeps working in a clone without the real environment file, where
// value-based detection is impossible.
//
// In a template file the test inverts: every PII-shaped key must carry a
// documented placeholder, and anything else is reported. See IsTemplateFile.
// An unreadable file is an error, never an empty (clean) result.
func ScanFileForPIIShape(path string) (GuardResult, error) {
	result := GuardResult{File: path}
	template := IsTemplateFile(path)

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
		m := configKeyLine.FindStringSubmatch(line)
		if m == nil || !IsPIIKey(m[1]) {
			continue
		}
		value := stripValue(m[2])

		// A template file is judged against the closed placeholder set rather
		// than by shape, so a real value pasted into it is reported even when
		// it is neither an address nor a hostname (a real username, say).
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
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}

	return result, nil
}

// stripValue removes an inline comment and surrounding quotes from a YAML
// scalar so the bare value can be classified.
func stripValue(v string) string {
	if i := strings.Index(v, " #"); i >= 0 {
		v = v[:i]
	}
	v = strings.TrimSpace(v)
	return strings.Trim(v, `"'`)
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
			patterns = BuildGuardPatterns(env)
		case errors.Is(err, fs.ErrNotExist):
			report.EnvMissing = true
		default:
			return report, err
		}
	} else {
		report.EnvMissing = true
	}
	report.ValuePatterns = len(patterns)

	for _, f := range files {
		// git ls-files yields repository-relative paths, and pre-commit passes
		// paths relative to the repository root too, so resolve against
		// RepoRoot rather than the process working directory. Without this the
		// guard opened nothing when invoked from a subdirectory and reported
		// every file as clean.
		abs := resolveScanPath(opts.RepoRoot, f)

		merged := GuardResult{File: f}
		flagged := map[int]bool{}

		if len(patterns) > 0 {
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
			sort.SliceStable(merged.Matches, func(i, j int) bool { return merged.Matches[i].Line < merged.Matches[j].Line })
			report.Results = append(report.Results, merged)
		}
	}

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
