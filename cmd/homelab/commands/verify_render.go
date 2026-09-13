package commands

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ryanmcafee/homelab/internal/verify"
	"github.com/spf13/cobra"
)

// ErrVerificationFailed signals that checks ran and at least one failed. Its
// findings have already been printed, as text or as the JSON result contract,
// so main exits 1 without printing the error again. A usage error is wrapped
// as a UsageError and exits 2, which lets agents tell "bad invocation" from
// "the repository is broken".
var ErrVerificationFailed = errors.New("verification failed")

// usageErrorf builds a usage error. It returns rather than exiting so every
// deferred cleanup still runs, notably the temp render directory.
func usageErrorf(format string, args ...any) error {
	return NewUsageError(fmt.Errorf(format, args...))
}

// UsageErrorFunc is cobra's FlagErrorFunc for the whole command tree. An
// unknown or malformed flag is a misuse, so it prints usage and marks the error
// as a UsageError, which ExitCode maps to 2. Set it on the root: cobra walks up
// to the nearest ancestor that has one.
func UsageErrorFunc(c *cobra.Command, err error) error {
	fmt.Fprintln(c.ErrOrStderr(), c.UsageString())
	return NewUsageError(err)
}

// UsageArgs wraps a cobra positional-argument validator so a rejected argument
// list becomes a UsageError (exit 2) instead of an ordinary error (exit 1).
// cobra.NoArgs on its own reports a misuse, but exiting 1 made it read to an
// autonomous caller as a broken repository.
//
// The root sets SilenceUsage, so help is printed here rather than by cobra.
func UsageArgs(fn cobra.PositionalArgs) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if err := fn(cmd, args); err != nil {
			_ = cmd.Help()
			return NewUsageError(err)
		}
		return nil
	}
}

// GroupCommandArgs is the Args validator for a command group. A group carries
// no behaviour of its own, so any positional argument is an unknown
// subcommand: it is named, help is printed, and the command exits 2.
func GroupCommandArgs(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return nil
	}
	_ = cmd.Help()
	return NewUsageError(fmt.Errorf("unknown %s subcommand %q; run %s --help for the list",
		cmd.Name(), args[0], cmd.CommandPath()))
}

// RunGroupCommand is the RunE of a command group. Cobra's default for a parent
// with no RunE is to print help and exit 0, which reported both `homelab
// verify` and `homelab verify rendr` as successes. A group is never runnable,
// so invoking one directly is always a misuse.
func RunGroupCommand(cmd *cobra.Command, args []string) error {
	if len(args) > 0 {
		return GroupCommandArgs(cmd, args)
	}
	_ = cmd.Help()
	return NewUsageError(fmt.Errorf("%s requires a subcommand", cmd.CommandPath()))
}

// emitResult writes a Result as JSON or human-readable text and returns
// ErrVerificationFailed when the result did not pass.
func emitResult(cmd *cobra.Command, res *verify.Result, asJSON bool) error {
	out := cmd.OutOrStdout()
	if asJSON {
		data, err := res.JSON()
		if err != nil {
			return fmt.Errorf("encoding result: %w", err)
		}
		fmt.Fprintln(out, string(data))
	} else {
		res.WriteText(out)
	}
	if !res.Pass {
		return ErrVerificationFailed
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
	omitSchema bool
	parallel   int

	// envs is populated by validate() so the flag is rejected before any
	// filesystem work happens.
	envs []verify.Env
}

// bindRenderFlags registers the render flags on a command.
func bindRenderFlags(cmd *cobra.Command, o *renderPassOptions) {
	cmd.Flags().StringVar(&o.envList, "env", "all", "Environments to verify (all, localdev, homelab, or a comma-separated list)")
	cmd.Flags().StringArrayVar(&o.charts, "chart", nil, "Restrict to a chart directory name (repeatable)")
	cmd.Flags().StringVar(&o.outDir, "out-dir", "", "Directory for rendered manifests. Reused as-is and never pruned, so stale files from a previous run with a wider --chart or --env survive; prefer a fresh directory (default: a temp dir removed on exit)")
	cmd.Flags().BoolVar(&o.keep, "keep", false, "Keep the render directory instead of deleting it")
	cmd.Flags().BoolVar(&o.asJSON, "json", false, "Emit the machine-readable result contract")
	cmd.Flags().IntVar(&o.parallel, "parallel", 0, "Concurrent helm invocations (default: number of CPUs)")
}

// validate checks the flags that do not depend on the filesystem. It runs
// before any directory is created so a usage error cannot leak a temp dir.
func (o *renderPassOptions) validate(args []string) error {
	if len(args) > 0 {
		return usageErrorf("unexpected argument %q", args[0])
	}
	envs, err := verify.ParseEnvs(o.envList)
	if err != nil {
		return NewUsageError(err)
	}
	if o.parallel < 0 {
		return usageErrorf("--parallel must be zero (auto) or positive, got %d", o.parallel)
	}
	o.envs = envs
	return nil
}

// filtered reports whether the render covers less than every chart and env,
// which makes orphan-snapshot detection meaningless.
func (o *renderPassOptions) filtered() bool {
	return len(o.charts) > 0 || len(o.envs) != len(verify.Envs)
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

// renderPass runs a level-0 render with the shared flags applied. validate
// must have run first.
func (o *renderPassOptions) renderPass(cmd *cobra.Command, outDir string) (*verify.RenderOutput, *verify.Result, error) {
	root, err := findProjectRoot()
	if err != nil {
		return nil, nil, err
	}

	out, res := verify.Render(cmd.Context(), verify.RenderOptions{
		RepoRoot:         root,
		OutDir:           outDir,
		Envs:             o.envs,
		Charts:           o.charts,
		Parallel:         o.parallel,
		SkipLint:         o.skipLint,
		SkipSchema:       o.skipSchema,
		OmitSchemaChecks: o.omitSchema,
		SchemaDir:        filepath.Join(root, "tests", "schemas"),
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
management plugin. Parents render before children, and a child chart receives
the helm.valuesObject its parent Application passes it as an extra values
file (<out>/<env>/_inherited/<chart>.yaml), so derived values such as the
domain and the iSCSI portal reach children exactly as they do in ArgoCD. The
gitops chart gets --set global.domain=<DOMAIN> for homelab, mirroring the
helm parameter the Terraform root Application injects.

Exit status: 0 when every check passes, 1 when a check fails, 2 on a usage
error.`,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := o.validate(args); err != nil {
				return err
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
			return emitResult(cmd, res, o.asJSON)
		},
	}

	bindRenderFlags(cmd, &o)
	cmd.Flags().BoolVar(&o.skipLint, "skip-lint", false, "Skip the helm lint checks")
	cmd.Flags().BoolVar(&o.skipSchema, "skip-schema", false, "Skip the kubeconform and pluto checks")

	return cmd
}
