package commands

import (
	"fmt"
	"io"
	"strings"

	"github.com/fatih/color"
	"github.com/ryanmcafee/homelab/internal/scaffold"
	"github.com/ryanmcafee/homelab/internal/verify"
	"github.com/spf13/cobra"
)

// NewScaffoldCmd returns the `homelab scaffold` command group.
func NewScaffoldCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "scaffold",
		Short: "Generate new apps from the repository's ArgoCD Application patterns",
		Long: `Generate new apps that follow the repository's ArgoCD Application patterns and
pass level 0 (task verify) from the first commit.`,
		Args:          GroupCommandArgs,
		RunE:          RunGroupCommand,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	cmd.AddCommand(newScaffoldAppCmd())
	return cmd
}

// scaffoldAppLong is the operator-facing contract of `homelab scaffold app`.
const scaffoldAppLong = `Generate a new app in one of the repository's three ArgoCD Application patterns
and wire it into every registry level 0 checks.

Patterns:
  operator          One Application for an upstream operator chart that installs CRDs
                    (reference: cloudnative-pg). Requires --crd-group and --crd-kinds.
  helm              One Application for an upstream chart with an Ingress on
                    <name>.<domain> and a PostSync smoke hook; no -config child
                    (reference: sonarr). Default tier: applications.
  deps-main-config  <name>-dependencies (wave-1) < <name> (wave) < <name>-config (wave+2);
                    derived values reach the children through helm.valuesObject
                    (reference: traefik-external, ADR-010).

Writes:
  charts/<tier>/templates/<name>.yaml      Application(s): finalizer, sync-wave, SSA,
                                           automated gated by global.automatedSync, smoke hook
  charts/<tier>/values.yaml                placeholder block
  configuration/templates/helm-*.tmpl      real values: enabled, namespace, version from
                                           .Versions.Charts, Kind sizing ($localdev),
                                           hostname, smoke URL
  configuration/versions.yaml              charts.<name> with its Renovate marker
  configuration/schema/*.schema.yaml       <NAME>_HOSTNAME (helm, deps-main-config)
  charts/<name>-{dependencies,config}/     child charts (deps-main-config)
  tests/gitops/crd-providers.yaml,         with --crd-group; plus a Ready-condition health
  tests/schemas/sources.yaml               Lua per kind in charts/bootstrap/files/health/ and
                                           fixtures in tests/health/<group>_<Kind>/
  tests/gitops/huge-crd-charts.yaml        with --huge-crds
  .github/renovate.json5                   TrueCharts group, for oci://oci.trueforge.org/truecharts
  tests/e2e/<name>/chainsaw-test.yaml      chainsaw test (tests/e2e/README.md)
  docs/apps/<name>.md                      doc stub with the remaining checklist

Then it regenerates, in-process, the tier's committed localdev values
(task config:export:localdev) and the golden snapshots of the charts it touched
(task test:snapshot -- --update), and prints the remaining steps. --no-regenerate
skips that. The global --dry-run prints every file it would create or change as
one git-style patch on stdout (apply it with git apply) and writes nothing.

Exit status: 0 on success, 1 when writing or regenerating failed, 2 on a usage
error (a bad flag value, or a name, key, CRD group or health check that exists).`

const scaffoldAppExample = `  homelab scaffold app podinfo --pattern helm \
    --chart-repo https://stefanprodan.github.io/podinfo --chart-version 6.9.2 \
    --port 9898 --health-path /healthz
  homelab scaffold app sabnzbd --pattern helm \
    --chart-repo oci://oci.trueforge.org/truecharts --chart-version 22.0.0 --port 10097 --dry-run
  homelab scaffold app redis-operator --pattern operator \
    --chart-repo https://ot-container-kit.github.io/helm-charts --chart-version 0.22.0 \
    --crd-group redis.redis.opstreelabs.in --crd-kinds Redis,RedisCluster --huge-crds
  homelab scaffold app vaultwarden --pattern deps-main-config \
    --chart-repo https://guerzon.github.io/vaultwarden --chart-version 0.34.4 --health-path /alive`

