package verify

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Doc is one rendered Kubernetes object plus its provenance.
type Doc struct {
	Object map[string]any
	Chart  string // chart directory name, e.g. "addons", "tailscale-config"
	Env    string // "localdev" | "homelab"
}

// APIVersion returns apiVersion or "".
func (d Doc) APIVersion() string { return d.GetString("apiVersion") }

// Kind returns kind or "".
func (d Doc) Kind() string { return d.GetString("kind") }

// Name returns metadata.name or "".
func (d Doc) Name() string { return d.GetString("metadata", "name") }

// Namespace returns metadata.namespace or "".
func (d Doc) Namespace() string { return d.GetString("metadata", "namespace") }

// Group returns the API group ("" for core).
func (d Doc) Group() string {
	av := d.APIVersion()
	if i := strings.Index(av, "/"); i >= 0 {
		return av[:i]
	}
	return ""
}

// Annotations returns metadata.annotations (never nil).
func (d Doc) Annotations() map[string]string { return d.stringMap("metadata", "annotations") }

// Labels returns metadata.labels (never nil).
func (d Doc) Labels() map[string]string { return d.stringMap("metadata", "labels") }

// ID is a stable "kind/namespace/name" identifier for messages.
func (d Doc) ID() string {
	return fmt.Sprintf("%s/%s/%s", d.Kind(), d.Namespace(), d.Name())
}

// Get walks nested maps by key path.
func (d Doc) Get(path ...string) (any, bool) {
	var cur any = d.Object
	for _, p := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		cur, ok = m[p]
		if !ok {
			return nil, false
		}
	}
	return cur, true
}

// GetString returns a string at path or "".
func (d Doc) GetString(path ...string) string {
	v, ok := d.Get(path...)
	if !ok {
		return ""
	}
	switch s := v.(type) {
	case string:
		return s
	case int, int64, float64, bool:
		return fmt.Sprintf("%v", s)
	}
	return ""
}

// GetSlice returns a []any at path or nil.
func (d Doc) GetSlice(path ...string) []any {
	v, ok := d.Get(path...)
	if !ok {
		return nil
	}
	s, _ := v.([]any)
	return s
}

// GetStringSlice returns a []string at path (non-strings skipped).
func (d Doc) GetStringSlice(path ...string) []string {
	var out []string
	for _, v := range d.GetSlice(path...) {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func (d Doc) stringMap(path ...string) map[string]string {
	out := map[string]string{}
	v, ok := d.Get(path...)
	if !ok {
		return out
	}
	m, ok := v.(map[string]any)
	if !ok {
		return out
	}
	for k, val := range m {
		if s, ok := val.(string); ok {
			out[k] = s
		} else if val != nil {
			out[k] = fmt.Sprintf("%v", val)
		}
	}
	return out
}

// ParseMultiDoc splits a YAML stream into Docs, skipping empty documents.
func ParseMultiDoc(chart, env string, data []byte) ([]Doc, error) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	var docs []Doc
	for i := 0; ; i++ {
		var obj map[string]any
		err := dec.Decode(&obj)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%s/%s: document %d: %w", env, chart, i, err)
		}
		if len(obj) == 0 {
			continue
		}
		docs = append(docs, Doc{Object: obj, Chart: chart, Env: env})
	}
	return docs, nil
}

// RenderedFile returns the on-disk path for a chart render: <dir>/<env>/<chart>.yaml.
func RenderedFile(dir, env, chart string) string {
	return filepath.Join(dir, env, chart+".yaml")
}

// LoadRenderDir reads <dir>/<env>/<chart>.yaml files written by the renderer
// and returns env -> chart -> docs. Files starting with "_" are metadata and
// are skipped.
func LoadRenderDir(dir string) (map[string]map[string][]Doc, error) {
	out := map[string]map[string][]Doc{}
	envs, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range envs {
		if !e.IsDir() {
			continue
		}
		env := e.Name()
		files, err := os.ReadDir(filepath.Join(dir, env))
		if err != nil {
			return nil, err
		}
		out[env] = map[string][]Doc{}
		for _, f := range files {
			name := f.Name()
			if f.IsDir() || strings.HasPrefix(name, "_") || !strings.HasSuffix(name, ".yaml") {
				continue
			}
			chart := strings.TrimSuffix(name, ".yaml")
			data, err := os.ReadFile(filepath.Join(dir, env, name))
			if err != nil {
				return nil, err
			}
			docs, err := ParseMultiDoc(chart, env, data)
			if err != nil {
				return nil, err
			}
			out[env][chart] = docs
		}
	}
	return out, nil
}

func splitComma(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
