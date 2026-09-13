package commands

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ryanmcafee/homelab/internal/config"
	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/spf13/cobra"
)

var (
	configRoot string // --config-root flag
	configSet  string // --set flag
	envFile    string // --env-file flag
)

func defaultConfigRoot() string {
	root, err := findProjectRoot()
	if err != nil {
		return "configuration"
	}
	return filepath.Join(root, "configuration")
}

// NewConfigCmd returns the `homelab config` command group.
func NewConfigCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Configuration management — validate, eval, export, guard",
		Long:  `Schema-driven configuration pipeline. Centralizes all environment-specific values (IPs, domains, secrets references) and exports consumer-specific files.`,
		// A group is not runnable. Without these, `homelab config` and
		// `homelab config gaurd` both printed help and exited 0.
		Args:          GroupCommandArgs,
		RunE:          RunGroupCommand,
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	cmd.PersistentFlags().StringVar(&configRoot, "config-root", "", "Path to configuration/ directory (default: auto-detect)")
	cmd.PersistentFlags().StringVar(&configSet, "set", "homelab", "Environment name (homelab, localdev)")
	cmd.PersistentFlags().StringVar(&envFile, "env-file", "", "Override environment file path (default: auto-detect from config-root)")

	cmd.AddCommand(newConfigValidateCmd())
	cmd.AddCommand(newConfigEvalCmd())
	cmd.AddCommand(newConfigExportCmd())
	cmd.AddCommand(newConfigGuardCmd())

	return cmd
}

func getConfigRoot() string {
	if configRoot != "" {
		return configRoot
	}
	return defaultConfigRoot()
}

func loadResolvedConfig() (*config.ResolvedConfig, error) {
	root := getConfigRoot()

	schema, err := config.LoadSchemaDir(filepath.Join(root, "schema"))
	if err != nil {
		return nil, fmt.Errorf("loading schemas: %w", err)
	}

	versions, err := config.LoadVersions(filepath.Join(root, "versions.yaml"))
	if err != nil {
		return nil, fmt.Errorf("loading versions: %w", err)
	}

	defaults, err := config.LoadEnvironment(filepath.Join(root, "environments", "defaults.yaml"))
	if err != nil {
		return nil, fmt.Errorf("loading defaults: %w", err)
	}

	// Use --env-file if provided, otherwise auto-detect
	var envPath string
	if envFile != "" {
		envPath = envFile
	} else {
		envPath = filepath.Join(root, "environments", configSet+".yaml")
	}
	env, err := config.LoadEnvironment(envPath)
	if err != nil {
		return nil, fmt.Errorf("loading environment %s: %w", configSet, err)
	}

	return config.Eval(schema, versions, configSet, defaults, env)
}

func newConfigValidateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "validate",
		Short: "Validate schemas and environment values",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, err := loadResolvedConfig()
			if err != nil {
				logger.Error(fmt.Sprintf("Validation failed: %v", err))
				return err
			}
			logger.OK(fmt.Sprintf("Configuration valid for set %q", configSet))
			return nil
		},
	}
}

func newConfigEvalCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "eval",
		Short: "Resolve all config and print as JSON",
		RunE: func(cmd *cobra.Command, args []string) error {
			rc, err := loadResolvedConfig()
			if err != nil {
				return err
			}

			// Build simple key-value map for JSON output
			out := make(map[string]string, len(rc.Values))
			for k, v := range rc.Values {
				out[k] = v.Value
			}

			data, err := json.MarshalIndent(out, "", "  ")
			if err != nil {
				return err
			}
			fmt.Println(string(data))
			return nil
		},
	}
}

// exportTemplates maps an export format to its template file. It is the single
// list of valid --format values, so the flag help, the usage error and the
// stdout path cannot drift apart.
var exportTemplates = map[string]string{
	"helm-addons": "helm-addons.tmpl",
	"helm-apps":   "helm-apps.tmpl",
	"tfvars":      "tfvars.tmpl",
	"env":         "dotenv.tmpl",
	"json":        "json.tmpl",
}

