package commands

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/ryanmcafee/homelab/internal/verify"
	"github.com/spf13/cobra"
)

// orphanMode decides what an orphan snapshot pass is allowed to do.
//
// Deleting requires both --update and a render in which every chart succeeded.
// A chart that failed to render produces no output, so on a failed pass an
// orphan is indistinguishable from a chart that is merely broken, and deleting
// its snapshot would destroy the very baseline needed to diagnose the failure.
func orphanMode(update, renderPassed bool) verify.OrphanMode {
	switch {
	case update && renderPassed:
		return verify.OrphanPrune
	case update:
		return verify.OrphanKeep
	default:
		return verify.OrphanReport
	}
}

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

A snapshot whose chart no longer renders is reported as an orphan, and --update
deletes it. Orphan detection needs the full render, so it is skipped when
--chart or --env narrows the pass.

Exit status: 0 when every snapshot matches, 1 on drift, a missing snapshot or an
orphan, 2 on a usage error.`,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := o.validate(args); err != nil {
				return err
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

			// Snapshots compare rendered bytes only, so lint and schema checks
			// are not part of this command's contract and must not appear in
			// its result as skips either.
			o.skipLint = true
			o.skipSchema = true
			o.omitSchema = true

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

			// A filtered render makes every chart it did not cover look
			// orphaned, so only a full pass may report orphans.
			if !o.filtered() {
				// The expected set comes from chart discovery, not from the
				// rendered files, so a chart that failed to render is never
				// mistaken for a deleted one. Pruning additionally requires
				// every render check to have passed: an incomplete pass
				// reports orphans without deleting anything.
				expected := map[string][]string{}
				for env := range out.Files {
					for _, c := range out.Charts {
						expected[env] = append(expected[env], c.Name)
					}
				}

				orphans, oerr := verify.OrphanSnapshots(expected, dir, orphanMode(update, renderRes.Pass))
				if oerr != nil {
					return fmt.Errorf("checking for orphan snapshots: %w", oerr)
				}
				res.Add(orphans...)
			}

			res.Finalize(start)
			return emitResult(cmd, res, o.asJSON)
		},
	}

	bindRenderFlags(cmd, &o)
	cmd.Flags().BoolVar(&update, "update", false, "Rewrite the snapshots from the current render and delete orphans")
	cmd.Flags().StringVar(&snapshotDir, "snapshot-dir", "", "Snapshot directory (default: tests/snapshots)")

	return cmd
}
