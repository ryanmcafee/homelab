package verify

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestUpgradeReportSecretSentinel(t *testing.T) {
	const sentinel = "SYNTHETIC_REPORT_SENTINEL"
	secret := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: synthetic\nstringData:\n  password: " + sentinel + "\n"
	for _, tc := range []struct{ name, base, head string }{
		{"added", "", secret}, {"deleted", secret, ""},
		{"changed", secret, strings.ReplaceAll(secret, sentinel, sentinel+"_NEXT")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			item := UpgradeItem{Check: "upgrade/test/synthetic", Change: "synthetic"}
			check := finishJob(&upgradeJob{baseOut: []byte(tc.base), headOut: []byte(tc.head)}, &item, 400)
			res := NewResult(0)
			res.Add(check)
			encoded, err := res.JSON()
			if err != nil {
				t.Fatal(err)
			}
			out := &UpgradeOutput{Items: []UpgradeItem{item}}
			for sink, body := range map[string]string{"json": string(encoded), "markdown": UpgradeReport(out, res, 0)} {
				if strings.Contains(body, sentinel) {
					t.Errorf("%s exposed synthetic Secret payload", sink)
				}
			}
		})
	}
}

func TestUpgradeSecretKeyChangesRemainVisible(t *testing.T) {
	base := `apiVersion: v1
kind: Secret
metadata: {name: synthetic}
data: {same: SYNTHETIC_BASE_SAME, changed: SYNTHETIC_BASE_CHANGED, removed: SYNTHETIC_BASE_REMOVED}
stringData: {message: SYNTHETIC_BASE_MESSAGE}
`
	head := `apiVersion: v1
kind: Secret
metadata: {name: synthetic}
data: {same: SYNTHETIC_BASE_SAME, changed: SYNTHETIC_HEAD_CHANGED, added: SYNTHETIC_HEAD_ADDED}
stringData: {message: SYNTHETIC_HEAD_MESSAGE}
`
	item := UpgradeItem{Check: "upgrade/test/synthetic"}
	check := finishJob(&upgradeJob{baseOut: []byte(base), headOut: []byte(head)}, &item, 400)
	if check.Status != StatusPass {
		t.Fatalf("Secret presence must not fail an otherwise valid diff: %s", check.Status)
	}
	if item.Added < 2 || item.Deleted < 2 {
		t.Fatalf("Secret key status must contribute to diff counts: +%d -%d", item.Added, item.Deleted)
	}
	res := NewResult(0)
	res.Add(check)
	encoded, _ := res.JSON()
	for _, body := range []string{string(encoded), UpgradeReport(&UpgradeOutput{Items: []UpgradeItem{item}}, res, 0)} {
		for _, sentinel := range []string{"SYNTHETIC_BASE_", "SYNTHETIC_HEAD_"} {
			if strings.Contains(body, sentinel) {
				t.Fatalf("Secret payload exposed")
			}
		}
		for _, signal := range []string{"changed", "removed", "added", "message"} {
			if !strings.Contains(body, signal) {
				t.Errorf("missing safe key signal %q", signal)
			}
		}
	}
}

func TestUpgradeNullSecretFieldsAreEmpty(t *testing.T) {
	manifest := []byte("apiVersion: v1\nkind: Secret\nmetadata: {name: empty}\ndata:\nstringData:\n")
	for _, normalize := range []func([]byte) (map[string]string, error){normaliseManifest, normaliseRepoManifest} {
		objects, err := normalize(manifest)
		if err != nil {
			t.Fatalf("null Secret fields should be safe empty maps: %v", err)
		}
		if len(objects) != 1 {
			t.Fatalf("expected one Secret, got %d", len(objects))
		}
	}
}

