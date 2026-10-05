package config

import (
	"bufio"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// ---------------------------------------------------------------------------
// Example ConfigSet distinctness
// ---------------------------------------------------------------------------
//
// docs/contracts/fork-ability.md, check 1, renders every chart against a
// synthetic ConfigSet and then greps the rendered output for any value from the
// real environment. That grep can only tell a leak from a placeholder if the
// two committed ConfigSets do not share an address range — otherwise
// `192.0.2.11` in the render is equally well the synthetic value and a value
// that escaped.
//
// That condition used to hold by construction: examplePlaceholderSubnets was a
// closed allowlist of {192.168.1.0/24, 127.0.0.0/8}, so RFC 5737 anywhere in a
// template file was a finding. Once a second range became legal in *every*
// template file, homelab.yaml.example could drift into 192.0.2.x and nothing
// would say so — the condition survived only as prose, which is the exact
// failure mode ADR-035 wrote that section about.
//
// So it is asserted here instead. The rule is disjointness, not a per-file
// registry: a third example ConfigSet does not need an entry anywhere, it just
// has to declare a range the other two do not already use.
//
// Disjointness is judged at the level of the reserved *range*, not the exact
// address, because that is the level the confusion lives at. Two ConfigSets
// holding 198.51.100.11 and 198.51.100.12 do not intersect as single-host
// prefixes, yet they leave the same unanswerable question in a render: which
// file did this come from? Each ConfigSet therefore claims a whole reserved
// range, and a range belongs to one file.

// exampleConfigSetGlob matches the template ConfigSets under
// configuration/environments/. Only *.yaml.example is a committed ConfigSet a
// fork reads; defaults.yaml and localdev.yaml are real environments.
const exampleConfigSetGlob = "*.yaml.example"

// ipv4Token matches a dotted quad with an optional prefix length. The values
// are extracted from a line rather than parsed whole because one value can
// carry several ranges: NETWORK_NAMES is a `name=CIDR,name=CIDR` list.
//
// IPv4 only, deliberately: every address the ConfigSet surface declares today
// is IPv4, and a half-working IPv6 token regex would report a pass it had not
// earned. Widen this the day a ConfigSet key holds an IPv6 value.
var ipv4Token = regexp.MustCompile(`(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:/[0-9]{1,2})?`)

// ExampleRange is one address range a template ConfigSet declares.
type ExampleRange struct {
	File   string // base name, e.g. homelab.yaml.example
	Line   int
	Key    string
	Raw    string
	Prefix netip.Prefix
}

func (r ExampleRange) String() string {
	return fmt.Sprintf("%s:%d %s=%s (%s)", r.File, r.Line, r.Key, r.Raw, r.Prefix)
}

// ExampleConfigSetRanges returns every address range a template ConfigSet
// declares, in file order.
//
// Only `KEY: value` assignments are read, and the value is taken after
// stripValue drops its trailing comment and quotes. A range named in a comment
// is prose about someone else's network, not a value this file declares, and
// counting it would make an explanatory line collide with a real assignment.
//
// Addresses that cannot identify a host — loopback, unspecified, link-local,
// multicast — are skipped. Those are shared on purpose: two ConfigSets may both
// say 127.0.0.1 without either becoming ambiguous in a render.
func ExampleConfigSetRanges(path string) ([]ExampleRange, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	base := filepath.Base(path)
	var ranges []ExampleRange
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		m := configKeyLine.FindStringSubmatch(scanner.Text())
		if m == nil {
			continue
		}
		value := stripValue(m[2])
		for _, token := range ipv4Token.FindAllString(value, -1) {
			prefix, ok := prefixOf(token)
			if !ok {
				continue
			}
			if !isRoutableHostIP(prefix.Addr().String()) {
				continue
			}
			ranges = append(ranges, ExampleRange{
				File:   base,
				Line:   lineNum,
				Key:    m[1],
				Raw:    token,
				Prefix: prefix,
			})
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	return ranges, nil
}

// prefixOf turns a token into the network it denotes: a CIDR masked to its
// network address, or a bare address as a single-host prefix.
func prefixOf(token string) (netip.Prefix, bool) {
	if strings.Contains(token, "/") {
		p, err := netip.ParsePrefix(token)
		if err != nil {
			return netip.Prefix{}, false
		}
		return p.Masked(), true
	}
	addr, err := netip.ParseAddr(token)
	if err != nil {
		return netip.Prefix{}, false
	}
	return netip.PrefixFrom(addr, addr.BitLen()), true
}

// reservedAddressRanges are the ranges an example ConfigSet may draw its
// placeholders from. A ConfigSet claims the whole range, not the addresses it
// happens to use out of it, so a second ConfigSet has to pick a different one.
//
// No entry contains another, so the containing entry is unique; the lookup
// still prefers the most specific match so that stays true if one is added.
var reservedAddressRanges = []struct {
	CIDR string
	Name string
}{
	{"10.0.0.0/8", "RFC 1918 private"},
	{"172.16.0.0/12", "RFC 1918 private"},
	{"192.168.0.0/16", "RFC 1918 private"},
	{"100.64.0.0/10", "RFC 6598 shared address space"},
	{"198.18.0.0/15", "RFC 2544 benchmarking"},
	{"192.0.2.0/24", "RFC 5737 TEST-NET-1"},
	{"198.51.100.0/24", "RFC 5737 TEST-NET-2"},
	{"203.0.113.0/24", "RFC 5737 TEST-NET-3"},
	{"2001:db8::/32", "RFC 3849 documentation"},
}

// claimedRange reports the reserved range a declaration falls in, as a prefix
// and a human name.
//
// A declaration in no reserved range claims only itself. That is the weaker
// answer, and it is deliberate: an address outside every reserved range has no
// business being in a template at all, and isExamplePlaceholder is the rule
// that says so. This function does not get to be the second opinion.
func claimedRange(p netip.Prefix) (netip.Prefix, string) {
	best := netip.Prefix{}
	name := ""
	for _, r := range reservedAddressRanges {
		res, err := netip.ParsePrefix(r.CIDR)
		if err != nil {
			continue
		}
		if !res.Contains(p.Addr()) {
			continue
		}
		if !best.IsValid() || res.Bits() > best.Bits() {
			best, name = res, r.Name
		}
	}
	if !best.IsValid() {
		return p, "outside every reserved range"
	}
	return best, name
}

// ExampleConfigSetCollisions reports every reserved address range that more
// than one template ConfigSet in dir draws from, one message per shared range,
// sorted so two runs produce identical output.
//
// An empty result with no error means the ConfigSets are disjoint. A directory
// holding fewer than two template ConfigSets is disjoint trivially, which is
// honest: there is nothing yet for a render-grep to confuse.
func ExampleConfigSetCollisions(dir string) ([]string, error) {
	paths, err := filepath.Glob(filepath.Join(dir, exampleConfigSetGlob))
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)

	// range -> first declaration in each file that claims it, in file order.
	type claim struct {
		name  string
		first map[string]ExampleRange
		files []string
	}
	claims := map[netip.Prefix]*claim{}

	for _, p := range paths {
		ranges, err := ExampleConfigSetRanges(p)
		if err != nil {
			return nil, err
		}
		for _, r := range ranges {
			key, name := claimedRange(r.Prefix)
			c := claims[key]
			if c == nil {
				c = &claim{name: name, first: map[string]ExampleRange{}}
				claims[key] = c
			}
			if _, seen := c.first[r.File]; seen {
				continue
			}
			c.first[r.File] = r
			c.files = append(c.files, r.File)
		}
	}

	var collisions []string
	for key, c := range claims {
		if len(c.files) < 2 {
			continue
		}
		sort.Strings(c.files)
		parts := make([]string, 0, len(c.files))
		for _, f := range c.files {
			parts = append(parts, c.first[f].String())
		}
		collisions = append(collisions, fmt.Sprintf(
			"%s (%s) is claimed by %d example ConfigSets: %s",
			key, c.name, len(c.files), strings.Join(parts, ", ")))
	}
	sort.Strings(collisions)
	return collisions, nil
}
