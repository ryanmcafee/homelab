package commands

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/ryanmcafee/homelab/internal/verify"
	"github.com/spf13/cobra"
)

func newVerifySnapshotCmd() *cobra.Command {
	var (
		o           renderPassOptions
		update      bool
		snapshotDir string
	)

	cmd := &cobra.Command{
		Use:   "snapshot",
		Short: "Diff rendered charts against golden snapshots (level 0)",
		Long: `Render every chart for every environment and compare the output byte-for-byte
against the golden snapshots in tests/snapshots/<env>/<chart>.yaml.

Snapshots are the exact rendered bytes with no normalisation, so any change in
Helm output shows up as a diff. Refresh them deliberately with --update and
review the resulting git diff.

Exit status: 0 when every snapshot matches, 1 on drift or a missing snapshot,
2 on a usage error.`,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				usageErrorf("unexpected argument %q", args[0])
			}

			root, err := findProjectRoot()
			if err != nil {
				return err
			}
			dir := snapshotDir
			if dir == "" {
				dir = filepath.Join(root, "tests", "snapshots")
			} else if !filepath.IsAbs(dir) {
				dir = filepath.Join(root, dir)
			}

			outDir, cleanup, err := o.resolveOutDir()
			if err != nil {
				return err
			}
			defer cleanup()

			// Snapshots only compare rendered bytes, so lint and schema checks
			// are not part of this command's contract.
			o.skipLint = true
			o.skipSchema = true

			start := time.Now()
			out, renderRes, err := o.renderPass(cmd, outDir)
			if err != nil {
				return err
			}

			res := verify.NewResult(0)
			res.Merge(renderRes)

			checks, err := verify.Snapshot(out.Files, dir, update)
			if err != nil {
				return fmt.Errorf("comparing snapshots: %w", err)
			}
			res.Add(checks...)
			res.Finalize(start)

			return emitResult(res, o.asJSON)
		},
	}

	bindRenderFlags(cmd, &o)
	cmd.Flags().BoolVar(&update, "update", false, "Rewrite the snapshots from the current render instead of comparing")
	cmd.Flags().StringVar(&snapshotDir, "snapshot-dir", "", "Snapshot directory (default: tests/snapshots)")

	return cmd
}
