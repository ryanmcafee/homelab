package verify

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	root := repoWithExample(t, homelabExampleRel, "CONTROL_PLANE_COUNT: \"3\"\nCP_VIP: \"192.168.1.10\"\nDOMAIN: REPLACEME-domain.com\n")
	doc := docJSON(
		key("CONTROL_PLANE_COUNT", KeySourceBootstrap, ExampleRequired)+","+
			key("CP_VIP", KeySourceSchema, ExampleRequired)+","+
			key("DOMAIN", KeySourceSchema, ExampleRequired),
		`{"CONTROL_PLANE_COUNT":"3"}`)

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
		key("CONTROL_PLANE_COUNT", KeySourceBootstrap, ExampleRequired)+","+
			key("DOMAIN", KeySourceSchema, ExampleRequired), "")

	c := statusOf(t, ForkAbilityCheck2(context.Background(), root, fakeProducer(doc)),
		"forkability/example-completeness/homelab")

	if c.Status != StatusFail {
		t.Fatalf("expected fail, got %s", c.Status)
	}
	if !strings.Contains(strings.Join(c.Findings, "\n"), "CONTROL_PLANE_COUNT") {
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

// The key set is computed from CONTROL_PLANE_COUNT. If the example disagrees
// with the value the producer assumed, the checked key list is not the list the
// example implies.
func TestCheck2FailsWhenExampleContradictsTheProducerAssumption(t *testing.T) {
	root := repoWithExample(t, homelabExampleRel, "CONTROL_PLANE_COUNT: \"1\"\nDOMAIN: REPLACEME-domain.com\n")
	doc := docJSON(
		key("CONTROL_PLANE_COUNT", KeySourceBootstrap, ExampleRequired)+","+
			key("DOMAIN", KeySourceSchema, ExampleRequired),
		`{"CONTROL_PLANE_COUNT":"3"}`)

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
