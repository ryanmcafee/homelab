package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeExampleSet writes template ConfigSets into a temp directory and returns
// its path.
func writeExampleSet(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatalf("writing %s: %v", name, err)
		}
	}
	return dir
}

// TestExampleConfigSetsAreDisjoint is the gate itself, run against the real
// tree. docs/contracts/fork-ability.md check 1 greps a render for values from
// the real environment; that grep cannot tell a leak from a placeholder if two
// committed ConfigSets share a range.
func TestExampleConfigSetsAreDisjoint(t *testing.T) {
	root := findProjectRootForTest(t)
	dir := filepath.Join(root, "configuration", "environments")

	collisions, err := ExampleConfigSetCollisions(dir)
	if err != nil {
		t.Fatalf("scanning %s: %v", dir, err)
	}
	if len(collisions) > 0 {
		t.Errorf("example ConfigSets share address ranges, so a render-grep cannot tell a "+
			"leaked real value from a placeholder (docs/contracts/fork-ability.md, check 1).\n"+
			"Give each *.yaml.example its own range:\n  %s",
			strings.Join(collisions, "\n  "))
	}

	// A pass here must mean something was actually compared. If the glob
	// stopped matching, the assertion above would be vacuously true forever.
	ranges, err := ExampleConfigSetRanges(filepath.Join(dir, "homelab.yaml.example"))
	if err != nil {
		t.Fatalf("reading homelab.yaml.example: %v", err)
	}
	if len(ranges) == 0 {
		t.Fatal("homelab.yaml.example declared no address ranges; the scanner is not reading it")
	}
}

// TestExampleConfigSetCollisionsDetectsDrift proves the gate on bad input. The
// first case is the exact scenario this check exists for: homelab.yaml.example
// drifting into the RFC 5737 range a one-node example already uses.
func TestExampleConfigSetCollisionsDetectsDrift(t *testing.T) {
	tests := []struct {
		name  string
		files map[string]string
		want  []string // substrings every message set must contain
	}{
		{
			name: "homelab drifts into the one-node example's RFC 5737 range",
			files: map[string]string{
				"homelab.yaml.example": "GATEWAY_IP: \"192.0.2.1\"\nCP1_IP: \"192.0.2.11\"\n",
				"single-node.yaml.example": "GATEWAY_IP: \"192.0.2.1\"\n" +
					"NFS_SHARE_ALLOW: \"192.0.2.0/24\"\n",
			},
			want: []string{"homelab.yaml.example", "single-node.yaml.example", "192.0.2"},
		},
		{
			name: "a host address inside the other file's CIDR",
			files: map[string]string{
				"a.yaml.example": "CP1_IP: \"192.168.1.11\"\n",
				"b.yaml.example": "NFS_SHARE_ALLOW: \"192.168.1.0/24\"\n",
			},
			want: []string{"CP1_IP", "NFS_SHARE_ALLOW"},
		},
		{
			name: "one CIDR inside another",
			files: map[string]string{
				"a.yaml.example": "TAILSCALE_ADVERTISE_ROUTES: \"192.168.0.0/16\"\n",
				"b.yaml.example": "NETWORK_NAMES: \"lan=192.168.1.128/25\"\n",
			},
			want: []string{"192.168.0.0/16", "192.168.1.128/25"},
		},
		{
			name: "a third ConfigSet reusing an existing range",
			files: map[string]string{
				"a.yaml.example": "CP1_IP: \"192.0.2.11\"\n",
				"b.yaml.example": "CP1_IP: \"198.51.100.11\"\n",
				"c.yaml.example": "CP1_IP: \"198.51.100.12\"\n",
			},
			want: []string{"b.yaml.example", "c.yaml.example"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			collisions, err := ExampleConfigSetCollisions(writeExampleSet(t, tt.files))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(collisions) == 0 {
				t.Fatal("expected a collision, got none — the gate would accept this tree")
			}
			joined := strings.Join(collisions, "\n")
			for _, want := range tt.want {
				if !strings.Contains(joined, want) {
					t.Errorf("collision message does not name %q:\n%s", want, joined)
				}
			}
		})
	}
}

