package commands

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// The fixtures are assembled at run time: a literal in the shape of an age
// recipient or secret key trips the secret scanners (gitleaks age-secret-key,
// generic-api-key) even when it is obviously synthetic.
var (
	testAgeKeyA = testRecipient('q')
	testAgeKeyB = testRecipient('p')
	testAgeKeyC = testRecipient('z')
	testAgeKey  = "AGE-SECRET-" + "KEY-1" + strings.Repeat("Q", 58)

	// repoSopsConfig mirrors the committed .sops.yaml: two rules on the
	// primary key and one rule that lists a second, purpose-specific recipient.
	repoSopsConfig = `creation_rules:
  - path_regex: .*\.sops\.ya?ml$
    encrypted_regex: ^(data|stringData)$
    age: ` + testAgeKeyA + `

  - path_regex: secrets/.*\.ya?ml$
    encrypted_regex: ^(data|stringData)$
    age: ` + testAgeKeyA + `

  - path_regex: (^|/)policy\.sops\.hujson$
    age: >-
      ` + testAgeKeyA + `,` + testAgeKeyB + `
`
)

// testRecipient is a syntactically valid age recipient (bech32 "age1" + 58
// characters from the bech32 alphabet) built from one repeated character.
func testRecipient(fill byte) string {
	return "age1" + strings.Repeat(string(fill), 58)
}

func TestParseAgeKeygen(t *testing.T) {
	tests := []struct {
		name    string
		stdout  string
		stderr  string
		want    ageKeyPair
		wantErr bool
	}{
		{
			name:   "key file on stdout, public key on stderr",
			stdout: "# created: 2026-09-17T00:00:00Z\n# public key: " + testAgeKeyA + "\n" + testAgeKey + "\n",
			stderr: "Public key: " + testAgeKeyA + "\n",
			want:   ageKeyPair{Public: testAgeKeyA, Private: testAgeKey},
		},
		{
			name:   "public key only on stderr",
			stdout: testAgeKey + "\n",
			stderr: "Public key: " + testAgeKeyA + "\n",
			want:   ageKeyPair{Public: testAgeKeyA, Private: testAgeKey},
		},
		{
			name:    "no secret key",
			stdout:  "# public key: " + testAgeKeyA + "\n",
			wantErr: true,
		},
		{
			name:    "malformed public key",
			stdout:  "# public key: age1short\n" + testAgeKey + "\n",
			wantErr: true,
		},
		{
			name:    "empty output",
			wantErr: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseAgeKeygen(tc.stdout, tc.stderr)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseAgeKeygen() = %+v, want error", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseAgeKeygen() error: %v", err)
			}
			if got != tc.want {
				t.Errorf("parseAgeKeygen() = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestCurrentSopsPublicKey(t *testing.T) {
	tests := []struct {
		name   string
		config string
		want   string
		wantOK bool
	}{
		{name: "repository config", config: repoSopsConfig, want: testAgeKeyA, wantOK: true},
		{name: "no recipient", config: "creation_rules:\n  - path_regex: .*\n"},
		{name: "empty", config: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := currentSopsPublicKey(tc.config)
			if ok != tc.wantOK || got != tc.want {
				t.Errorf("currentSopsPublicKey() = %q, %v; want %q, %v", got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

func TestReplaceSopsPublicKeyKeepsOtherRecipients(t *testing.T) {
	got, n := replaceSopsPublicKey(repoSopsConfig, testAgeKeyA, testAgeKeyC)
	if n != 3 {
		t.Errorf("replaced %d occurrences, want 3", n)
	}
	if strings.Contains(got, testAgeKeyA) {
		t.Errorf("old key still present:\n%s", got)
	}
	if !strings.Contains(got, testAgeKeyC+","+testAgeKeyB) {
		t.Errorf("the second recipient of the policy rule was not kept:\n%s", got)
	}
	var parsed struct {
		CreationRules []map[string]any `yaml:"creation_rules"`
	}
	if err := yaml.Unmarshal([]byte(got), &parsed); err != nil {
		t.Fatalf("rewritten config is not YAML: %v", err)
	}
	if len(parsed.CreationRules) != 3 {
		t.Errorf("rewritten config has %d rules, want 3", len(parsed.CreationRules))
	}
}

func TestDefaultSopsConfig(t *testing.T) {
	cfg := defaultSopsConfig(testAgeKeyA)
	var parsed struct {
		CreationRules []struct {
			PathRegex      string `yaml:"path_regex"`
			EncryptedRegex string `yaml:"encrypted_regex"`
			Age            string `yaml:"age"`
		} `yaml:"creation_rules"`
	}
	if err := yaml.Unmarshal([]byte(cfg), &parsed); err != nil {
		t.Fatalf("default config is not YAML: %v", err)
	}
	if len(parsed.CreationRules) != 2 {
		t.Fatalf("default config has %d rules, want 2", len(parsed.CreationRules))
	}
	for i, rule := range parsed.CreationRules {
		if rule.Age != testAgeKeyA {
			t.Errorf("rule %d age = %q, want %q", i, rule.Age, testAgeKeyA)
		}
		if rule.EncryptedRegex != "^(data|stringData)$" {
			t.Errorf("rule %d encrypted_regex = %q", i, rule.EncryptedRegex)
		}
	}
	if got, _ := currentSopsPublicKey(cfg); got != testAgeKeyA {
		t.Errorf("currentSopsPublicKey(default) = %q", got)
	}
}

func TestWriteSopsConfig(t *testing.T) {
	t.Run("creates the file on a fresh repository", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), ".sops.yaml")
		if err := writeSopsConfig(path, testAgeKeyA); err != nil {
			t.Fatal(err)
		}
		if got, _ := currentSopsPublicKey(readFileOrEmpty(path)); got != testAgeKeyA {
			t.Errorf("written config carries %q, want %q", got, testAgeKeyA)
		}
	})
	t.Run("rotates every occurrence and keeps the rest", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), ".sops.yaml")
		if err := os.WriteFile(path, []byte(repoSopsConfig), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := writeSopsConfig(path, testAgeKeyC); err != nil {
			t.Fatal(err)
		}
		got := readFileOrEmpty(path)
		if strings.Count(got, testAgeKeyC) != 3 || strings.Contains(got, testAgeKeyA) || !strings.Contains(got, testAgeKeyB) {
			t.Errorf("rotation rewrote the wrong keys:\n%s", got)
		}
	})
	t.Run("no-op when the key is current", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), ".sops.yaml")
		if err := os.WriteFile(path, []byte(repoSopsConfig), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := writeSopsConfig(path, testAgeKeyA); err != nil {
			t.Fatal(err)
		}
		if got := readFileOrEmpty(path); got != repoSopsConfig {
			t.Errorf("file changed on a no-op:\n%s", got)
		}
	})
	t.Run("refuses a config without a recipient", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), ".sops.yaml")
		if err := os.WriteFile(path, []byte("creation_rules: []\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := writeSopsConfig(path, testAgeKeyA); err == nil {
			t.Error("expected an error for a config with no age recipient")
		}
	})
}