func newScaffoldAppCmd() *cobra.Command {
	var (
		o            scaffold.Options
		port, wave   int
		expect       []string
		kinds        []string
		noRegenerate bool
	)
	cmd := &cobra.Command{
		Use:           "app <name>",
		Short:         "Scaffold an app: --pattern operator|helm|deps-main-config",
		Long:          scaffoldAppLong,
		Example:       scaffoldAppExample,
		Args:          UsageArgs(cobra.ExactArgs(1)),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			o.Name = args[0]
			if cmd.Flags().Changed("port") {
				o.Port = &port
			}
			if cmd.Flags().Changed("wave") {
				o.Wave = &wave
			}
			o.Expect = splitCommaList(expect)
			o.CRDKinds = splitCommaList(kinds)
			root, err := findProjectRoot()
			if err != nil {
				return err
			}
			o.RepoRoot = root
			return runScaffoldApp(cmd, o, noRegenerate, DryRun, verify.ExecRunner{})
		},
	}

	f := cmd.Flags()
	f.StringVar(&o.Pattern, "pattern", "", "Application pattern: operator, helm or deps-main-config (required)")
	f.StringVar(&o.Tier, "tier", "", "Parent chart: addons or applications (default: applications for helm, addons otherwise)")
	f.StringVar(&o.Namespace, "namespace", "", "Destination namespace (default: <name>)")
	f.StringVar(&o.ChartRepo, "chart-repo", "", "Upstream Helm repository: https://... or oci://<registry path> without the chart name (required)")
	f.StringVar(&o.ChartName, "chart-name", "", "Upstream chart name (default: <name>)")
	f.StringVar(&o.ChartVersion, "chart-version", "", "Chart version pinned in configuration/versions.yaml (required)")
	f.IntVar(&port, "port", 0, "Service port for the smoke hook and the -config Ingress (default 80; operator: 0 = no smoke hook)")
	f.StringVar(&o.HealthPath, "health-path", "/", "Unauthenticated path the smoke hook and e2e test request")
	f.StringSliceVar(&expect, "expect", []string{"200"}, "Accepted HTTP status codes (comma-separated)")
	f.StringVar(&o.CRDGroup, "crd-group", "", "API group whose CRDs the chart installs (required for operator)")
	f.StringSliceVar(&kinds, "crd-kinds", nil, "Kinds of --crd-group to vendor schemas and health checks for (comma-separated)")
	f.BoolVar(&o.HugeCRDs, "huge-crds", false, "The chart's CRDs exceed the client-side apply limit (tests/gitops/huge-crd-charts.yaml)")
	f.IntVar(&wave, "wave", 0, "Main Application sync wave (default 10 in addons, 13 in applications); -dependencies = wave-1, -config = wave+2")
	f.BoolVar(&noRegenerate, "no-regenerate", false, "Write the sources only; skip regenerating the committed localdev values and the snapshots")
	return cmd
}

