package commands

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ryanmcafee/homelab/internal/verify"
	"github.com/spf13/cobra"
)

// errVerificationFailed signals that checks ran and at least one failed. main
// turns any returned error into exit status 1; usage errors exit 2 via
// usageErrorf so agents can tell "bad invocation" from "repo is broken".
var errVerificationFailed = errors.New("verification failed")

// usageErrorf prints a usage error and exits 2 (the documented usage-error
// status for every homelab verify subcommand).
func usageErrorf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	os.Exit(2)
}

// emitResult writes a Result as JSON or human-readable text and returns
// errVerificationFailed when the result did not pass.
func emitResult(res *verify.Result, asJSON bool) error {
	if asJSON {
		data, err := res.JSON()
		if err != nil {
			return fmt.Errorf("encoding result: %w", err)
		}
		fmt.Println(string(data))
	} else {
		res.WriteText(os.Stdout)
	}
	if !res.Pass {
		return errVerificationFailed
	}
	return nil
}

// renderPassOptions is the flag set shared by `verify render` and
// `verify snapshot`, both of which start from a level-0 render.
type renderPassOptions struct {
	envList    string
	charts     []string
	outDir     string
	keep       bool
	asJSON     bool
	skipLint   bool
	skipSchema bool
	parallel   int
}

// bindRenderFlags registers the render flags on a command.
func bindRenderFlags(cmd *cobra.Command, o *renderPassOptions) {
	cmd.Flags().StringVar(&o.envList, "env", "all", "Environments to verify (all, localdev, homelab, or a comma-separated list)")
	cmd.Flags().StringArrayVar(&o.charts, "chart", nil, "Restrict to a chart directory name (repeatable)")
	cmd.Flags().StringVar(&o.outDir, "out-dir", "", "Directory for rendered manifests (default: a temp dir removed on exit)")
	cmd.Flags().BoolVar(&o.keep, "keep", false, "Keep the render directory instead of deleting it")
	cmd.Flags().BoolVar(&o.asJSON, "json", false, "Emit the machine-readable result contract")
	cmd.Flags().IntVar(&o.parallel, "parallel", 0, "Concurrent helm invocations (default: number of CPUs)")
}

// resolveOutDir returns the render directory and a cleanup function.
func (o *renderPassOptions) resolveOutDir() (string, func(), error) {
	if o.outDir != "" {
		if err := os.MkdirAll(o.outDir, 0o755); err != nil {
			return "", nil, fmt.Errorf("creating %s: %w", o.outDir, err)
		}
		return o.outDir, func() {}, nil
	}
	dir, err := os.MkdirTemp("", "homelab-verify-")
	if err != nil {
		return "", nil, fmt.Errorf("creating a temp render directory: %w", err)
	}
	if o.keep {
		return dir, func() { fmt.Fprintf(os.Stderr, "render directory kept at %s\n", dir) }, nil
	}
	return dir, func() { os.RemoveAll(dir) }, nil
}

// renderPass runs a level-0 render with the shared flags applied.
func (o *renderPassOptions) renderPass(cmd *cobra.Command, outDir string) (*verify.RenderOutput, *verify.Result, error) {
	root, err := findProjectRoot()
	if err != nil {
		return nil, nil, err
	}
	envs, err := verify.ParseEnvs(o.envList)
	if err != nil {
		usageErrorf("%v", err)
	}

	out, res := verify.Render(cmd.Context(), verify.RenderOptions{
		RepoRoot:   root,
		OutDir:     outDir,
		Envs:       envs,
		Charts:     o.charts,
		Parallel:   o.parallel,
		SkipLint:   o.skipLint,
		SkipSchema: o.skipSchema,
		SchemaDir:  filepath.Join(root, "tests", "schemas"),
	})
	return out, res, nil
}

func newVerifyRenderCmd() *cobra.Command {
	var o renderPassOptions

	cmd := &cobra.Command{
		Use:   "render",
		Short: "Render, lint and schema-validate every chart (level 0)",
		Long: `Render every Helm chart for every environment without a cluster, then lint
the charts and validate the rendered manifests against the Kubernetes and CRD
JSON schemas.

Level 0 reads only configuration/environments/localdev.yaml and
configuration/environments/homelab.yaml.example, so it never touches real
homelab values. The addons and applications parents render two-stage for
homelab (config export -> helm template), mirroring the ArgoCD config
management plugin.

Exit status: 0 when every check passes, 1 when a check fails, 2 on a usage
error.`,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				usageErrorf("unexpected argument %q", args[0])
			}

			outDir, cleanup, err := o.resolveOutDir()
			if err != nil {
				return err
			}
			defer cleanup()

			_, res, err := o.renderPass(cmd, outDir)
			if err != nil {
				return err
			}
			return emitResult(res, o.asJSON)
		},
	}

	bindRenderFlags(cmd, &o)
	cmd.Flags().BoolVar(&o.skipLint, "skip-lint", false, "Skip the helm lint checks")
	cmd.Flags().BoolVar(&o.skipSchema, "skip-schema", false, "Skip the kubeconform and pluto checks")

	return cmd
}
