package main

import (
	"os"

	"github.com/ryanmcafee/homelab/cmd/homelab/commands"
	"github.com/spf13/cobra"
)

var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	rootCmd := &cobra.Command{
		Use:   "homelab",
		Short: "Homelab infrastructure automation CLI",
		Long:  `Cross-platform CLI tool for managing homelab infrastructure, replacing legacy shell and TypeScript scripts.`,
		Version: version,
	}

	// Add global flags
	rootCmd.PersistentFlags().BoolVar(&commands.DryRun, "dry-run", false, "Show what would be done without executing")
	rootCmd.PersistentFlags().BoolVarP(&commands.AutoAccept, "yes", "y", false, "Auto-accept all prompts")

	// Add subcommands
	rootCmd.AddCommand(commands.NewBootstrapCmd())
	rootCmd.AddCommand(commands.NewValidateCmd())
	rootCmd.AddCommand(commands.NewSopsCmd())
	rootCmd.AddCommand(commands.NewTalosCmd())
	rootCmd.AddCommand(commands.NewVerifyCmd())
	rootCmd.AddCommand(commands.NewRenderCmd())
	rootCmd.AddCommand(commands.NewConfigCmd())

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
