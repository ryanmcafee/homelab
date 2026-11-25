package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// LocaldevNZBGetSchema renders the exact upstream source emitted by the
// applications chart. Helm validates values.schema.json before rendering.
func LocaldevNZBGetSchema(ctx context.Context, r Runner, workDir, kubeVersion string, files map[string]string) Check {
	start := time.Now()
	const name = "upstream/localdev/nzbget-schema"
	sources, err := sourcesFromFiles(files)
	if err != nil {
		return FailCheck(name, start, "reading rendered Application sources", err.Error())
	}
	src, ok := sources["nzbget"]
	if !ok {
		return FailCheck(name, start, "nzbget chart source is missing from the localdev render")
	}
	if _, err := r.LookPath("helm"); err != nil {
		return FailCheck(name, start, ToolMissingDetail("helm"))
	}
	dir, err := os.MkdirTemp(workDir, "nzbget-schema-")
	if err != nil {
		return FailCheck(name, start, "creating chart render directory", err.Error())
	}
	defer os.RemoveAll(dir)
	_, renderErr := renderUpstream(ctx, r, workDir, src, kubeVersion, filepath.Join(dir, "render"))
	if renderErr != nil {
		return FailCheck(name, start, fmt.Sprintf("%s %s failed schema-validating render: %s", src.Chart, src.TargetRevision, renderErr.detail), renderErr.lines...)
	}
	return PassCheck(name, start, fmt.Sprintf("%s %s rendered with localdev Application values", src.Chart, src.TargetRevision))
}
