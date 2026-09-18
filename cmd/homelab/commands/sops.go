package commands

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/utils"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// The SOPS bootstrap contract. gitops-bootstrap reads the private key from
// op://homelab/sops-age-key/private_key (.env.op SOPS_AGE_KEY) and the ksops
// generator in charts/secrets/onepassword decrypts sopsCredentialsFile, so
// these names are shared with Terragrunt, the Taskfile and the docs.
const (
	sopsAgeItem             = "sops-age-key"
	sopsConnectItem         = "onepassword-connect"
	sopsConfigFile          = ".sops.yaml"
	sopsCredentialsFile     = "charts/secrets/onepassword/onepassword-credentials.sops.yaml"
	sopsCredentialsTemplate = "charts/secrets/onepassword/onepassword-credentials.template.yaml"
	sopsCredentialsField    = "1password-credentials.json"
	sopsConnectTokenField   = "connect_token"
)

// agePublicKeyRe matches an age X25519 recipient (bech32, 62 characters).
var agePublicKeyRe = regexp.MustCompile(`age1[02-9ac-hj-np-z]{58}`)

func NewSopsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sops",
		Short: "SOPS encryption management",
		Long:  `Manage SOPS encryption keys and setup for GitOps secrets.`,
		// A group is not runnable; a typo must not print help and exit 0.
		Args:          GroupCommandArgs,
		RunE:          RunGroupCommand,
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	cmd.AddCommand(newSopsBootstrapCmd())
	cmd.AddCommand(newSopsSetupCmd())

	return cmd
}

