package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/prereq"
	"github.com/spf13/cobra"
)

// runBootstrapCapturingStdout runs bootstrap with the process's real stdout
// replaced by a pipe, and points cobra's writer at the same stream.
//
// internal/logger writes to os.Stdout with fmt.Printf, not to cobra's writer, so
// a test that only captured cmd.OutOrStdout() would not see a log line at all --
// and a log line on stdout is exactly what breaks the JSON consumer.
func runBootstrapCapturingStdout(t *testing.T, args ...string) (error, string) {
	t.Helper()

	read, write, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	realStdout := os.Stdout
	os.Stdout = write
	t.Cleanup(func() { os.Stdout = realStdout })

	root := &cobra.Command{Use: "homelab", SilenceUsage: true, SilenceErrors: true}
	root.SetFlagErrorFunc(UsageErrorFunc)
	root.PersistentFlags().BoolVar(&DryRun, "dry-run", false, "")
	root.PersistentFlags().BoolVarP(&AutoAccept, "yes", "y", false, "")
	root.AddCommand(NewBootstrapCmd())
	root.SetOut(write)
	root.SetErr(write)
	root.SetArgs(args)
	t.Cleanup(func() { DryRun = false; AutoAccept = false })

	runErr := root.ExecuteContext(context.Background())

	if err := write.Close(); err != nil {
		t.Fatalf("closing pipe: %v", err)
	}
	captured, err := io.ReadAll(read)
	if err != nil {
		t.Fatalf("reading captured stdout: %v", err)
	}
	return runErr, string(captured)
}

// The consumer (internal/verify fork-ability check 2) decodes stdout as one JSON
// document with no filtering. Because logger writes to stdout, that guarantee
// rests entirely on --print-required-keys returning before anything logs; this
// test fails if a log line is ever added above that return.
func TestPrintRequiredKeysWritesNothingButTheDocument(t *testing.T) {
	err, out := runBootstrapCapturingStdout(t, "bootstrap", "--print-required-keys", "--format", "json")
	if err != nil {
		t.Fatalf("--print-required-keys failed: %v\n%s", err, out)
	}

	dec := json.NewDecoder(strings.NewReader(out))
	dec.DisallowUnknownFields()
	var doc prereq.RequiredKeysDoc
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("stdout is not the document alone: %v\ngot:\n%s", err, out)
	}
	// A second value means something else printed after the document.
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		t.Fatalf("stdout carries more than the document (want EOF, got %v)\ngot:\n%s", err, out)
	}

	if doc.Version != prereq.RequiredKeysVersion {
		t.Errorf("document version = %d, want %d", doc.Version, prereq.RequiredKeysVersion)
	}
	if len(doc.Tiers) != len(prereq.AllTiers()) {
		t.Errorf("document has %d tier(s), want %d", len(doc.Tiers), len(prereq.AllTiers()))
	}
}

// The document is checked into a gate that refuses an unsorted or duplicated
// list, so an unstable order is a CI failure that flaps rather than a diff.
func TestPrintRequiredKeysIsSortedAndClassified(t *testing.T) {
	err, out := runBootstrapCapturingStdout(t, "bootstrap", "--print-required-keys", "--format", "json")
	if err != nil {
		t.Fatalf("--print-required-keys failed: %v\n%s", err, out)
	}
	var doc prereq.RequiredKeysDoc
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("decoding document: %v", err)
	}

	for _, tier := range doc.Tiers {
		if len(tier.Keys) == 0 {
			t.Fatalf("tier %q declares no keys", tier.Tier)
		}
		for i, key := range tier.Keys {
			if key.Name == "" {
				t.Fatalf("tier %q: key at index %d has no name", tier.Tier, i)
			}
			if key.Description == "" {
				t.Errorf("tier %q: key %q has no description; the gate prints it to explain what a fork must supply", tier.Tier, key.Name)
			}
			switch key.Source {
			case prereq.KeySourceSchema, prereq.KeySourceBootstrap:
			default:
				t.Errorf("tier %q: key %q has unknown source %q", tier.Tier, key.Name, key.Source)
			}
			switch key.Example {
			case prereq.ExampleRequired, prereq.ExampleOptional, prereq.ExampleForbidden:
			default:
				t.Errorf("tier %q: key %q has unknown example placement %q", tier.Tier, key.Name, key.Example)
			}
			if i > 0 && tier.Keys[i-1].Name >= key.Name {
				t.Fatalf("tier %q: keys are not sorted by name (%q before %q)", tier.Tier, tier.Keys[i-1].Name, key.Name)
			}
		}
	}
}