func TestUpgradeRedactionNestedAndInvalid(t *testing.T) {
	const sentinel = "SYNTHETIC_NESTED_SENTINEL"
	input := `apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: List
    items:
      - apiVersion: v1
        kind: Secret
        metadata:
          name: synthetic
          annotations:
            kubectl.kubernetes.io/last-applied-configuration: SYNTHETIC_NESTED_SENTINEL
        data: {password: SYNTHETIC_NESTED_SENTINEL}
        stringData: {password: SYNTHETIC_NESTED_SENTINEL}
  - apiVersion: v1
    kind: SecretList
    items:
      - metadata: {name: typed-item}
        data: {password: SYNTHETIC_NESTED_SENTINEL}
        stringData: {password: SYNTHETIC_NESTED_SENTINEL}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: public}
data: {visible: public-value}
`
	for _, normalize := range []func([]byte) (map[string]string, error){normaliseManifest, normaliseRepoManifest} {
		objects, err := normalize([]byte(input))
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(objects)
		if strings.Contains(string(encoded), sentinel) {
			t.Fatal("nested Secret payload exposed")
		}
		if !strings.Contains(string(encoded), "public-value") {
			t.Fatal("nonsecret data removed")
		}
		if !strings.Contains(string(encoded), "password") || !(strings.Contains(string(encoded), "<redacted>") || strings.Contains(string(encoded), `\u003credacted\u003e`)) {
			t.Fatal("Secret key names and redaction marker must remain visible")
		}
		for _, invalid := range []string{
			input + "---\n[" + sentinel + "]\n",
			"kind: Secret\nmetadata: {name: test}\nstringData:\n  " + sentinel + ": first\n  " + sentinel + ": second\n",
			"kind: Secret\nmetadata: {name: test}\ninvalid: {1: " + sentinel + "}\n",
		} {
			objects, err := normalize([]byte(invalid))
			if err == nil || objects != nil {
				t.Fatal("invalid input did not fail closed")
			}
			if strings.Contains(err.Error(), sentinel) {
				t.Fatal("parser/redactor error echoed input")
			}
		}
	}
}

func TestUpgradeErrorReportsOmitPayload(t *testing.T) {
	const sentinel = "SYNTHETIC_ERROR_SENTINEL"
	for _, job := range []*upgradeJob{
		{headErr: &upstreamError{detail: sentinel, lines: []string{sentinel}}},
		{baseErr: &upstreamError{detail: sentinel, lines: []string{sentinel}}},
		{headOut: []byte("[" + sentinel + "]")},
		{baseOut: []byte("[" + sentinel + "]")},
	} {
		item := UpgradeItem{Check: "upgrade/test/synthetic"}
		check := finishJob(job, &item, 400)
		if check.Status == StatusPass {
			t.Fatal("unsafe input passed")
		}
		res := NewResult(0)
		res.Add(check)
		encoded, _ := res.JSON()
		for _, text := range []string{string(encoded), UpgradeReport(&UpgradeOutput{Items: []UpgradeItem{item}}, res, 0)} {
			if strings.Contains(text, sentinel) {
				t.Fatal("error report exposed payload")
			}
		}
	}
	for _, job := range []*upgradeJob{
		{baseErr: &upstreamError{detail: sentinel, lines: []string{sentinel}}},
		{baseOut: []byte("[" + sentinel + "]")},
	} {
		item := UpgradeItem{Check: "upgrade/test/synthetic"}
		if check := finishJob(job, &item, 400); check.Status != StatusSkip {
			t.Fatalf("base-side failure should preserve skip status, got %s", check.Status)
		}
	}
	failed := NewResult(0)
	failed.Add(Check{Name: "render/test/chart", Status: StatusFail, Detail: sentinel, Findings: []string{sentinel}})
	_, findings := failedRenders(failed, "test")
	if strings.Contains(strings.Join(findings, "\n"), sentinel) {
		t.Fatal("level-0 error exposed payload")
	}
}

func TestUpgradeRepoReportsOmitPayload(t *testing.T) {
	const sentinel = "SYNTHETIC_REPO_SENTINEL"
	secret := "kind: Secret\napiVersion: v1\nmetadata: {name: synthetic}\nstringData: {password: " + sentinel + "}\n"
	for _, tc := range []struct{ base, head string }{{"", secret}, {secret, ""}, {secret, strings.ReplaceAll(secret, sentinel, sentinel+"_NEXT")}, {secret, secret + "---\n[" + sentinel + "]"}} {
		out, res := Upgrade(context.Background(), UpgradeOptions{
			Runner:   &fakeUpgradeRunner{sha: "0123456789abcdef0123456789abcdef01234567"},
			RepoRoot: t.TempDir(), WorkDir: t.TempDir(), BaseRef: "main",
			Render: fakeRender(map[string]string{"applications": tc.base}, map[string]string{"applications": tc.head}, nil),
		})
		encoded, _ := res.JSON()
		if strings.Contains(string(encoded)+UpgradeReport(out, res, 0), sentinel) {
			t.Fatal("repository report exposed payload")
		}
	}
}
