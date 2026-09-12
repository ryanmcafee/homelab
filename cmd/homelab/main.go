package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

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
		Use:     "homelab",
		Short:   "Homelab infrastructure automation CLI",
		Long:    `Cross-platform CLI tool for managing homelab infrastructure, replacing legacy shell and TypeScript scripts.`,
		Version: version,
		// main is the single error printer for the whole tree. Without this,
		// cobra prints the error and main prints it again, so every failing
		// command reported itself twice. Usage is likewise printed exactly
		// once, by UsageErrorFunc, for the invocations that warrant it.
		SilenceErrors: true,
		SilenceUsage:  true,
	}

	// Cobra reports an unknown or malformed flag as an ordinary error, which
	// would exit 1 and read as a repository problem. UsageErrorFunc prints
	// usage and marks the error so it exits 2 instead. Inherited by every
	// subcommand that does not override it.
	rootCmd.SetFlagErrorFunc(commands.UsageErrorFunc)

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

	// A cancelled context stops the verification worker pools from dispatching
	// further work, so Ctrl-C returns promptly instead of draining every
	// queued helm invocation first.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// ExitCode keeps the historical exit 1 for ordinary failures and reserves
	// exit 2 for usage errors, which lets autonomous callers tell "the repo is
	// broken" apart from "I called the command wrongly".
	if err := rootCmd.ExecuteContext(ctx); err != nil {
		// A verification failure already printed its findings, as text or as
		// the JSON result contract. Every other error would otherwise vanish,
		// because the verification commands silence cobra's own error output.
		if !errors.Is(err, commands.ErrVerificationFailed) {
			fmt.Fprintln(os.Stderr, "Error:", err)
		}
		os.Exit(commands.ExitCode(err))
	}
}
