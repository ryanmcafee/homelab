package commands

import (
	"encoding/json"
	"fmt"
	"path/filepath"
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
				return fmt.Errorf("--stdout and --all are mutually exclusive")
			}
			if stdout && format == "" {
				return fmt.Errorf("--stdout requires --format")
			}

			rc, err := loadResolvedConfig()
			if err != nil {
				return err
			}

			// Handle stdout mode
			if stdout {
				root := getConfigRoot()
				var templateFile string
				switch format {
				case "helm-addons":
					templateFile = "helm-addons.tmpl"
				case "helm-apps":
					templateFile = "helm-apps.tmpl"
				case "tfvars":
					templateFile = "tfvars.tmpl"
				case "env":
					templateFile = "dotenv.tmpl"
				case "json":
					templateFile = "json.tmpl"
				default:
					return fmt.Errorf("unknown format: %s", format)
				}

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

func newConfigGuardCmd() *cobra.Command {
	var ciMode bool

	cmd := &cobra.Command{
		Use:   "guard",
		Short: "Scan staged files for PII patterns",
		RunE: func(cmd *cobra.Command, args []string) error {
			root := getConfigRoot()
			envPath := filepath.Join(root, "environments", configSet+".yaml")

			env, err := config.LoadEnvironment(envPath)
			if err != nil {
				return fmt.Errorf("loading environment for guard patterns: %w", err)
			}

			patterns := config.BuildGuardPatterns(env)
			if len(patterns) == 0 {
				logger.OK("No PII patterns to guard against")
				return nil
			}

			// Get list of files to scan
			var files []string
			if ciMode {
				// In CI mode, scan all tracked files
				// (implementation uses git ls-files)
				logger.Info("CI mode: scanning all tracked files")
			} else {
				// Scan git staged files
				logger.Info(fmt.Sprintf("Scanning staged files for %d PII patterns", len(patterns)))
			}

			if len(args) > 0 {
				files = args
			}

			found := false
			for _, f := range files {
				result := config.ScanFileForPII(f, patterns)
				if len(result.Matches) > 0 {
					found = true
					for _, m := range result.Matches {
						logger.Error(fmt.Sprintf("%s:%d PII detected (%s): %s",
							f, m.Line, m.Pattern, strings.TrimSpace(m.Content)))
					}
				}
			}

			if found {
				return fmt.Errorf("PII patterns detected in files — see errors above")
			}

			logger.OK("No PII detected in scanned files")
			return nil
		},
	}

	cmd.Flags().BoolVar(&ciMode, "ci", false, "CI mode: scan all tracked files instead of staged files")

	return cmd
}