func newSopsBootstrapCmd() *cobra.Command {
	var force, encrypt bool

	cmd := &cobra.Command{
		Use:   "bootstrap",
		Short: "Bootstrap SOPS encryption",
		Long: `Generate the age key pair once, store it in 1Password (` + onePasswordVault + `/` + sopsAgeItem + `),
put the public key in every creation rule of ` + sopsConfigFile + ` and, on a fresh repository,
write the 1Password Connect credentials template. --force regenerates the key (run
'task sops:rotate' afterwards so every encrypted file is re-keyed).`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun
			utils.AutoAccept = AutoAccept
			return runSopsBootstrap(force, encrypt)
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Regenerate keys even if they exist")
	cmd.Flags().BoolVar(&encrypt, "encrypt", false, "Encrypt the 1Password credentials template after setup")

	return cmd
}

func newSopsSetupCmd() *cobra.Command {
	var commit bool

	cmd := &cobra.Command{
		Use:   "setup",
		Short: "Setup SOPS-encrypted 1Password credentials",
		Long: `Read the 1Password Connect credentials file and token from
op://` + onePasswordVault + `/` + sopsConnectItem + `, build the onepassword-credentials Secret and
encrypt it with SOPS into ` + sopsCredentialsFile + `.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun
			utils.AutoAccept = AutoAccept
			return runSopsSetup(commit)
		},
	}

	cmd.Flags().BoolVar(&commit, "commit", false, "Commit the encrypted secret after creation")

	return cmd
}

// runSopsBootstrap is `homelab sops bootstrap`.
func runSopsBootstrap(force, encrypt bool) error {
	logger.Info("=== SOPS Bootstrap ===")
	fmt.Println()

	logger.Info("Checking prerequisites...")
	for _, tool := range []string{"age-keygen", "sops", "op"} {
		if err := checkToolInstalled(tool); err != nil {
			logger.Error(fmt.Sprintf("%s is not installed. Install with: mise install", tool))
			return err
		}
	}
	if err := check1PasswordAuth(); err != nil {
		logger.Error("1Password CLI not authenticated. Run: eval $(op signin)")
		return err
	}
	logger.OK("Prerequisites OK")

	root, err := findProjectRoot()
	if err != nil {
		return err
	}

	if DryRun {
		logger.Warn("Dry run: nothing is generated, stored or written")
	}

	// 1. The age key pair: reuse the one in 1Password unless --force.
	exists, err := opItemExists(sopsAgeItem)
	if err != nil {
		return err
	}
	var publicKey string
	switch {
	case exists && !force:
		publicKey, err = opRead(fmt.Sprintf("op://%s/%s/public_key", onePasswordVault, sopsAgeItem))
		if err != nil {
			return fmt.Errorf("read the public key from 1Password (%s/%s): %w", onePasswordVault, sopsAgeItem, err)
		}
		if !agePublicKeyRe.MatchString(publicKey) {
			return fmt.Errorf("1Password item %s/%s field public_key is not an age recipient", onePasswordVault, sopsAgeItem)
		}
		logger.Info(fmt.Sprintf("Using the age key already in 1Password (%s/%s): %s", onePasswordVault, sopsAgeItem, publicKey))
	case DryRun:
		if exists {
			logger.Warn(fmt.Sprintf("Would regenerate the age key pair and overwrite %s/%s (--force)", onePasswordVault, sopsAgeItem))
		} else {
			logger.Warn(fmt.Sprintf("Would generate an age key pair and store it as %s/%s", onePasswordVault, sopsAgeItem))
		}
		logger.Warn(fmt.Sprintf("Would put the new public key in every creation rule of %s", sopsConfigFile))
		logger.Warn("Would write the credentials template unless the encrypted credentials already exist")
		return nil
	default:
		if exists {
			logger.Warn(fmt.Sprintf("Regenerating the age key pair; %s/%s is overwritten (--force)", onePasswordVault, sopsAgeItem))
			if !utils.Confirm("Every file encrypted with the current key needs 'task sops:rotate' afterwards. Continue?") {
				return errors.New("aborted")
			}
		}
		logger.Info("Generating a new age key pair...")
		pair, err := generateAgeKey()
		if err != nil {
			return err
		}
		publicKey = pair.Public
		logger.OK("Generated public key: " + publicKey)
		if err := storeAgeKey(pair, exists); err != nil {
			return err
		}
		logger.OK(fmt.Sprintf("Key stored in 1Password: %s/%s (fields public_key, private_key)", onePasswordVault, sopsAgeItem))
	}

	// 2. .sops.yaml carries the public key in every creation rule.
	if err := writeSopsConfig(filepath.Join(root, sopsConfigFile), publicKey); err != nil {
		return err
	}

	// 3. The credentials: a template on a fresh repository, otherwise leave
	// the committed encrypted file alone (task sops:setup refreshes it).
	credentials := filepath.Join(root, sopsCredentialsFile)
	template := filepath.Join(root, sopsCredentialsTemplate)
	switch {
	case utils.FileExists(template):
		logger.Info("Credentials template already present: " + sopsCredentialsTemplate)
	case utils.FileExists(credentials):
		logger.Info("Encrypted credentials already committed: " + sopsCredentialsFile + " (task sops:setup refreshes them from 1Password)")
	default:
		if err := os.WriteFile(template, []byte(credentialsTemplate()), 0o600); err != nil {
			return fmt.Errorf("write %s: %w", sopsCredentialsTemplate, err)
		}
		logger.OK("Wrote the credentials template: " + sopsCredentialsTemplate + " (gitignored)")
	}

	if encrypt {
		if !utils.FileExists(template) {
			return fmt.Errorf("--encrypt needs %s; fill it in first, or run 'task sops:setup' to pull the credentials from 1Password", sopsCredentialsTemplate)
		}
		if err := sopsEncryptFile(root, template, credentials); err != nil {
			return err
		}
		if err := os.Remove(template); err != nil {
			return fmt.Errorf("remove %s: %w", sopsCredentialsTemplate, err)
		}
		logger.OK("Encrypted " + sopsCredentialsTemplate + " -> " + sopsCredentialsFile + " and removed the plaintext template")
	}

	fmt.Println()
	logger.Info("=== Bootstrap Complete ===")
	logger.Info("Next steps:")
	if force {
		fmt.Println("  1. task sops:rotate      # re-key every *.sops.* file with the new public key")
		fmt.Println("  2. task tf:apply:component COMPONENT=gitops-bootstrap   # replace the sops-age-key Secret")
		return nil
	}
	if utils.FileExists(template) {
		fmt.Println("  1. task sops:setup       # pull the 1Password Connect credentials and encrypt them (or fill in the template and run task sops:encrypt)")
	} else {
		fmt.Println("  1. task sops:verify      # prove the key decrypts what is committed")
	}
	fmt.Println("  2. git add .sops.yaml charts/secrets && git commit")
	fmt.Println("  3. task tf:apply:component COMPONENT=gitops-bootstrap   # provisions the sops-age-key Secret")
	return nil
}

// runSopsSetup is `homelab sops setup`.
func runSopsSetup(commit bool) error {
	logger.Info("=== SOPS 1Password Credentials Setup ===")
	fmt.Println()

	logger.Info("Checking prerequisites...")
	for _, tool := range []string{"sops", "op"} {
		if err := checkToolInstalled(tool); err != nil {
			logger.Error(fmt.Sprintf("%s is not installed. Install with: mise install", tool))
			return err
		}
	}
	if err := check1PasswordAuth(); err != nil {
		logger.Error("1Password CLI not authenticated. Run: eval $(op signin)")
		return err
	}
	logger.OK("Prerequisites OK")

	root, err := findProjectRoot()
	if err != nil {
		return err
	}
	configPath := filepath.Join(root, sopsConfigFile)
	if _, ok := currentSopsPublicKey(readFileOrEmpty(configPath)); !ok {
		return fmt.Errorf("%s has no age public key; run 'task sops:bootstrap' first", sopsConfigFile)
	}

	logger.Info(fmt.Sprintf("Reading the Connect credentials from 1Password (%s/%s)...", onePasswordVault, sopsConnectItem))
	credentialsJSON, err := opRead(fmt.Sprintf("op://%s/%s/%s", onePasswordVault, sopsConnectItem, sopsCredentialsField))
	if err != nil {
		return fmt.Errorf("read %s from 1Password item %s/%s: %w", sopsCredentialsField, onePasswordVault, sopsConnectItem, err)
	}
	token, err := opRead(fmt.Sprintf("op://%s/%s/%s", onePasswordVault, sopsConnectItem, sopsConnectTokenField))
	if err != nil {
		return fmt.Errorf("read %s from 1Password item %s/%s: %w", sopsConnectTokenField, onePasswordVault, sopsConnectItem, err)
	}
	logger.OK("Retrieved credentials from 1Password")

	secretYAML, err := credentialsSecretYAML(credentialsJSON, token)
	if err != nil {
		return err
	}

	if DryRun {
		logger.Warn("Dry run: would encrypt this Secret into " + sopsCredentialsFile)
		fmt.Println()
		fmt.Println("--- Secret (plaintext preview, values redacted) ---")
		fmt.Print(redactCredentials(secretYAML, credentialsJSON, token))
		fmt.Println("--- End preview ---")
		return nil
	}

	// sops picks the creation rule by path, so the plaintext is written next
	// to the target with a matching name and removed whatever happens.
	target := filepath.Join(root, sopsCredentialsFile)
	plaintext := filepath.Join(filepath.Dir(target), ".tmp-"+filepath.Base(target))
	if err := os.WriteFile(plaintext, []byte(secretYAML), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", plaintext, err)
	}
	defer os.Remove(plaintext)
	if err := sopsEncryptFile(root, plaintext, target); err != nil {
		return err
	}
	logger.OK("Encrypted secret saved to " + sopsCredentialsFile)

	if template := filepath.Join(root, sopsCredentialsTemplate); utils.FileExists(template) {
		if err := os.Remove(template); err != nil {
			return fmt.Errorf("remove %s: %w", sopsCredentialsTemplate, err)
		}
		logger.OK("Removed the plaintext template: " + sopsCredentialsTemplate)
	}

	if commit {
		if err := gitCommitSecrets(root); err != nil {
			return err
		}
		logger.OK("Committed " + sopsCredentialsFile)
	}

	fmt.Println()
	logger.Info("=== Setup Complete ===")
	logger.Info("Next steps:")
	if !commit {
		fmt.Println("  1. git diff " + sopsCredentialsFile + "   # only the encrypted values change")
		fmt.Println("  2. git add " + sopsCredentialsFile + " && git commit -m 'chore(secrets): refresh the 1Password Connect credentials'")
	}
	fmt.Println("  3. git push")
	fmt.Println("  4. task tf:apply:component COMPONENT=gitops-bootstrap   # if the sops-age-key Secret is not in the cluster yet")
	return nil
}

// ageKeyPair is the output of age-keygen.
type ageKeyPair struct {
	Public  string
	Private string
}

// parseAgeKeygen reads age-keygen's output: the key file on stdout
// ("# created: ...", "# public key: age1...", "AGE-SECRET-KEY-1...") and
// "Public key: age1..." on stderr.
func parseAgeKeygen(stdout, stderr string) (ageKeyPair, error) {
	var pair ageKeyPair
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "# public key:"):
			pair.Public = strings.TrimSpace(strings.TrimPrefix(line, "# public key:"))
		case strings.HasPrefix(line, "AGE-SECRET-KEY-"):
			pair.Private = line
		}
	}
	if pair.Public == "" {
		for _, line := range strings.Split(stderr, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "Public key:") {
				pair.Public = strings.TrimSpace(strings.TrimPrefix(line, "Public key:"))
			}
		}
	}
	if !agePublicKeyRe.MatchString(pair.Public) || pair.Private == "" {
		return ageKeyPair{}, errors.New("age-keygen output has no public key / secret key pair")
	}
	return pair, nil
}

func generateAgeKey() (ageKeyPair, error) {
	stdout, stderr, err := runCapture("", "age-keygen")
	if err != nil {
		return ageKeyPair{}, fmt.Errorf("age-keygen: %w", err)
	}
	return parseAgeKeygen(stdout, stderr)
}

// storeAgeKey writes the pair to 1Password as a Password item whose fields
// match what gitops-bootstrap and .env.op read (private_key, public_key).
// The values travel as assignments on the command line, the same way the
// documented manual step passes them; never log the arguments.
func storeAgeKey(pair ageKeyPair, overwrite bool) error {
	assignments := []string{
		"private_key[password]=" + pair.Private,
		"public_key[text]=" + pair.Public,
	}
	var args []string
	if overwrite {
		args = append([]string{"item", "edit", sopsAgeItem, "--vault", onePasswordVault}, assignments...)
	} else {
		args = append([]string{"item", "create", "--vault", onePasswordVault, "--category", "password", "--title", sopsAgeItem}, assignments...)
	}
	if _, stderr, err := runCapture("", "op", args...); err != nil {
		return fmt.Errorf("store the age key in 1Password (%s/%s): %s", onePasswordVault, sopsAgeItem, strings.TrimSpace(stderr))
	}
	return nil
}

// currentSopsPublicKey is the first age recipient in a .sops.yaml: the
// repository's primary key (some rules list a second, purpose-specific
// recipient after it, which a rotation must keep).
func currentSopsPublicKey(config string) (string, bool) {
	key := agePublicKeyRe.FindString(config)
	return key, key != ""
}

// replaceSopsPublicKey swaps every occurrence of oldKey for newKey and
// returns the new content with the number of replacements. Everything else
// in the file (extra rules, extra recipients, comments) is preserved.
func replaceSopsPublicKey(config, oldKey, newKey string) (string, int) {
	count := strings.Count(config, oldKey)
	return strings.ReplaceAll(config, oldKey, newKey), count
}

// defaultSopsConfig is the .sops.yaml a fresh repository gets.
func defaultSopsConfig(publicKey string) string {
	return fmt.Sprintf(`# SOPS configuration: the age public key encrypts, the private key
# (op://%s/%s/private_key) decrypts. Managed by 'task sops:bootstrap'.
creation_rules:
  - path_regex: .*\.sops\.ya?ml$
    encrypted_regex: ^(data|stringData)$
    age: %s

  - path_regex: secrets/.*\.ya?ml$
    encrypted_regex: ^(data|stringData)$
    age: %s
`, onePasswordVault, sopsAgeItem, publicKey, publicKey)
}

// writeSopsConfig puts publicKey into every creation rule of path, creating
// the file when it does not exist.
func writeSopsConfig(path, publicKey string) error {
	existing := readFileOrEmpty(path)
	if existing == "" {
		if DryRun {
			logger.Warn(fmt.Sprintf("Would write %s with public key %s", sopsConfigFile, publicKey))
			return nil
		}
		if err := os.WriteFile(path, []byte(defaultSopsConfig(publicKey)), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", sopsConfigFile, err)
		}
		logger.OK("Wrote " + sopsConfigFile)
		return nil
	}
	current, ok := currentSopsPublicKey(existing)
	if !ok {
		return fmt.Errorf("%s exists but contains no age recipient; add `age: %s` to its creation rules", sopsConfigFile, publicKey)
	}
	if current == publicKey {
		logger.OK(sopsConfigFile + " already carries this public key")
		return nil
	}
	updated, n := replaceSopsPublicKey(existing, current, publicKey)
	if DryRun {
		logger.Warn(fmt.Sprintf("Would replace %s with %s in %s (%d occurrences)", current, publicKey, sopsConfigFile, n))
		return nil
	}
	if err := os.WriteFile(path, []byte(updated), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", sopsConfigFile, err)
	}
	logger.OK(fmt.Sprintf("Updated %s: %s -> %s (%d occurrences)", sopsConfigFile, current, publicKey, n))
	return nil
}

// credentialsSecret is the Secret the ksops generator decrypts for the
// 1Password operator (charts/bootstrap wave -2, namespace onepassword-operator).
type credentialsSecret struct {
	APIVersion string `yaml:"apiVersion"`
	Kind       string `yaml:"kind"`
	Metadata   struct {
		Name      string            `yaml:"name"`
		Namespace string            `yaml:"namespace"`
		Labels    map[string]string `yaml:"labels"`
	} `yaml:"metadata"`
	Type       string            `yaml:"type"`
	StringData map[string]string `yaml:"stringData"`
}

// credentialsSecretYAML renders the plaintext Secret that sops encrypts;
// only stringData is encrypted (.sops.yaml encrypted_regex), the metadata
// stays readable in git.
func credentialsSecretYAML(credentialsJSON, token string) (string, error) {
	credentialsJSON = strings.TrimSpace(credentialsJSON)
	token = strings.TrimSpace(token)
	if credentialsJSON == "" || token == "" {
		return "", errors.New("the 1Password Connect credentials file and token must both be non-empty")
	}
	var secret credentialsSecret
	secret.APIVersion = "v1"
	secret.Kind = "Secret"
	secret.Metadata.Name = "onepassword-credentials"
	secret.Metadata.Namespace = "onepassword-operator"
	secret.Metadata.Labels = map[string]string{
		"app.kubernetes.io/name":       "onepassword-credentials",
		"app.kubernetes.io/managed-by": "sops",
		"app.kubernetes.io/part-of":    "gitops-bootstrap",
	}
	secret.Type = "Opaque"
	secret.StringData = map[string]string{
		sopsCredentialsField: credentialsJSON + "\n",
		"token":              token,
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(secret); err != nil {
		return "", fmt.Errorf("render the credentials Secret: %w", err)
	}
	return buf.String(), nil
}

// redactCredentials blanks the secret values in a plaintext preview.
func redactCredentials(secretYAML, credentialsJSON, token string) string {
	out := secretYAML
	for _, line := range strings.Split(strings.TrimSpace(credentialsJSON), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = strings.ReplaceAll(out, line, "[REDACTED]")
		}
	}
	if token = strings.TrimSpace(token); token != "" {
		out = strings.ReplaceAll(out, token, "[REDACTED]")
	}
	return out
}

// credentialsTemplate is the fill-in-by-hand alternative to `sops setup`.
func credentialsTemplate() string {
	return `# 1Password Connect credentials (gitignored plaintext).
# Fill in both values, then: task sops:encrypt
# Or skip this file: task sops:setup pulls both from op://` + onePasswordVault + `/` + sopsConnectItem + `.
#
# Source: 1Password.com > Developer > Connect Servers (credentials file + access token)
apiVersion: v1
kind: Secret
metadata:
  name: onepassword-credentials
  namespace: onepassword-operator
  labels:
    app.kubernetes.io/name: onepassword-credentials
    app.kubernetes.io/managed-by: sops
    app.kubernetes.io/part-of: gitops-bootstrap
type: Opaque
stringData:
  1password-credentials.json: |
    {
      "verifier": "REPLACEME",
      "encCredentials": "REPLACEME",
      "version": "2"
    }
  token: "REPLACEME"
`
}

// sopsEncryptFile runs sops --encrypt on plaintext (a path a creation rule
// matches) and writes the result to target.
func sopsEncryptFile(root, plaintext, target string) error {
	rel, err := filepath.Rel(root, plaintext)
	if err != nil {
		return err
	}
	cmd := exec.Command("sops", "--encrypt", "--config", filepath.Join(root, sopsConfigFile), rel)
	cmd.Dir = root
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("sops --encrypt %s: %s", rel, strings.TrimSpace(stderr.String()))
	}
	if err := os.WriteFile(target, stdout.Bytes(), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", target, err)
	}
	return nil
}

func gitCommitSecrets(root string) error {
	for _, args := range [][]string{
		{"add", sopsCredentialsFile, sopsConfigFile},
		{"commit", "-m", "chore(secrets): refresh the SOPS-encrypted 1Password Connect credentials"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("git %s: %s", args[0], strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// opItemExists reports whether the vault has an item with that title.
func opItemExists(title string) (bool, error) {
	_, stderr, err := runCapture("", "op", "item", "get", title, "--vault", onePasswordVault, "--format", "json")
	if err == nil {
		return true, nil
	}
	switch {
	case strings.Contains(stderr, "More than one item"):
		return true, nil
	case strings.Contains(stderr, "isn't an item"), strings.Contains(stderr, "not found"):
		return false, nil
	}
	return false, fmt.Errorf("op item get %s: %s", title, strings.TrimSpace(stderr))
}

// opRead resolves an op:// reference. It never goes through utils.DryRun:
// reads are safe and the value must not be echoed.
func opRead(ref string) (string, error) {
	stdout, stderr, err := runCapture("", "op", "read", ref)
	if err != nil {
		return "", errors.New(strings.TrimSpace(stderr))
	}
	return strings.TrimSpace(stdout), nil
}

// runCapture runs a command without logging its arguments (they may carry
// secrets) and returns stdout, stderr and the exit error.
func runCapture(stdin, name string, args ...string) (string, string, error) {
	cmd := exec.Command(name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

func readFileOrEmpty(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

func checkToolInstalled(tool string) error {
	if _, err := exec.LookPath(tool); err != nil {
		return fmt.Errorf("%s not found", tool)
	}
	return nil
}

func check1PasswordAuth() error {
	if _, _, err := runCapture("", "op", "whoami"); err != nil {
		return errors.New("1Password CLI not authenticated")
	}
	return nil
}