// runScaffoldApp builds the plan and prints it (dry run) or writes it and
// regenerates what it feeds. Split from the cobra wiring so tests can drive it
// with a fake runner.
func runScaffoldApp(cmd *cobra.Command, o scaffold.Options, noRegenerate, dryRun bool, runner verify.Runner) error {
	out, errOut := cmd.OutOrStdout(), cmd.ErrOrStderr()

	plan, err := scaffold.Build(o)
	if err != nil {
		if scaffold.IsInputError(err) {
			return NewUsageError(err)
		}
		return err
	}
	var values []scaffold.Change
	if !noRegenerate {
		values, err = scaffold.CommittedValues(o.RepoRoot, plan)
		if err != nil {
			return fmt.Errorf("computing the committed localdev values: %w", err)
		}
	}

	if dryRun {
		fmt.Fprint(out, scaffold.DiffChanges(append(append([]scaffold.Change{}, plan.Changes...), values...)))
		fmt.Fprintf(errOut, "dry run: nothing written (%d file(s) above).", len(plan.Changes)+len(values))
		if !noRegenerate {
			fmt.Fprintf(errOut, " A real run also rewrites %s (rendered by helm, not shown).", snapshotList(plan))
		}
		fmt.Fprintln(errOut)
		for _, n := range plan.Notes {
			fmt.Fprintf(errOut, "%s %s\n", warnTag(), n)
		}
		return nil
	}

	if err := plan.Apply(o.RepoRoot); err != nil {
		return err
	}
	fmt.Fprintf(out, "%s scaffolded %s (%s pattern, charts/%s)\n", okTag(), plan.Options.Name, plan.Options.Pattern, plan.Options.Tier)
	printChanges(out, plan.Changes)
	for _, n := range plan.Notes {
		fmt.Fprintf(out, "%s %s\n", warnTag(), n)
	}
	if noRegenerate {
		printScaffoldNextSteps(out, plan, false)
		return nil
	}

	if err := scaffold.WriteChanges(o.RepoRoot, values); err != nil {
		return err
	}
	printChanges(out, values)
	checks, res, err := scaffold.RegenerateSnapshots(cmd.Context(), o.RepoRoot, plan, runner)
	if err != nil {
		return err
	}
	if blocking := scaffold.BlockingFailures(res, plan.SnapshotCharts); len(blocking) > 0 {
		fmt.Fprintf(out, "%s rendering %s failed; the sources above are written, the snapshots are not:\n",
			failTag(), strings.Join(plan.SnapshotCharts, ", "))
		for _, c := range blocking {
			fmt.Fprintf(out, "  %s: %s\n", c.Name, c.Detail)
			for i, f := range c.Findings {
				if i == 10 {
					fmt.Fprintf(out, "    ... %d more\n", len(c.Findings)-10)
					break
				}
				fmt.Fprintf(out, "    %s\n", f)
			}
		}
		fmt.Fprintln(out, "Fix the render, then run: task test:snapshot -- --update")
		return ErrVerificationFailed
	}
	for _, c := range res.Checks {
		if c.Status == verify.StatusFail {
			fmt.Fprintf(out, "%s %s fails, independently of this scaffold (it regenerated charts/%s only): %s\n",
				warnTag(), c.Name, plan.Options.Tier, c.Detail)
		}
	}
	for _, c := range checks {
		if strings.HasPrefix(c.Detail, "written") {
			fmt.Fprintf(out, "%s snapshot %s\n", okTag(), strings.TrimPrefix(c.Name, "snapshot/"))
		}
	}
	printScaffoldNextSteps(out, plan, true)
	return nil
}

func printChanges(w io.Writer, changes []scaffold.Change) {
	for _, c := range changes {
		verb := "modified"
		if c.Created() {
			verb = "created "
		}
		fmt.Fprintf(w, "%s %s %s\n", okTag(), verb, c.Path)
	}
}

// snapshotList names the snapshot files a regenerate rewrites.
func snapshotList(plan *scaffold.Plan) string {
	return "tests/snapshots/<env>/{" + strings.Join(plan.SnapshotCharts, ",") + "}.yaml"
}

// printScaffoldNextSteps prints what the scaffolder cannot do itself.
func printScaffoldNextSteps(w io.Writer, plan *scaffold.Plan, regenerated bool) {
	o := plan.Options
	export := "configuration/templates/helm-addons.tmpl"
	if o.Tier == scaffold.TierApplications {
		export = "configuration/templates/helm-apps.tmpl"
	}
	var steps []string
	steps = append(steps, "Review the change: git status && git diff")
	steps = append(steps, fmt.Sprintf("Adapt the `values:` block of `%s:` in %s to the chart's own values, then: task config:export:localdev && task test:snapshot -- --update", o.Name, export))
	if !regenerated {
		steps = append(steps, "Regenerate what the sources feed: task config:export:localdev && task test:snapshot -- --update")
	}
	if o.CRDGroup != "" {
		steps = append(steps, fmt.Sprintf("Vendor the CRD schemas (network): task schemas:vendor -- --only %s", o.Name))
		for _, k := range o.CRDKinds {
			steps = append(steps, fmt.Sprintf("Check the health Lua fits the operator: task test:health -- --only %s_%s", o.CRDGroup, k))
		}
	}
	steps = append(steps, "Level 0: task verify:text")
	steps = append(steps, "Level 2 on Kind: task localdev:up && task verify:text LEVEL=2")
	steps = append(steps, fmt.Sprintf("Finish the checklist in docs/apps/%s.md", o.Name))
	fmt.Fprintln(w, "Next steps:")
	for i, s := range steps {
		fmt.Fprintf(w, "  %d. %s\n", i+1, s)
	}
}

func okTag() string   { return color.New(color.FgGreen).Sprint("[OK]") }
func warnTag() string { return color.New(color.FgYellow).Sprint("[WARN]") }
func failTag() string { return color.New(color.FgRed).Sprint("[ERROR]") }