// Running it must be safe on a machine with no ConfigSet, no Proxmox and no
// 1Password -- that is the whole point of the flag. The tier is never resolved,
// so the prompt is never reached either.
func TestPrintRequiredKeysRunsWithoutPrerequisites(t *testing.T) {
	swapPrereqEnv(t, stubEnv{missing: map[string]bool{
		"mise": true, "task": true, "docker": true, "op": true, "terragrunt": true, "talosctl": true,
	}})

	err, out := runBootstrapCapturingStdout(t, "bootstrap", "--print-required-keys")
	if err != nil {
		t.Fatalf("--print-required-keys failed with no tools present: %v\n%s", err, out)
	}
	if !strings.Contains(out, "must be set") {
		t.Errorf("text output does not list the keys a fork supplies:\n%s", out)
	}
	for _, tier := range prereq.AllTiers() {
		if !strings.Contains(out, string(tier)) {
			t.Errorf("text output does not mention tier %q:\n%s", tier, out)
		}
	}
}

func TestPrintRequiredKeysRejectsBadInvocations(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "unknown format",
			args: []string{"bootstrap", "--print-required-keys", "--format", "yaml"},
			want: `unknown --format "yaml"`,
		},
		{
			// The document covers every tier by contract; honouring -e would
			// hand the gate a partial document that parses fine.
			name: "tier flag does not apply",
			args: []string{"bootstrap", "--print-required-keys", "-e", "homelab"},
			want: "does not apply",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err, out := runBootstrapCapturingStdout(t, tc.args...)
			if err == nil {
				t.Fatalf("expected a usage error, got success:\n%s", out)
			}
			var usage *UsageError
			if !errors.As(err, &usage) {
				t.Errorf("error is not a UsageError (exit code would not be %d): %v", ExitUsage, err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err.Error(), tc.want)
			}
		})
	}
}

// Tiers that require the same keys are printed once under both names. Today
// every tier does, because configuration/schema is not tier-scoped; printing
// the list per tier would read as independent answers that happen to agree.
func TestTextOutputMergesTiersWithTheSameKeySet(t *testing.T) {
	doc := &prereq.RequiredKeysDoc{
		Version: prereq.RequiredKeysVersion,
		Tiers: []prereq.RequiredKeysTier{
			{Tier: prereq.Localdev, Keys: []prereq.RequiredKey{{
				Name: "DOMAIN", Required: true, Source: prereq.KeySourceSchema,
				Description: "Base domain", Example: prereq.ExampleRequired,
			}}},
			{Tier: prereq.Homelab, Keys: []prereq.RequiredKey{{
				Name: "DOMAIN", Required: true, Source: prereq.KeySourceSchema,
				Description: "Base domain", Example: prereq.ExampleRequired,
			}}},
		},
	}

	var merged bytes.Buffer
	writeRequiredKeysText(&merged, doc)
	if want := "localdev, homelab:"; !strings.Contains(merged.String(), want) {
		t.Errorf("identical tiers were not merged into one block (want %q):\n%s", want, merged.String())
	}
	if got := strings.Count(merged.String(), "DOMAIN"); got != 1 {
		t.Errorf("DOMAIN listed %d times, want 1", got)
	}

	// One differing description is a different answer and must print twice.
	doc.Tiers[1].Keys[0].Description = "Base domain, production"
	var split bytes.Buffer
	writeRequiredKeysText(&split, doc)
	if strings.Contains(split.String(), "localdev, homelab:") {
		t.Errorf("tiers with different key sets were merged:\n%s", split.String())
	}
	if got := strings.Count(split.String(), "DOMAIN"); got != 2 {
		t.Errorf("DOMAIN listed %d times, want 2", got)
	}
}

// A multi-line row error is the missing-key list. Unindented it reads as a set
// of findings of its own, so a fork counts three missing keys as six problems.
func TestPrereqTableIndentsAMultiLineError(t *testing.T) {
	var out bytes.Buffer
	printPrereqTable(&out, []prereq.Result{{
		Check: prereq.Check{Name: "homelab.yaml", Hint: "fill it in"},
		Err: errors.New("validation errors:\n  required key \"CP_VIP\" is missing or empty" +
			"\n  required key \"DOMAIN\" is missing or empty"),
	}})

	for _, line := range strings.Split(strings.TrimRight(out.String(), "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if !strings.HasPrefix(line, "  ") {
			t.Errorf("line is not part of the row: %q", line)
		}
		if strings.Contains(line, "required key") && !strings.Contains(line, "      ") {
			t.Errorf("missing-key line is not indented under the message column: %q", line)
		}
	}
	for _, key := range []string{"CP_VIP", "DOMAIN"} {
		if got := strings.Count(out.String(), key); got != 1 {
			t.Errorf("%s appears %d times, want 1", key, got)
		}
	}
}
