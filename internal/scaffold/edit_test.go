package scaffold

import (
	"strings"
	"testing"
)

func TestAppendBlockSeparatesWithExactlyOneBlankLine(t *testing.T) {
	tests := []struct {
		name    string
		content string
		block   string
		want    string
	}{
		{"content ends in one newline", "a: 1\n", "b: 2\n", "a: 1\n\nb: 2\n"},
		{"content ends in blank lines", "a: 1\n\n\n", "\n\nb: 2\n", "a: 1\n\nb: 2\n"},
		{"content has no final newline", "a: 1", "b: 2", "a: 1\n\nb: 2\n"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(appendBlock([]byte(tc.content), tc.block)); got != tc.want {
				t.Errorf("appendBlock = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestInsertAtEndOfBlock(t *testing.T) {
	const providers = `# header
---
providers:
  a.io: a
  b.io:
    app: b
    skipKinds:
      - X

# Namespaces comment
systemNamespaces:
  - argocd
`
	tests := []struct {
		name    string
		content string
		key     string
		block   string
		blank   bool
		want    string
		wantErr string
	}{
		{
			name:    "before the comment that introduces the next key",
			content: providers,
			key:     "providers",
			block:   "  c.io: c\n",
			want: `# header
---
providers:
  a.io: a
  b.io:
    app: b
    skipKinds:
      - X
  c.io: c

# Namespaces comment
systemNamespaces:
  - argocd
`,
		},
		{
			name:    "last key runs to the end of the file, with a blank line",
			content: "keys:\n  A:\n    const: x\n",
			key:     "keys",
			block:   "\n\n  B:\n    const: y\n",
			blank:   true,
			want:    "keys:\n  A:\n    const: x\n\n  B:\n    const: y\n",
		},
		{
			name:    "file without a final newline",
			content: "charts:\n  a: \"1\"",
			key:     "charts",
			block:   "  b: \"2\"\n",
			want:    "charts:\n  a: \"1\"\n  b: \"2\"\n",
		},
		{
			name:    "missing key",
			content: "other: 1\n",
			key:     "charts",
			block:   "  b: 2\n",
			wantErr: `no top-level "charts:" key`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := insertAtEndOfBlock([]byte(tc.content), tc.key, tc.block, tc.blank)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.want {
				t.Errorf("got:\n%s\nwant:\n%s", got, tc.want)
			}
		})
	}
}

func TestInsertSortedListItem(t *testing.T) {
	const huge = "# c\n---\ncharts:\n  - argocd\n  - cilium\n  - traefik\n"
	tests := []struct {
		item string
		want string
	}{
		{"cert-manager", "# c\n---\ncharts:\n  - argocd\n  - cert-manager\n  - cilium\n  - traefik\n"},
		{"aaa", "# c\n---\ncharts:\n  - aaa\n  - argocd\n  - cilium\n  - traefik\n"},
		{"zzz", "# c\n---\ncharts:\n  - argocd\n  - cilium\n  - traefik\n  - zzz\n"},
	}
	for _, tc := range tests {
		t.Run(tc.item, func(t *testing.T) {
			got, err := insertSortedListItem([]byte(huge), "charts", tc.item)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.want {
				t.Errorf("got:\n%s\nwant:\n%s", got, tc.want)
			}
		})
	}
}

func TestInsertRenovatePackage(t *testing.T) {
	const cfg = `{
  packageRules: [
    {
      groupName: 'Other',
      matchPackageNames: [
        'x',
      ],
    },
    {
      groupName: 'TrueCharts applications',
      matchPackageNames: [
        'oci.trueforge.org/truecharts/sonarr',
        'oci.trueforge.org/truecharts/radarr',
      ],
      matchDatasources: ['docker'],
    },
  ],
}
`
	t.Run("appends to the named group only", func(t *testing.T) {
		got, ok := insertRenovatePackage([]byte(cfg), "TrueCharts applications", "'oci.trueforge.org/truecharts/new',")
		if !ok {
			t.Fatal("list not found")
		}
		want := strings.Replace(cfg, "        'oci.trueforge.org/truecharts/radarr',\n",
			"        'oci.trueforge.org/truecharts/radarr',\n        'oci.trueforge.org/truecharts/new',\n", 1)
		if string(got) != want {
			t.Errorf("got:\n%s", got)
		}
	})
	t.Run("already listed is a no-op", func(t *testing.T) {
		got, ok := insertRenovatePackage([]byte(cfg), "TrueCharts applications", "'oci.trueforge.org/truecharts/sonarr',")
		if !ok || string(got) != cfg {
			t.Errorf("ok=%v, content changed=%v", ok, string(got) != cfg)
		}
	})
	t.Run("unknown group reports not found", func(t *testing.T) {
		got, ok := insertRenovatePackage([]byte(cfg), "Nope", "'y',")
		if ok || string(got) != cfg {
			t.Errorf("ok=%v, content changed=%v", ok, string(got) != cfg)
		}
	})
}

func TestSplitKeep(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"a\n", []string{"a\n"}},
		{"a\nb", []string{"a\n", "b"}},
		{"a\n\nb\n", []string{"a\n", "\n", "b\n"}},
	}
	for _, tc := range tests {
		got := splitKeep([]byte(tc.in))
		if strings.Join(got, "|") != strings.Join(tc.want, "|") || len(got) != len(tc.want) {
			t.Errorf("splitKeep(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
