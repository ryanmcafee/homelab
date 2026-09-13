package commands

import (
	"fmt"
	"os"

	"github.com/ryanmcafee/homelab/internal/verify"
	"github.com/spf13/cobra"
)

// upgradeRunner executes git and helm for `verify upgrade`; tests replace it.
var upgradeRunner verify.Runner = verify.ExecRunner{}

// upgradeRender is the level-0 render pass `verify upgrade` runs twice; tests
// replace it so no real configuration tree is needed.
var upgradeRender = verify.Render

type upgradeOptions struct {
	base           string
	envList        string
	report         string
	asJSON         bool
	keep           bool
	maxDiffLines   int
	reportMaxBytes int
	parallel       int

	envs []verify.Env
}

// validate rejects bad invocations before any directory or worktree exists.
func (o *upgradeOptions) validate(args []string) error {
	if len(args) > 0 {
		return usageErrorf("unexpected argument %q", args[0])
	}
	if o.base == "" {
		return usageErrorf("--base is required (e.g. --base origin/main)")
	}
	if o.maxDiffLines < 1 {
		return usageErrorf("--max-diff-lines must be at least 1, got %d", o.maxDiffLines)
	}
	if o.parallel < 0 {
		return usageErrorf("--parallel must be zero (auto) or positive, got %d", o.parallel)
	}
	if o.reportMaxBytes != 0 && o.reportMaxBytes < 1000 {
		return usageErrorf("--report-max-bytes must be 0 (unlimited) or at least 1000, got %d", o.reportMaxBytes)
	}
	envs, err := verify.ParseEnvs(o.envList)
	if err != nil {
		return NewUsageError(err)
	}
	o.envs = envs
	return nil
}

func newVerifyUpgradeCmd() *cobra.Command {
	var o upgradeOptions

	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Render every changed upstream Helm chart at a base ref and at the working tree and diff the manifests",
		Long: `Level 0 renders this repository's charts, so an Application that points at an
upstream chart (spec.source.chart or spec.sources[].chart) with inline values is
only checked as an Application object: a chart bump in configuration/versions.yaml
changes one targetRevision line and nothing shows what the new chart deploys.

verify upgrade closes that gap. It checks the base ref out into a temporary
git worktree (removed afterwards unless --keep), runs the level-0 render there
and in the working tree, and collects every Application Helm chart source on
both sides: repoURL, chart, targetRevision, helm.values, helm.valuesObject,
helm.parameters, releaseName and destination namespace. Every source that was
added, removed or changed is rendered with helm template at both sides
(--include-crds, the Application's namespace and release name, the target
Kubernetes version from each side's versions.yaml; OCI repositories as
oci://<repoURL>/<chart>, others with --repo), the helm.sh/chart and
app.kubernetes.io/version labels are dropped, and the manifests are diffed
object by object.

Checks:
  upgrade/<env>/<app>    pass "unchanged: ..." or "manifest diff: +A -D lines
                         (...)" with the diff as findings and any CRD whose
                         spec changed; fail when the head render fails; skip
                         when only the base render fails
  upgrade/<env>/_repo    the level-0 render of this repository's own charts,
                         base vs head, with Application chart sources masked
  upgrade/<env>/_render  (fail) the working tree does not render

Unchanged sources are not re-rendered, so the command needs network access
only for the charts a change touches. --report writes a markdown summary with
one collapsed diff per changed item (the upgrade-diff PR comment).

Exit status: 0 when every check passes (a manifest diff is a pass: it is
information for the reviewer), 1 when a render fails, 2 on a usage error or an
unknown --base.`,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := o.validate(args); err != nil {
				return err
			}
			root, err := findProjectRoot()
			if err != nil {
				return err
			}
			if _, err := verify.ResolveRef(cmd.Context(), upgradeRunner, root, o.base); err != nil {
				return NewUsageError(fmt.Errorf("--base: %w", err))
			}

			workDir, err := os.MkdirTemp("", "homelab-upgrade-")
			if err != nil {
				return fmt.Errorf("creating a temp work directory: %w", err)
			}
			if o.keep {
				defer fmt.Fprintf(cmd.ErrOrStderr(), "work directory kept at %s (base worktree %s/base is still registered; remove it with: git worktree remove --force %s/base)\n", workDir, workDir, workDir)
			} else {
				defer os.RemoveAll(workDir)
			}

			out, res := verify.Upgrade(cmd.Context(), verify.UpgradeOptions{
				Runner:       upgradeRunner,
				RepoRoot:     root,
				BaseRef:      o.base,
				Envs:         o.envs,
				WorkDir:      workDir,
				Keep:         o.keep,
				MaxDiffLines: o.maxDiffLines,
				Parallel:     o.parallel,
				Render:       upgradeRender,
			})

			if o.report != "" {
				if err := os.WriteFile(o.report, []byte(verify.UpgradeReport(out, res, o.reportMaxBytes)), 0o644); err != nil {
					return fmt.Errorf("writing --report %s: %w", o.report, err)
				}
			}
			return emitResult(cmd, res, o.asJSON)
		},
	}

	cmd.Flags().StringVar(&o.base, "base", "", "Git revision to compare against, e.g. origin/main (required)")
	cmd.Flags().StringVar(&o.envList, "env", "homelab", "Environments to render (homelab, localdev, all, or a comma-separated list)")
	cmd.Flags().StringVar(&o.report, "report", "", "Write a markdown report to this file")
	cmd.Flags().IntVar(&o.reportMaxBytes, "report-max-bytes", 0, "Shrink the report's diffs until it fits this many bytes (0: unlimited; a GitHub comment holds 65536)")
	cmd.Flags().BoolVar(&o.asJSON, "json", false, "Emit the machine-readable result contract")
	cmd.Flags().BoolVar(&o.keep, "keep", false, "Keep the base worktree and every render for inspection")
	cmd.Flags().IntVar(&o.maxDiffLines, "max-diff-lines", verify.DefaultUpgradeMaxDiffLines, "Maximum diff lines per check in the findings and the report")
	cmd.Flags().IntVar(&o.parallel, "parallel", 0, "Concurrent helm invocations (default: number of CPUs)")

	return cmd
}
