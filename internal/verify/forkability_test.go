package verify

import (
	"strings"
	"testing"
)

// sanctionedSet is the ConfigSet-supplied address set a fixture renders from.
func sanctionedSet(addrs ...string) map[string]bool {
	out := map[string]bool{}
	for _, a := range addrs {
		out[a] = true
	}
	return out
}

func TestScanAddressesFlagsAnAddressNoConfigSetKeySupplied(t *testing.T) {
	// The negative fixture: an address hard-coded in a values file. Nothing in
	// the ConfigSet supplies it, so a fork renders this operator's NAS.
	render := "storage:\n  portal: 192.168.7.50:3260\n"

	leaks := scanAddresses("homelab/_values/addons.yaml", []byte(render), sanctionedSet("192.168.1.100"))

	if len(leaks) != 1 {
		t.Fatalf("want 1 leak, got %d: %+v", len(leaks), leaks)
	}
	if leaks[0].Address != "192.168.7.50" {
		t.Errorf("address = %q, want 192.168.7.50", leaks[0].Address)
	}
	if leaks[0].Line != 2 {
		t.Errorf("line = %d, want 2", leaks[0].Line)
	}
}

func TestScanAddressesAcceptsAnAddressTheConfigSetSupplied(t *testing.T) {
	// Provenance, not shape: the same RFC 1918 address is fine when TRUENAS_IP
	// put it there, which is why a range denylist cannot be the rule.
	render := "storage:\n  portal: 192.168.1.100:3260\n  host: 192.168.1.100\n"

	if leaks := scanAddresses("homelab/addons.yaml", []byte(render), sanctionedSet("192.168.1.100")); len(leaks) != 0 {
		t.Fatalf("want no leaks for a ConfigSet-supplied address, got %+v", leaks)
	}
}

func TestScanAddressesAcceptsAnAddressEmbeddedInACompoundConfigValue(t *testing.T) {
	// NETWORK_NAMES is "homelab=192.168.1.0/25,lan=192.168.1.128/25" and the
	// render spells the halves out separately.
	render := `query: "homelab=192.168.1.0/25,lan=192.168.1.128/25"` + "\n"

	if leaks := scanAddresses("homelab/clickhouse.yaml", []byte(render), sanctionedSet("192.168.1.0", "192.168.1.128")); len(leaks) != 0 {
		t.Fatalf("want no leaks, got %+v", leaks)
	}
}

func TestScanAddressesIgnoresNonRoutableAddresses(t *testing.T) {
	render := strings.Join([]string{
		"bind: 0.0.0.0",
		"loopback: 127.0.0.1",
		"linkLocal: 169.254.1.1",
		"multicast: 224.0.0.251",
		"broadcast: 255.255.255.255",
	}, "\n")

	if leaks := scanAddresses("homelab/addons.yaml", []byte(render), sanctionedSet()); len(leaks) != 0 {
		t.Fatalf("want no leaks for non-routable addresses, got %+v", leaks)
	}
}

func TestScanAddressesIgnoresAnImageTagThatParsesAsAnAddress(t *testing.T) {
	// clickhouse/clickhouse-server:26.8.10.6 is a valid IPv4 and is not one.
	render := "image: clickhouse/clickhouse-server:26.8.10.6\n"

	if leaks := scanAddresses("homelab/clickhouse.yaml", []byte(render), sanctionedSet()); len(leaks) != 0 {
		t.Fatalf("want no leaks for an image tag, got %+v", leaks)
	}
}

func TestScanAddressesStillFlagsAnAddressWithAPortSuffix(t *testing.T) {
	// The image-tag rule must not swallow a real host:port, where the address
	// sits before the colon rather than after it.
	render := "portal: 10.20.30.40:3260\n"

	leaks := scanAddresses("homelab/addons.yaml", []byte(render), sanctionedSet())
	if len(leaks) != 1 || leaks[0].Address != "10.20.30.40" {
		t.Fatalf("want 10.20.30.40 flagged, got %+v", leaks)
	}
}

func TestScanAddressesIgnoresAllowlistedPublicAddresses(t *testing.T) {
	render := "nameservers:\n  - 1.1.1.1\n  - 8.8.8.8\n  - 10.96.0.10\n"

	if leaks := scanAddresses("homelab/addons.yaml", []byte(render), sanctionedSet()); len(leaks) != 0 {
		t.Fatalf("want no leaks for allowlisted public addresses, got %+v", leaks)
	}
}

func TestScanAddressesIgnoresAFourPartVersionWithAnOversizedOctet(t *testing.T) {
	render := "appVersion: 1.300.2.9\n"

	if leaks := scanAddresses("homelab/addons.yaml", []byte(render), sanctionedSet()); len(leaks) != 0 {
		t.Fatalf("want no leaks for a non-address quad, got %+v", leaks)
	}
}

func TestScanAddressesReportsEachAddressOncePerFile(t *testing.T) {
	// One hard-coded value in a shared chart must not bury the report under
	// forty identical findings.
	render := strings.Repeat("portal: 10.20.30.40:3260\n", 40)

	if leaks := scanAddresses("homelab/addons.yaml", []byte(render), sanctionedSet()); len(leaks) != 1 {
		t.Fatalf("want 1 leak, got %d", len(leaks))
	}
}

func TestForkAbilityAddressesFailsWithNoEnvironments(t *testing.T) {
	// A gate that cannot go red is not a gate: an empty scope must never pass.
	checks := ForkAbilityAddresses(t.TempDir(), t.TempDir(), nil)

	if len(checks) != 1 || checks[0].Status != StatusFail {
		t.Fatalf("want one failing check, got %+v", checks)
	}
	if checks[0].Name != ForkAbilityAddressesCheck {
		t.Errorf("name = %q, want %q", checks[0].Name, ForkAbilityAddressesCheck)
	}
}