func TestCredentialsSecretYAML(t *testing.T) {
	credentials := "{\n  \"verifier\": \"abc\",\n  \"encCredentials\": \"def\",\n  \"version\": \"2\"\n}"
	token := "connect-token-fixture"

	out, err := credentialsSecretYAML(credentials+"\n", token+"\n")
	if err != nil {
		t.Fatal(err)
	}
	var secret credentialsSecret
	if err := yaml.Unmarshal([]byte(out), &secret); err != nil {
		t.Fatalf("output is not YAML: %v\n%s", err, out)
	}
	if secret.Kind != "Secret" || secret.Metadata.Name != "onepassword-credentials" || secret.Metadata.Namespace != "onepassword-operator" {
		t.Errorf("unexpected metadata: %+v", secret.Metadata)
	}
	if secret.Metadata.Labels["app.kubernetes.io/part-of"] != "gitops-bootstrap" {
		t.Errorf("labels = %v", secret.Metadata.Labels)
	}
	if got := strings.TrimSpace(secret.StringData[sopsCredentialsField]); got != credentials {
		t.Errorf("credentials round-trip mismatch:\n%s", got)
	}
	if secret.StringData["token"] != token {
		t.Errorf("token = %q", secret.StringData["token"])
	}
	if !strings.Contains(out, "stringData:\n") || strings.Contains(out, "\t") {
		t.Errorf("unexpected layout:\n%s", out)
	}

	if _, err := credentialsSecretYAML("", token); err == nil {
		t.Error("empty credentials must be rejected")
	}
	if _, err := credentialsSecretYAML(credentials, " "); err == nil {
		t.Error("empty token must be rejected")
	}
}

func TestRedactCredentials(t *testing.T) {
	credentials := "{\n  \"verifier\": \"abc\",\n  \"encCredentials\": \"def\"\n}"
	token := "redacted-token-fixture"
	out, err := credentialsSecretYAML(credentials, token)
	if err != nil {
		t.Fatal(err)
	}
	redacted := redactCredentials(out, credentials, token)
	for _, leak := range []string{token, `"verifier": "abc"`, `"encCredentials": "def"`} {
		if strings.Contains(redacted, leak) {
			t.Errorf("preview still contains %q:\n%s", leak, redacted)
		}
	}
	if !strings.Contains(redacted, "name: onepassword-credentials") {
		t.Errorf("preview lost the metadata:\n%s", redacted)
	}
}

func TestCredentialsTemplateMatchesTheSecretShape(t *testing.T) {
	var secret credentialsSecret
	if err := yaml.Unmarshal([]byte(credentialsTemplate()), &secret); err != nil {
		t.Fatalf("template is not YAML: %v", err)
	}
	if secret.Metadata.Namespace != "onepassword-operator" || secret.StringData["token"] != "REPLACEME" {
		t.Errorf("template drifted from the generated Secret: %+v", secret)
	}
	if _, ok := secret.StringData[sopsCredentialsField]; !ok {
		t.Errorf("template lacks the %s key", sopsCredentialsField)
	}
}
