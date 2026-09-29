package verify

import (
	"fmt"
	"regexp"
)

// Report diagnostics are deliberately fixed text: parser and subprocess errors
// can quote an entire manifest or value, even when stdout is empty.
const upgradeContentOmitted = "manifest content and tool diagnostics omitted for Secret safety; reproduce locally with synthetic values"

var upgradeSecretKind = regexp.MustCompile(`(?m)^\s*kind: Secret(?:List)?\s*$`)

// Redacted equality cannot prove that Secret payloads are unchanged. Keep the
// automerge gate closed without publishing hashes or other payload fingerprints.
func upgradeHasSecrets(objects ...map[string]string) bool {
	for _, group := range objects {
		for _, object := range group {
			if upgradeSecretKind.MatchString(object) {
				return true
			}
		}
	}
	return false
}

// redactUpgradeSecrets runs on parsed objects before either report diff is
// constructed. It also handles typed lists whose items omit their kind.
// It never treats a failed parse or an unsupported mapping as safe raw text.
func redactUpgradeSecrets(value any, secretItem bool) error {
	switch v := value.(type) {
	case map[string]any:
		kind, _ := v["kind"].(string)
		if kind == "Secret" || secretItem {
			delete(v, "data")
			delete(v, "stringData")
		}
		// A last-applied annotation can embed any previous object, including a
		// Secret. Drop it everywhere, not only on currently Secret objects.
		if metadata, ok := v["metadata"].(map[string]any); ok {
			if annotations, ok := metadata["annotations"].(map[string]any); ok {
				delete(annotations, "kubectl.kubernetes.io/last-applied-configuration")
			}
		}
		for key, child := range v {
			if err := redactUpgradeSecrets(child, key == "items" && kind == "SecretList"); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range v {
			if err := redactUpgradeSecrets(child, secretItem); err != nil {
				return err
			}
		}
	case map[any]any:
		return fmt.Errorf("unsupported manifest mapping; %s", upgradeContentOmitted)
	}
	return nil
}
