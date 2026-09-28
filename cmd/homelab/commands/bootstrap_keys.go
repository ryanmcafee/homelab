package commands

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

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

	doc, err := prereq.BuildRequiredKeys(prereq.DefaultOptions())
	if err != nil {
		return err
	}

	out := cmd.OutOrStdout()
	if format == formatJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(doc)
	}
	writeRequiredKeysText(out, doc)
	return nil
}

// writeRequiredKeysText lists the keys a fork has to supply itself. Keys with a
// schema default or a computed value are counted, not listed: the operator's
// question is "what do I have to fill in", and listing 80 defaulted keys buries
// the 26 that answer it.
//
// Tiers sharing a key set are printed once under both names. Today that is
// every tier -- configuration/schema is not tier-scoped, so localdev requires
// PROXMOX_IP too and its committed ConfigSet supplies one. Printing the same 26
// keys per tier would read as two independent answers that happen to agree.
func writeRequiredKeysText(w io.Writer, doc *prereq.RequiredKeysDoc) {
	fmt.Fprintf(w, "Configuration keys the bootstrap requires (document v%d).\n", doc.Version)
	fmt.Fprintln(w, "Each tier resolves them from configuration/environments/<tier>.yaml.")

	for _, group := range groupTiersByKeySet(doc) {
		supplied := group.tier.OperatorSuppliedKeys()
		fmt.Fprintf(w, "\n%s: %d of %d required keys have no default and must be set; the rest are defaulted or computed.\n",
			strings.Join(group.names, ", "), len(supplied), len(group.tier.Keys))

		width := 0
		for _, key := range supplied {
			if len(key.Name) > width {
				width = len(key.Name)
			}
		}
		for _, key := range supplied {
			fmt.Fprintf(w, "  %-*s  %s\n", width, key.Name, key.Description)
		}
	}
}

// tierGroup is one key set and the tiers that share it, in document order.
type tierGroup struct {
	names []string
	tier  prereq.RequiredKeysTier
}

func groupTiersByKeySet(doc *prereq.RequiredKeysDoc) []tierGroup {
	var groups []tierGroup
	index := map[string]int{}
	for _, tier := range doc.Tiers {
		fingerprint := keySetFingerprint(tier)
		if at, ok := index[fingerprint]; ok {
			groups[at].names = append(groups[at].names, string(tier.Tier))
			continue
		}
		index[fingerprint] = len(groups)
		groups = append(groups, tierGroup{names: []string{string(tier.Tier)}, tier: tier})
	}
	return groups
}

// keySetFingerprint identifies a tier's key set by every field the text output
// shows, so two tiers are merged only when the printed block would be identical.
func keySetFingerprint(tier prereq.RequiredKeysTier) string {
	var b strings.Builder
	for _, key := range tier.Keys {
		fmt.Fprintf(&b, "%s\x00%t\x00%s\x00%s\x00%s\x00", key.Name, key.Required, key.Source, key.Example, key.Description)
	}
	return b.String()
}
