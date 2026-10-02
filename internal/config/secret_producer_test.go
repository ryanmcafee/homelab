package config

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// secretProducer is one enabled-gated OnePasswordItem in a *-config chart,
// together with the ConfigSet key a fork sets to fill its item path.
//
// The guards used to read `if and <enabled> <itemPath>`, so an enabled
// producer with a blank path rendered nothing at all: no Secret ever appeared
// and the manifest still read like a working producer. Every case below
// pins the fail-closed behaviour that replaced it.
type secretProducer struct {
	chart     string
	enableKey string
	pathKey   string
	configKey string
	itemName  string
	// siblings are the other producers in the same chart, disabled so a
	// failure is attributable to this one.
	siblings []string
}

var secretProducers = []secretProducer{
	{
		chart:     "democratic-csi-config",
		enableKey: "truenas.enabled",
		pathKey:   "truenas.onePasswordItemPath",
		configKey: "DEMOCRATIC_CSI_1P_PATH",
		itemName:  "truenas-api-key",
	},
	{
		chart:     "cert-manager-config",
		enableKey: "cloudflare.enabled",
		pathKey:   "cloudflare.onePasswordItemPath",
		configKey: "CERT_MANAGER_1P_PATH",
		itemName:  "cloudflare-api-token",
	},
	{
		chart:     "external-dns-config",
		enableKey: "cloudflare.enabled",
		pathKey:   "cloudflare.onePasswordItemPath",
		configKey: "EXTERNAL_DNS_1P_PATH",
		itemName:  "cloudflare-api-token",
		siblings:  []string{"unifi.enabled"},
	},
	{
		chart:     "external-dns-config",
		enableKey: "unifi.enabled",
		pathKey:   "unifi.onePasswordItemPath",
		configKey: "EXTERNAL_DNS_UNIFI_1P_PATH",
		itemName:  "unifi-api-credentials",
		siblings:  []string{"cloudflare.enabled"},
	},
}

// helmTemplate renders chartDir with extra helm arguments and reports the
// combined output plus whether helm exited zero.
func helmTemplate(t *testing.T, root, chart string, args ...string) (string, bool) {
	t.Helper()
	full := append([]string{"template", chart, filepath.Join(root, "charts", chart)}, args...)
	out, err := exec.Command("helm", full...).CombinedOutput()
	return string(out), err == nil
}

// requireHelm fails rather than skips: a skip here would turn every
// assertion below into a silent pass on a runner without helm.
func requireHelm(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("helm"); err != nil {
		t.Fatalf("helm is required by these chart contract tests: %v", err)
	}
}

// TestEnabledSecretProducerRequiresItemPath is the regression for the silent
// omission: an enabled producer with a missing, blank or whitespace-only item
// path must fail the render, naming both the values key and the ConfigSet key.
func TestEnabledSecretProducerRequiresItemPath(t *testing.T) {
	requireHelm(t)
	root := findProjectRootForTest(t)

	blanks := []struct {
		name string
		set  []string
	}{
		{"unset", nil},
		{"empty string", []string{"--set-string"}},
		{"whitespace only", []string{"--set-string"}},
		{"explicit null", []string{"--set"}},
	}
	values := map[string]string{
		"unset":           "",
		"empty string":    "",
		"whitespace only": "   ",
		"explicit null":   "null",
	}

	for _, p := range secretProducers {
		for _, b := range blanks {
			t.Run(p.chart+"/"+p.pathKey+"/"+b.name, func(t *testing.T) {
				args := []string{"--set", p.enableKey + "=true"}
				for _, s := range p.siblings {
					args = append(args, "--set", s+"=false")
				}
				if b.set != nil {
					args = append(args, b.set[0], p.pathKey+"="+values[b.name])
				}

				out, ok := helmTemplate(t, root, p.chart, args...)
				if ok {
					t.Fatalf("%s with %s enabled and no item path rendered successfully; "+
						"an inert OnePasswordItem is exactly the silent omission this guards:\n%s",
						p.chart, p.enableKey, out)
				}
				for _, want := range []string{p.chart, p.pathKey, p.enableKey, p.configKey, "configuration/environments"} {
					if !strings.Contains(out, want) {
						t.Errorf("error message does not mention %q, so an operator cannot act on it:\n%s", want, out)
					}
				}
			})
		}
	}
}

// TestDisabledSecretProducerRendersNothing keeps the fail-closed guard from
// becoming a fail-always guard: a disabled producer needs no item path.
func TestDisabledSecretProducerRendersNothing(t *testing.T) {
	requireHelm(t)
	root := findProjectRootForTest(t)

	for _, p := range secretProducers {
		t.Run(p.chart+"/"+p.enableKey, func(t *testing.T) {
			args := []string{"--set", p.enableKey + "=false"}
			for _, s := range p.siblings {
				args = append(args, "--set", s+"=false")
			}
			out, ok := helmTemplate(t, root, p.chart, args...)
			if !ok {
				t.Fatalf("%s with %s disabled must render, not fail:\n%s", p.chart, p.enableKey, out)
			}
			if strings.Contains(out, "kind: OnePasswordItem") {
				t.Errorf("%s with %s disabled still rendered a producer:\n%s", p.chart, p.enableKey, out)
			}
		})
	}
}

// TestSecretProducerRendersForkSpecificItemPath is the two-fork propagation
// check: the item path a fork supplies must reach spec.itemPath verbatim. A
// path hard-coded in the template would pass for one fork and fail the other.
func TestSecretProducerRendersForkSpecificItemPath(t *testing.T) {
	requireHelm(t)
	root := findProjectRootForTest(t)

	forks := []string{"vaults/fork-a/items/first-item", "vaults/fork-b/items/second-item"}

	for _, p := range secretProducers {
		for _, path := range forks {
			t.Run(p.chart+"/"+p.pathKey+"/"+path, func(t *testing.T) {
				args := []string{"--set", p.enableKey + "=true", "--set-string", p.pathKey + "=" + path}
				for _, s := range p.siblings {
					args = append(args, "--set", s+"=false")
				}

				out, ok := helmTemplate(t, root, p.chart, args...)
				if !ok {
					t.Fatalf("%s with %s=%s failed to render:\n%s", p.chart, p.pathKey, path, out)
				}
				if !strings.Contains(out, "name: "+p.itemName) {
					t.Errorf("%s did not render the %s producer:\n%s", p.chart, p.itemName, out)
				}
				if !strings.Contains(out, `itemPath: "`+path+`"`) {
					t.Errorf("%s did not carry the fork's %s through to spec.itemPath:\n%s", p.chart, p.pathKey, out)
				}
			})
		}
	}
}

// TestLocaldevRendersNoSecretProducer pins the committed localdev overlays.
// Kind has no 1Password Connect, so every one of these charts must disable
// its producers outright rather than leave one enabled with a blank path.
func TestLocaldevRendersNoSecretProducer(t *testing.T) {
	requireHelm(t)
	root := findProjectRootForTest(t)

	for _, chart := range []string{"democratic-csi-config", "cert-manager-config", "external-dns-config"} {
		t.Run(chart, func(t *testing.T) {
			dir := filepath.Join(root, "charts", chart)
			out, ok := helmTemplate(t, root, chart,
				"-f", filepath.Join(dir, "values.yaml"),
				"-f", filepath.Join(dir, "values-localdev.yaml"))
			if !ok {
				t.Fatalf("%s localdev values failed to render:\n%s", chart, out)
			}
			if strings.TrimSpace(out) != "" {
				t.Errorf("%s rendered %d bytes for localdev; it must produce nothing:\n%s", chart, len(out), out)
			}
		})
	}
}