// exportFormatList is the sorted format list for messages.
func exportFormatList() string {
	names := make([]string, 0, len(exportTemplates))
	for name := range exportTemplates {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

func newConfigExportCmd() *cobra.Command {
	var format string
	var all bool
	var stdout bool

	cmd := &cobra.Command{
		Use:   "export",
		Short: "Export config to consumer-specific format",
		RunE: func(cmd *cobra.Command, args []string) error {
			// Validate stdout flag usage
			if stdout && all {
				return usageErrorf("--stdout and --all are mutually exclusive")
			}
			if stdout && format == "" {
				return usageErrorf("--stdout requires --format")
			}
			// With neither flag no target matches below, so the command
			// exported nothing and still exited 0.
			if !stdout && !all && format == "" {
				return usageErrorf("export requires --format or --all")
			}
			// An unknown format is a misuse, so it is rejected before any
			// config is resolved: the caller gets the same exit 2 whether or
			// not the environment file happens to be present.
			templateFile, known := exportTemplates[format]
			if format != "" && !known {
				return usageErrorf("unknown format %q (want one of %s)", format, exportFormatList())
			}

			rc, err := loadResolvedConfig()
			if err != nil {
				return err
			}

			// Handle stdout mode
			if stdout {
				root := getConfigRoot()
				tmplPath := filepath.Join(root, "templates", templateFile)
				output, err := config.Export(rc, tmplPath)
				if err != nil {
					return err
				}
				fmt.Print(output)
				return nil
			}

			root := getConfigRoot()
			projectRoot, err := findProjectRoot()
			if err != nil {
				return fmt.Errorf("finding project root: %w", err)
			}

			type exportTarget struct {
				format   string
				template string
				output   string
			}

			targets := []exportTarget{
				{"helm-addons", "helm-addons.tmpl", "charts/addons/values-homelab.generated.yaml"},
				{"helm-apps", "helm-apps.tmpl", "charts/applications/values-homelab.generated.yaml"},
				{"tfvars", "tfvars.tmpl", "terragrunt/environments/homelab/env.generated.tfvars"},
				{"env", "dotenv.tmpl", ".env.generated"},
				{"json", "json.tmpl", "configuration/resolved.json"},
			}

			for _, t := range targets {
				if !all && t.format != format {
					continue
				}

				tmplPath := filepath.Join(root, "templates", t.template)
				outPath := filepath.Join(projectRoot, t.output)

				if DryRun {
					logger.Info(fmt.Sprintf("[dry-run] Would export %s -> %s", t.format, outPath))
					continue
				}

				if err := config.ExportToFile(rc, tmplPath, outPath); err != nil {
					logger.Error(fmt.Sprintf("Export %s failed: %v", t.format, err))
					continue
				}
				logger.OK(fmt.Sprintf("Exported %s -> %s", t.format, outPath))
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&format, "format", "", "Export format (helm-addons, helm-apps, tfvars, env, json)")
	cmd.Flags().BoolVar(&all, "all", false, "Export all formats")
	cmd.Flags().BoolVar(&stdout, "stdout", false, "Write output to stdout instead of file (requires --format)")

	return cmd
}

// splitCommaList flattens repeated flag values that may themselves be
// comma-separated into a single list, dropping blanks. It returns nil for an
// empty result so callers can fall back to a default.
func splitCommaList(values []string) []string {
	var out []string
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}

// effectivePathspecs reports the pathspecs a scan will actually use, for
// messages that have to name the scope.
func effectivePathspecs(values []string) []string {
	if specs := splitCommaList(values); len(specs) > 0 {
		return specs
	}
	return config.DefaultGuardPathspecs
}

// guardEnvPath resolves the environment file supplying value-based guard
// patterns, honouring the global --env-file override.
func guardEnvPath() string {
	if envFile != "" {
		return envFile
	}
	return filepath.Join(getConfigRoot(), "environments", configSet+".yaml")
}

func newConfigGuardCmd() *cobra.Command {
	var (
		ciMode bool
		paths  []string
	)

	cmd := &cobra.Command{
		Use:   "guard [files...]",
		Short: "Scan files for PII patterns",
		Long: `Scan files for values that would leak real infrastructure identity.

Two detectors run together. Value-based detection compares each line against
the literal values in the environment file, so it catches a real domain or IP
wherever it appears. Shape-based detection needs no environment file, so a
clone without the real values still gets protection: it flags a PII-shaped
configuration key (DOMAIN, *_IP, *_HOSTNAME, ...) and a Helm values key
(domain, host, hostname, portal, staticIP, email, ..., plus list items under
dnsZones, allowedDomains, hosts, ...) whose value is a routable host address or
a real hostname, domain or mailbox.

Files come from the arguments (the pre-commit path) or, with --ci, from the
tracked files under configuration/ and every charts/*/values-homelab.yaml.
Widen the tracked scope with --paths.
An empty scan scope in CI mode is a failure, never a pass.`,
		// A guard failure is a finding, not a misuse: usage noise would bury
		// the PII report in CI logs.
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			root, err := findProjectRoot()
			if err != nil {
				return err
			}

			envPath := guardEnvPath()
			report, err := config.RunGuard(config.GuardOptions{
				RepoRoot:  root,
				Files:     args,
				Pathspecs: splitCommaList(paths),
				CI:        ciMode,
				EnvPath:   envPath,
			})
			if errors.Is(err, config.ErrGuardNoFiles) {
				logger.Warn(fmt.Sprintf("scan scope matched 0 files (pathspecs: %s)",
					strings.Join(effectivePathspecs(paths), " ")))
				return usageErrorf("guard scanned 0 files — refusing to report success; check --paths")
			}
			if err != nil {
				return fmt.Errorf("running PII guard: %w", err)
			}

			if report.EnvMissing {
				logger.Warn(fmt.Sprintf("%s not found; value-based PII detection disabled, pattern-based detection (IPs, key names) still active", envPath))
			}

			mode := "staged files"
			if ciMode {
				mode = "tracked files"
			}
			logger.Info(fmt.Sprintf("Scanning %d %s against %d value pattern(s) + shape rules",
				len(report.Files), mode, report.ValuePatterns))

			for _, result := range report.Results {
				for _, m := range result.Matches {
					// A template-file finding reads differently: the value may
					// not be PII, it is simply not a documented placeholder.
					if m.Note != "" {
						logger.Error(fmt.Sprintf("%s:%d %s", result.File, m.Line, m.Note))
						continue
					}
					logger.Error(fmt.Sprintf("%s:%d PII detected (%s): %s",
						result.File, m.Line, m.Pattern, strings.TrimSpace(m.Content)))
				}
			}
			// A file the guard could not read has not been cleared, so it
			// fails the scan instead of counting as clean.
			for _, u := range report.Unreadable {
				logger.Error(fmt.Sprintf("%s: %v", u.File, u.Err))
			}

			n := report.MatchCount()
			switch {
			case n > 0 && len(report.Unreadable) > 0:
				return fmt.Errorf("%d PII pattern(s) detected in %d file(s), and %d file(s) unreadable — see errors above",
					n, len(report.Results), len(report.Unreadable))
			case n > 0:
				return fmt.Errorf("%d PII pattern(s) detected in %d file(s) — see errors above",
					n, len(report.Results))
			case len(report.Unreadable) > 0:
				return fmt.Errorf("%d file(s) could not be read — see errors above", len(report.Unreadable))
			}

			if len(report.Files) == 0 {
				logger.Warn("No files to scan — nothing was checked")
				return nil
			}
			logger.OK(fmt.Sprintf("No PII detected in %d file(s)", len(report.Files)))
			return nil
		},
	}

	cmd.Flags().BoolVar(&ciMode, "ci", false, "CI mode: derive the file list from tracked files instead of arguments")
	cmd.Flags().StringArrayVar(&paths, "paths", nil, "Git pathspecs defining the CI scan scope (repeatable or comma-separated; default: configuration/** charts/**/values-homelab.yaml)")

	return cmd
}
