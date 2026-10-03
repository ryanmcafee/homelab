package commands

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/ryanmcafee/homelab/internal/config"
	"github.com/ryanmcafee/homelab/internal/prereq"
	"github.com/spf13/cobra"
)

const (
	formatText = "text"
	formatJSON = "json"
)

// printRequiredKeys writes the required-key document for every tier and
// returns. It reads configuration/schema and nothing else, so it answers with
// no ConfigSet, no Proxmox, no 1Password and no cluster -- a fork needs the list
// of values to gather BEFORE it owns the hardware the prerequisite table
// demands.
//
// The JSON form is the contract fork-ability check 2 consumes (MCAA-65); the
// text form is for the operator reading it. Both cover every tier.
func printRequiredKeys(cmd *cobra.Command, environment, format string) error {
	if format != formatText && format != formatJSON {
		return NewUsageError(fmt.Errorf("unknown --format %q (expected %s or %s)", format, formatText, formatJSON))
	}
	if environment != "" {
		return NewUsageError(fmt.Errorf(
			"--print-required-keys reports every tier in one document, so -e/--environment does not apply; drop it"))
	}

	opts := prereq.DefaultOptions()
	doc, err := prereq.BuildRequiredKeys(opts)
	if err != nil {
		return err
	}

	out := cmd.OutOrStdout()
	if format == formatJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(doc)
	}
	return writeRequiredKeysText(out, doc, filepath.Join(opts.ConfigRoot, "environments"))
}

const environmentsDisplayDir = "configuration/environments"

// writeRequiredKeysText lists the keys a fork still has to supply itself: keys
// with no schema default or computed value that the tier's ConfigSet under
// environmentsDir does not set, or still sets to its .example value. A tier
// whose committed ConfigSet sets them all gets one line saying so, because
// listing them would send a localdev forker hunting for Proxmox and BGP
// addresses the Kind tier never uses.
//
// Tiers still missing the same keys are printed once under both names, so one
// answer does not read as two independent ones that happen to agree.
func writeRequiredKeysText(w io.Writer, doc *prereq.RequiredKeysDoc, environmentsDir string) error {
	fmt.Fprintf(w, "Configuration keys the bootstrap requires (document v%d).\n", doc.Version)
	fmt.Fprintf(w, "Each tier resolves them from %s/<tier>.yaml.\n", environmentsDisplayDir)

	var pending []pendingTier
	for _, tier := range doc.Tiers {
		p, err := unsetOperatorKeys(tier, environmentsDir)
		if err != nil {
			return err
		}
		if len(p.unset) == 0 {
			fmt.Fprintf(w, "\n%s: all %d keys without a default are set by %s; nothing to fill in.\n",
				p.name, len(tier.OperatorSuppliedKeys()), p.displayFile())
			continue
		}
		pending = append(pending, p)
	}

	for _, group := range groupPendingTiers(pending) {
		first := group[0]
		names := make([]string, 0, len(group))
		for _, p := range group {
			names = append(names, p.name)
		}
		fmt.Fprintf(w, "\n%s: %d of %d required keys have no default and still need a value; the rest are defaulted or computed.\n",
			strings.Join(names, ", "), len(first.unset), first.total)
		for _, p := range group {
			switch {
			case p.fileExists:
				fmt.Fprintf(w, "  Set them in %s.\n", p.displayFile())
			case !p.exampleExists:
				fmt.Fprintf(w, "  Create %s.\n", p.displayFile())
			default:
				fmt.Fprintf(w, "  Create %s: cp %s.example %s\n", p.displayFile(), p.displayFile(), p.displayFile())
			}
		}

		width := 0
		for _, key := range first.unset {
			width = max(width, len(key.Name))
		}
		for _, key := range first.unset {
			marker := ""
			if first.sample[key.Name] {
				marker = " (still the example value)"
			}
			fmt.Fprintf(w, "  %-*s  %s%s\n", width, key.Name, key.Description, marker)
		}
	}
	return nil
}

// pendingTier is a tier whose ConfigSet does not yet set every operator-supplied key.
type pendingTier struct {
	name          string
	total         int
	unset         []prereq.RequiredKey
	sample        map[string]bool
	fileExists    bool
	exampleExists bool
}

func (p pendingTier) displayFile() string {
	return environmentsDisplayDir + "/" + p.name + ".yaml"
}

func unsetOperatorKeys(tier prereq.RequiredKeysTier, environmentsDir string) (pendingTier, error) {
	path := filepath.Join(environmentsDir, string(tier.Tier)+".yaml")
	p := pendingTier{name: string(tier.Tier), total: len(tier.Keys), fileExists: true}
	values, err := config.LoadEnvironment(path)
	if errors.Is(err, fs.ErrNotExist) {
		p.fileExists = false
		_, statErr := os.Stat(path + ".example")
		p.exampleExists = statErr == nil
	} else if err != nil {
		return p, err
	}
	samples, err := exampleValues(path, p.fileExists)
	if err != nil {
		return p, err
	}
	p.sample = map[string]bool{}
	for _, key := range tier.OperatorSuppliedKeys() {
		value, ok := values[key.Name]
		switch {
		case !ok || value == "" || value == "<nil>":
			p.unset = append(p.unset, key)
		case samples[key.Name] == value:
			p.unset = append(p.unset, key)
			p.sample[key.Name] = true
		}
	}
	return p, nil
}

// exampleValues reads the tier's .example beside an existing ConfigSet, so a
// value still copied from it counts as unset.
func exampleValues(path string, fileExists bool) (map[string]string, error) {
	if !fileExists {
		return nil, nil
	}
	values, err := config.LoadEnvironment(path + ".example")
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return values, err
}

func groupPendingTiers(pending []pendingTier) [][]pendingTier {
	var groups [][]pendingTier
	index := map[string]int{}
	for _, p := range pending {
		fingerprint := pendingFingerprint(p)
		if at, ok := index[fingerprint]; ok {
			groups[at] = append(groups[at], p)
			continue
		}
		index[fingerprint] = len(groups)
		groups = append(groups, []pendingTier{p})
	}
	return groups
}

// pendingFingerprint covers every field the group's block prints, so two tiers
// are merged only when the printed block would be identical.
func pendingFingerprint(p pendingTier) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d\x00", p.total)
	for _, key := range p.unset {
		fmt.Fprintf(&b, "%s\x00%s\x00%t\x00", key.Name, key.Description, p.sample[key.Name])
	}
	return b.String()
}
