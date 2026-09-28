package verify

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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

func TestScanAddressesIgnoresAQuadInsideALongerDottedNumber(t *testing.T) {
	// The plex tag 1.43.5.11029-6bf8af3f0 starts with the valid quad 1.43.5.110.
	for _, render := range []string{
		"tag: 1.43.5.11029-6bf8af3f0\n",
		"tag: \"1.43.5.11029-6bf8af3f0\"\n",
		"version: 2.1.43.5.110\n",
		"version: 1.43.5.110.7\n",
	} {
		if leaks := scanAddresses("homelab/applications.yaml", []byte(render), sanctionedSet()); len(leaks) != 0 {
			t.Errorf("%q: want no leaks for a longer dotted number, got %+v", render, leaks)
		}
	}
}

func TestScanAddressesStillFlagsAnAddressBeforePunctuation(t *testing.T) {
	for _, render := range []string{
		"# reach 10.20.30.40.\n",
		"cidr: 10.20.30.40/32\n",
		"hosts: 10.20.30.40,10.20.30.41\n",
	} {
		leaks := scanAddresses("homelab/addons.yaml", []byte(render), sanctionedSet())
		if len(leaks) == 0 || leaks[0].Address != "10.20.30.40" {
			t.Errorf("%q: want 10.20.30.40 flagged, got %+v", render, leaks)
		}
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

// The point of these tests is that check 2 can FAIL. A gate that only has a
// passing test is a gate nobody has proved does anything.

func fakeProducer(body string) RequiredKeysProducer {
	return func(context.Context) ([]byte, error) { return []byte(body), nil }
}

// repoWithExample writes a throwaway repo root holding one example ConfigSet.
func repoWithExample(t *testing.T, rel, body string) string {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

const homelabExampleRel = "configuration/environments/homelab.yaml.example"

func docJSON(keys string, assumptions string) string {
	a := ""
	if assumptions != "" {
		a = `"assumptions": ` + assumptions + `,`
	}
	return `{"version":1,"tiers":[{"tier":"homelab",` + a + `"keys":[` + keys + `]}]}`
}

func key(name, source, example string) string {
	return `{"name":"` + name + `","required":true,"source":"` + source +
		`","example":"` + example + `","description":"` + name + ` description"}`
}

func statusOf(t *testing.T, checks []Check, name string) Check {
	t.Helper()
	for _, c := range checks {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("no check named %q in %v", name, checks)
	return Check{}
}

func TestCheck2PassesWhenExampleCoversEveryRequiredKey(t *testing.T) {
	root := repoWithExample(t, homelabExampleRel, "BOOTSTRAP_ONLY_KEY: \"3\"\nCP_VIP: \"192.168.1.10\"\nDOMAIN: REPLACEME-domain.com\n")
	doc := docJSON(
		key("BOOTSTRAP_ONLY_KEY", KeySourceBootstrap, ExampleRequired)+","+
			key("CP_VIP", KeySourceSchema, ExampleRequired)+","+
			key("DOMAIN", KeySourceSchema, ExampleRequired),
		`{"BOOTSTRAP_ONLY_KEY":"3"}`)

	checks := ForkAbilityCheck2(context.Background(), root, fakeProducer(doc))

	if c := statusOf(t, checks, "forkability/required-keys/contract"); c.Status != StatusPass {
		t.Fatalf("contract check: got %s (%s)", c.Status, c.Detail)
	}
	if c := statusOf(t, checks, "forkability/example-completeness/homelab"); c.Status != StatusPass {
		t.Fatalf("completeness: got %s, findings %v", c.Status, c.Findings)
	}
}

// The defect check 2 exists to catch: the bootstrap grew a key that no render
// requires, so it is in neither the schema nor the example file.
func TestCheck2FailsOnBootstrapOnlyKeyMissingFromExample(t *testing.T) {
	root := repoWithExample(t, homelabExampleRel, "DOMAIN: REPLACEME-domain.com\n")
	doc := docJSON(
		key("BOOTSTRAP_ONLY_KEY", KeySourceBootstrap, ExampleRequired)+","+
			key("DOMAIN", KeySourceSchema, ExampleRequired), "")

	c := statusOf(t, ForkAbilityCheck2(context.Background(), root, fakeProducer(doc)),
		"forkability/example-completeness/homelab")

	if c.Status != StatusFail {
		t.Fatalf("expected fail, got %s", c.Status)
	}
	if !strings.Contains(strings.Join(c.Findings, "\n"), "BOOTSTRAP_ONLY_KEY") {
		t.Fatalf("findings do not name the missing key: %v", c.Findings)
	}
}

func TestCheck2FailsOnEmptyPlaceholder(t *testing.T) {
	root := repoWithExample(t, homelabExampleRel, "DOMAIN:\n")
	doc := docJSON(key("DOMAIN", KeySourceSchema, ExampleRequired), "")

	c := statusOf(t, ForkAbilityCheck2(context.Background(), root, fakeProducer(doc)),
		"forkability/example-completeness/homelab")
	if c.Status != StatusFail {
		t.Fatalf("expected fail, got %s", c.Status)
	}
}

func TestCheck2FailsWhenAComputedKeyIsSetInTheExample(t *testing.T) {
	root := repoWithExample(t, homelabExampleRel, "DOMAIN: REPLACEME-domain.com\nCLUSTER_NAME: homelab\n")
	doc := docJSON(
		key("CLUSTER_NAME", KeySourceBootstrap, ExampleForbidden)+","+
			key("DOMAIN", KeySourceSchema, ExampleRequired), "")

	c := statusOf(t, ForkAbilityCheck2(context.Background(), root, fakeProducer(doc)),
		"forkability/example-completeness/homelab")
	if c.Status != StatusFail {
		t.Fatalf("expected fail, got %s", c.Status)
	}
}

// A defaulted key is operator-tunable: the example may carry it as a curated
// starting point (GPU_VENDOR does) or leave it out. Both pass. Without this
// third state the check has to choose between false-failing every defaulted key
// that is in the example and never checking any of them.
func TestCheck2AcceptsAnOptionalKeyPresentOrAbsent(t *testing.T) {
	doc := docJSON(
		key("DOMAIN", KeySourceSchema, ExampleRequired)+","+
			key("GPU_VENDOR", KeySourceSchema, ExampleOptional), "")

	for _, example := range []string{
		"DOMAIN: REPLACEME-domain.com\nGPU_VENDOR: \"intel\"\n",
		"DOMAIN: REPLACEME-domain.com\n",
	} {
		root := repoWithExample(t, homelabExampleRel, example)
		c := statusOf(t, ForkAbilityCheck2(context.Background(), root, fakeProducer(doc)),
			"forkability/example-completeness/homelab")
		if c.Status != StatusPass {
			t.Fatalf("expected pass for %q, got %s: %v", example, c.Status, c.Findings)
		}
	}
}

// An optional key present with no value is not "left to the default" — it
// overrides the default with an empty string.
func TestCheck2FailsOnEmptyOptionalOverride(t *testing.T) {
	root := repoWithExample(t, homelabExampleRel, "DOMAIN: REPLACEME-domain.com\nGPU_VENDOR:\n")
	doc := docJSON(
		key("DOMAIN", KeySourceSchema, ExampleRequired)+","+
			key("GPU_VENDOR", KeySourceSchema, ExampleOptional), "")

	c := statusOf(t, ForkAbilityCheck2(context.Background(), root, fakeProducer(doc)),
		"forkability/example-completeness/homelab")
	if c.Status != StatusFail {
		t.Fatalf("expected fail, got %s", c.Status)
	}
}

// A tier the producer knows about and this consumer does not must fail, not be
// skipped. Silently unchecked is how check 2 forked the key list in the first
// place.
func TestCheck2FailsOnUnmappedTier(t *testing.T) {
	root := repoWithExample(t, homelabExampleRel, "DOMAIN: REPLACEME-domain.com\n")
	doc := `{"version":1,"tiers":[{"tier":"enterprise","keys":[` +
		key("DOMAIN", KeySourceSchema, ExampleRequired) + `]}]}`

	c := statusOf(t, ForkAbilityCheck2(context.Background(), root, fakeProducer(doc)),
		"forkability/example-completeness/enterprise")
	if c.Status != StatusFail {
		t.Fatalf("expected fail for an unmapped tier, got %s", c.Status)
	}
}

// If the example disagrees with an input the producer assumed, the checked key
// list is not the list the example implies. No such input exists today (ADR-035
// removed the only candidate), so the producer's key here is a stand-in.
func TestCheck2FailsWhenExampleContradictsTheProducerAssumption(t *testing.T) {
	root := repoWithExample(t, homelabExampleRel, "BOOTSTRAP_ONLY_KEY: \"1\"\nDOMAIN: REPLACEME-domain.com\n")
	doc := docJSON(
		key("BOOTSTRAP_ONLY_KEY", KeySourceBootstrap, ExampleRequired)+","+
			key("DOMAIN", KeySourceSchema, ExampleRequired),
		`{"BOOTSTRAP_ONLY_KEY":"3"}`)

	c := statusOf(t, ForkAbilityCheck2(context.Background(), root, fakeProducer(doc)),
		"forkability/example-completeness/homelab")
	if c.Status != StatusFail {
		t.Fatalf("expected fail, got %s", c.Status)
	}
}

// Every way the producer's document can be malformed must fail the contract
// check rather than parse into an empty key set and pass vacuously.
func TestParseRequiredKeysRejectsMalformedDocuments(t *testing.T) {
	cases := map[string]string{
		"empty output":      ``,
		"empty object":      `{}`,
		"no tiers":          `{"version":1,"tiers":[]}`,
		"unknown version":   `{"version":2,"tiers":[{"tier":"homelab","keys":[` + key("DOMAIN", KeySourceSchema, ExampleRequired) + `]}]}`,
		"tier with no keys": `{"version":1,"tiers":[{"tier":"homelab","keys":[]}]}`,
		"unknown source":    docJSON(key("DOMAIN", "guessed", ExampleRequired), ""),
		"unknown example":   docJSON(key("DOMAIN", KeySourceSchema, "maybe"), ""),
		"unsorted keys":     docJSON(key("ZONE", KeySourceSchema, ExampleRequired)+","+key("DOMAIN", KeySourceSchema, ExampleRequired), ""),
		"duplicate key":     docJSON(key("DOMAIN", KeySourceSchema, ExampleRequired)+","+key("DOMAIN", KeySourceSchema, ExampleRequired), ""),
		"unknown field":     `{"version":1,"tiers":[{"tier":"homelab","keys":[],"surprise":true}]}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseRequiredKeys([]byte(body)); err == nil {
				t.Fatalf("expected a parse error for %s", name)
			}
			c := statusOf(t, ForkAbilityCheck2(context.Background(), t.TempDir(), fakeProducer(body)),
				"forkability/required-keys/contract")
			if c.Status != StatusFail {
				t.Fatalf("expected the contract check to fail for %s, got %s", name, c.Status)
			}
		})
	}
}

// A producer that cannot run fails the gate. It is never a silent pass: an
// absent key list is indistinguishable from a complete one, so the only safe
// reading is failure.
func TestCheck2FailsWhenTheProducerCannotRun(t *testing.T) {
	produce := func(context.Context) ([]byte, error) { return nil, errors.New("unknown flag: --print-required-keys") }

	checks := ForkAbilityCheck2(context.Background(), t.TempDir(), produce)
	if len(checks) != 1 {
		t.Fatalf("expected a single contract check, got %d", len(checks))
	}
	if checks[0].Status != StatusFail {
		t.Fatalf("expected fail, got %s", checks[0].Status)
	}
}

func TestParseConfigSetKeysIgnoresCommentsAndNesting(t *testing.T) {
	got := parseConfigSetKeys([]byte(strings.Join([]string{
		"# a comment",
		"DOMAIN: REPLACEME-domain.com",
		`CP_VIP: "192.168.1.10"`,
		"NESTED:",
		"  CHILD: value",
		"",
	}, "\n")))

	if got["DOMAIN"] != "REPLACEME-domain.com" {
		t.Errorf("DOMAIN = %q", got["DOMAIN"])
	}
	if got["CP_VIP"] != "192.168.1.10" {
		t.Errorf("CP_VIP = %q (quotes should be stripped)", got["CP_VIP"])
	}
	if _, ok := got["CHILD"]; ok {
		t.Error("an indented child key was read as a top-level key")
	}
}