func TestExampleConfigSetCollisionsAcceptsDisjointSets(t *testing.T) {
	tests := []struct {
		name  string
		files map[string]string
	}{
		{
			name: "RFC 1918 and RFC 5737 side by side",
			files: map[string]string{
				"homelab.yaml.example": "GATEWAY_IP: \"192.168.1.1\"\n" +
					"CP1_IP: \"192.168.1.11\"\n" +
					"NETWORK_NAMES: \"homelab=192.168.1.0/25,lan=192.168.1.128/25\"\n",
				"single-node.yaml.example": "GATEWAY_IP: \"192.0.2.1\"\n" +
					"CP1_IP: \"192.0.2.11\"\n",
			},
		},
		{
			name: "loopback is shared on purpose and never collides",
			files: map[string]string{
				"a.yaml.example": "GATEWAY_IP: \"127.0.0.1\"\nCP1_IP: \"192.168.1.11\"\n",
				"b.yaml.example": "GATEWAY_IP: \"127.0.0.1\"\nCP1_IP: \"192.0.2.11\"\n",
			},
		},
		{
			name: "a range named in a comment is prose, not a declaration",
			files: map[string]string{
				"a.yaml.example": "CP1_IP: \"192.168.1.11\"\n",
				"b.yaml.example": "# on a 192.168.1.0/24 LAN, set this to your gateway\n" +
					"CP1_IP: \"192.0.2.11\" # not 192.168.1.11\n",
			},
		},
		{
			name: "a single ConfigSet cannot collide with itself",
			files: map[string]string{
				"homelab.yaml.example": "GATEWAY_IP: \"192.168.1.1\"\n" +
					"NFS_SHARE_ALLOW: \"192.168.1.0/24\"\n",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			collisions, err := ExampleConfigSetCollisions(writeExampleSet(t, tt.files))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(collisions) > 0 {
				t.Errorf("expected no collisions, got:\n%s", strings.Join(collisions, "\n"))
			}
		})
	}
}

// TestDocumentationAddressFindingNamesThePlaceholderConvention covers the
// second half of the change: an RFC 5737 address outside a template file is
// still reported (fail-closed), but the message points at the <KEY> placeholder
// convention instead of calling a documentation-reserved address routable.
func TestDocumentationAddressFindingNamesThePlaceholderConvention(t *testing.T) {
	tests := []struct {
		name    string
		file    string
		content string
		wantDoc bool
	}{
		{
			name:    "RFC 5737 in a runbook",
			file:    "docs/runbooks/talos-upgrade.md",
			content: "CP1_IP: \"192.0.2.11\"\n",
			wantDoc: true,
		},
		{
			name:    "RFC 3849 IPv6 in a runbook",
			file:    "docs/runbooks/talos-upgrade.md",
			content: "GATEWAY_IP: \"2001:db8::1\"\n",
			wantDoc: true,
		},
		{
			name:    "a chart value in the documentation range",
			file:    "charts/a/values-homelab.yaml",
			content: "loadBalancerIP: \"203.0.113.9\"\n",
			wantDoc: true,
		},
		{
			name:    "an ordinary routable address keeps the plain wording",
			file:    "docs/runbooks/talos-upgrade.md",
			content: "CP1_IP: \"198.18.0.11\"\n",
			wantDoc: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// The base name keeps the extension the scanner keys on, and is not
			// a template suffix, so the non-template rule runs.
			path := filepath.Join(t.TempDir(), filepath.Base(tt.file))
			if err := os.WriteFile(path, []byte(tt.content), 0o644); err != nil {
				t.Fatal(err)
			}

			result, err := ScanFileForPIIShape(path)
			if err != nil {
				t.Fatalf("scanning: %v", err)
			}
			if len(result.Matches) != 1 {
				t.Fatalf("expected exactly 1 finding, got %d: %+v", len(result.Matches), result.Matches)
			}
			got := result.Matches[0].Pattern

			if tt.wantDoc {
				if !strings.Contains(got, "<CP1_IP>") {
					t.Errorf("finding does not name the placeholder convention: %q", got)
				}
				if !strings.Contains(got, "docs/runbooks/tailscale-dns.md") {
					t.Errorf("finding does not point at the convention's runbook: %q", got)
				}
				if strings.Contains(got, "routable host IP") {
					t.Errorf("documentation address still reported as a routable host IP: %q", got)
				}
				return
			}
			if !strings.Contains(got, "routable host IP") {
				t.Errorf("expected the plain routable-host-IP wording, got %q", got)
			}
		})
	}
}
