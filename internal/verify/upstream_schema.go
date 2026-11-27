package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const trueChartsRepo = "oci.trueforge.org/truecharts"

// LocaldevTrueChartsSchema renders every TrueCharts source the localdev
// applications chart emits with its exact Application values, so Helm
// validates them against each chart's values.schema.json before Kind syncs.
func LocaldevTrueChartsSchema(ctx context.Context, r Runner, workDir, kubeVersion string, files map[string]string) []Check {
	start := time.Now()
	const name = "upstream/localdev/truecharts-schema"
	sources, err := sourcesFromFiles(files)
	if err != nil {
		return []Check{FailCheck(name, start, "reading rendered Application sources", err.Error())}
	}
	var keys []string
	for _, key := range sortedKeys(sources) {
		if strings.TrimSuffix(strings.TrimPrefix(sources[key].RepoURL, "oci://"), "/") == trueChartsRepo {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return []Check{FailCheck(name, start, "no TrueCharts chart source in the localdev render")}
	}
	if _, err := r.LookPath("helm"); err != nil {
		return []Check{FailCheck(name, start, ToolMissingDetail("helm"))}
	}
	checks := make([]Check, 0, len(keys))
	for _, key := range keys {
		checks = append(checks, renderSchemaCheck(ctx, r, workDir, kubeVersion, key, sources[key]))
	}
	return checks
}

func renderSchemaCheck(ctx context.Context, r Runner, workDir, kubeVersion, key string, src ChartSource) Check {
	start := time.Now()
	name := "upstream/localdev/" + key + "-schema"
	dir, err := os.MkdirTemp(workDir, "truecharts-schema-")
	if err != nil {
		return FailCheck(name, start, "creating chart render directory", err.Error())
	}
	defer os.RemoveAll(dir)
	if _, renderErr := renderUpstream(ctx, r, workDir, src, kubeVersion, filepath.Join(dir, "render")); renderErr != nil {
		return FailCheck(name, start, fmt.Sprintf("%s %s failed schema-validating render: %s", src.Chart, src.TargetRevision, renderErr.detail), renderErr.lines...)
	}
	return PassCheck(name, start, fmt.Sprintf("%s %s rendered with localdev Application values", src.Chart, src.TargetRevision))
}
