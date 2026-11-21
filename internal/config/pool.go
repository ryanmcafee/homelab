package config

import (
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strings"
)

// LBPoolBlock is one inclusive address range of the Cilium LB pool.
type LBPoolBlock struct {
	Start string
	Stop  string
}

// ValidateAddressRoles checks the inclusive Cilium LB pool against schema roles.
// The gate matches helm-addons.tmpl: an unused pool has no allocation conflicts.
func ValidateAddressRoles(schema *Schema, values map[string]string) error {
	_, err := planLBPool(schema, values)
	return err
}

// DeriveLBPool returns the LB pool ranges with every infrastructure and dedicated-pool
// address carved out, or nil when no Cilium LB pool is in use.
func DeriveLBPool(schema *Schema, values map[string]string) ([]LBPoolBlock, error) {
	return planLBPool(schema, values)
}

func lbPoolActive(values map[string]string) bool {
	return values["CNI_PROVIDER"] == "cilium" && values["LOAD_BALANCER_ENABLED"] == "true"
}

func planLBPool(schema *Schema, values map[string]string) ([]LBPoolBlock, error) {
	if !lbPoolActive(values) {
		return nil, nil
	}
	if schema == nil {
		return nil, fmt.Errorf("address-role validation requires a schema")
	}
	var problems []string
	roles := make(map[string]string, len(schema.Keys))
	for key, def := range schema.Keys {
		problems = append(problems, roleProblems(key, "IPv4 schema key", def)...)
		roles[key] = def.AddressRole
	}
	for pattern, kp := range schema.KeyPatterns {
		problems = append(problems, roleProblems(pattern, "IPv4 key pattern", kp.SchemaKey)...)
	}
	for key := range values {
		if _, literal := schema.Keys[key]; literal {
			continue
		}
		kp, matched, err := schema.matchKeyPattern(key)
		if err != nil {
			problems = append(problems, err.Error())
		} else if matched {
			roles[key] = kp.AddressRole
		}
	}
	keys := make([]string, 0, len(roles))
	for key := range roles {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	sort.Strings(problems)
	endpoints := make([]netip.Addr, 2)
	for i, key := range []string{"LB_POOL_START", "LB_POOL_END"} {
		if schema.Keys[key].AddressRole != "lb-pool-range" {
			problems = append(problems, fmt.Sprintf("%s: schema addressRole must be lb-pool-range", key))
		}
		addr, err := poolAddress(values[key])
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", key, err))
		} else {
			endpoints[i] = addr
		}
	}
	start, end := endpoints[0], endpoints[1]
	validRange := start.IsValid() && end.IsValid()
	if validRange && start.Compare(end) > 0 {
		problems = append(problems, "LB_POOL_START must be less than or equal to LB_POOL_END")
		validRange = false
	}
	carved := map[netip.Addr]string{}
	allocations := map[string]netip.Addr{}
	for _, key := range keys {
		role := roles[key]
		switch role {
		case "lb-allocation", "dedicated-pool-allocation", "infrastructure-address":
		default:
			continue
		}
		value := values[key]
		if value == "" {
			continue
		} // Required values are checked by ValidateValues.
		addr, err := poolAddress(value)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", key, err))
			continue
		}
		if !validRange {
			continue
		}
		inside := addr.Compare(start) >= 0 && addr.Compare(end) <= 0
		switch {
		case role == "lb-allocation" && !inside:
			problems = append(problems, fmt.Sprintf("%s: lb-allocation address %s must be inside inclusive LB pool %s-%s", key, addr, start, end))
		case role == "lb-allocation":
			allocations[key] = addr
		case inside:
			if _, seen := carved[addr]; !seen {
				carved[addr] = key
			}
		}
	}
	for _, key := range keys {
		addr, ok := allocations[key]
		if !ok {
			continue
		}
		if owner, clash := carved[addr]; clash {
			problems = append(problems, fmt.Sprintf("%s: lb-allocation address %s is %s's address, which the LB pool carves out; move one of them", key, addr, owner))
		}
	}
	var blocks []LBPoolBlock
	if validRange {
		blocks = carveBlocks(start, end, carved)
		if len(blocks) == 0 {
			problems = append(problems, fmt.Sprintf("LB pool %s-%s has no address left once infrastructure addresses are carved out", start, end))
		}
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("invalid LB pool configuration:\n- %s", strings.Join(problems, "\n- "))
	}
	return blocks, nil
}

func carveBlocks(start, end netip.Addr, carved map[netip.Addr]string) []LBPoolBlock {
	var blocks []LBPoolBlock
	var open netip.Addr
	for addr := start; ; addr = addr.Next() {
		if _, skip := carved[addr]; skip {
			if open.IsValid() {
				blocks = append(blocks, LBPoolBlock{Start: open.String(), Stop: addr.Prev().String()})
				open = netip.Addr{}
			}
		} else if !open.IsValid() {
			open = addr
		}
		if addr == end {
			break
		}
	}
	if open.IsValid() {
		blocks = append(blocks, LBPoolBlock{Start: open.String(), Stop: end.String()})
	}
	return blocks
}

func roleProblems(name, kind string, def SchemaKey) []string {
	switch def.AddressRole {
	case "":
		if addressPattern(def.Pattern) {
			return []string{fmt.Sprintf("%s: %s requires addressRole", name, kind)}
		}
	case "lb-pool-range", "lb-allocation", "dedicated-pool-allocation", "infrastructure-address", "network-range":
	default:
		return []string{fmt.Sprintf("%s: unknown addressRole %q", name, def.AddressRole)}
	}
	return nil
}

func poolAddress(value string) (netip.Addr, error) {
	value = strings.TrimSpace(value)
	var addr netip.Addr
	var err error
	if strings.Contains(value, "/") {
		var prefix netip.Prefix
		prefix, err = netip.ParsePrefix(value)
		if err == nil {
			addr = prefix.Addr()
		}
	} else {
		addr, err = netip.ParseAddr(value)
	}
	if err != nil || !addr.Is4() {
		return netip.Addr{}, fmt.Errorf("expected an IPv4 address or IPv4 address/prefix, got %q", value)
	}
	return addr, nil
}

// Recognize IPv4 schema constraints independently of key names, so adding a
// new address without a role fails closed. Both host and prefix forms count.
func addressPattern(pattern string) bool {
	if pattern == "" {
		return false
	}
	re, err := regexp.Compile("^(?:" + pattern + ")$")
	if err != nil {
		return false
	}
	return !re.MatchString("not-an-address") && (re.MatchString("192.0.2.1") || re.MatchString("192.0.2.1/24"))
}
