package config

import (
	"strings"
	"testing"
)

func poolFixture() (*Schema, map[string]string) {
	return &Schema{Keys: map[string]SchemaKey{
		"LB_POOL_START": {AddressRole: "lb-pool-range"}, "LB_POOL_END": {AddressRole: "lb-pool-range"},
		"TRAEFIK_IP": {AddressRole: "lb-allocation"}, "PLEX_IP": {AddressRole: "lb-allocation"}, "OTEL_IP": {AddressRole: "lb-allocation"},
		"CP_VIP": {AddressRole: "dedicated-pool-allocation"}, "NAS_IP": {AddressRole: "infrastructure-address"}, "NAS_LAN": {AddressRole: "infrastructure-address"}, "GATEWAY": {AddressRole: "infrastructure-address"}, "POD_CIDR": {AddressRole: "network-range"},
	}}, map[string]string{"CNI_PROVIDER": "cilium", "LOAD_BALANCER_ENABLED": "true", "LB_POOL_START": "192.0.2.100", "LB_POOL_END": "192.0.2.200", "TRAEFIK_IP": "192.0.2.100", "PLEX_IP": "192.0.2.200", "OTEL_IP": "192.0.2.150", "CP_VIP": "192.0.2.10", "NAS_IP": "192.0.2.20", "NAS_LAN": "192.0.2.21/24", "GATEWAY": "192.0.2.1", "POD_CIDR": "192.0.2.0/24"}
}
func TestValidateAddressRoles(t *testing.T) {
	for _, tc := range []struct{ name, key, value, want string }{
		{"inclusive allocations", "", "", ""}, {"NAS start", "NAS_IP", "192.0.2.100", "NAS_IP: infrastructure-address"}, {"NAS end", "NAS_IP", "192.0.2.200", "NAS_IP: infrastructure-address"},
		{"NAS prefix host", "NAS_LAN", "192.0.2.150/24", "NAS_LAN: infrastructure-address"}, {"VIP start", "CP_VIP", "192.0.2.100", "dedicated-pool-allocation"}, {"VIP end", "CP_VIP", "192.0.2.200", "dedicated-pool-allocation"}, {"gateway overlap", "GATEWAY", "192.0.2.150", "GATEWAY: infrastructure-address"},
		{"LB below", "TRAEFIK_IP", "192.0.2.99", "must be inside"}, {"LB above", "PLEX_IP", "192.0.2.201", "must be inside"}, {"normalized LB", "OTEL_IP", "192.0.2.150/24", ""}, {"normalized endpoint", "LB_POOL_START", "192.0.2.100/24", ""},
		{"malformed start", "LB_POOL_START", "192.0.2.999", "LB_POOL_START: expected"}, {"missing end", "LB_POOL_END", "", "LB_POOL_END: expected"}, {"reversed", "LB_POOL_END", "192.0.2.99", "less than or equal"}, {"bad prefix", "NAS_LAN", "192.0.2.150/33", "NAS_LAN: expected"}, {"bad allocation", "OTEL_IP", "bad", "OTEL_IP: expected"}, {"IPv6", "NAS_IP", "::1", "NAS_IP: expected"},
		{"disabled", "LOAD_BALANCER_ENABLED", "false", ""}, {"other CNI", "CNI_PROVIDER", "calico", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			schema, values := poolFixture()
			if tc.key != "" {
				values[tc.key] = tc.value
			}
			err := ValidateAddressRoles(schema, values)
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v; want %q", err, tc.want)
			}
		})
	}
}
func TestPoolSchemaFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name string
		def  SchemaKey
		want string
	}{
		{"missing role", SchemaKey{Pattern: `^(\d{1,3}\.){3}\d{1,3}$`}, "requires addressRole"},
		{"missing prefix role", SchemaKey{Pattern: `^(\d{1,3}\.){3}\d{1,3}/\d{1,2}$`}, "requires addressRole"},
		{"unknown role", SchemaKey{AddressRole: "infrastructure"}, "unknown addressRole"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			schema, values := poolFixture()
			schema.Keys["NEW_ADDRESS"] = tc.def
			err := ValidateAddressRoles(schema, values)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v; want %s", err, tc.want)
			}
		})
	}
	schema, values := poolFixture()
	delete(schema.Keys, "LB_POOL_START")
	if ValidateAddressRoles(schema, values) == nil {
		t.Fatal("missing endpoint role accepted")
	}
}
func TestDisabledPoolDoesNotValidateUnusedAddresses(t *testing.T) {
	for _, key := range []string{"CNI_PROVIDER", "LOAD_BALANCER_ENABLED"} {
		schema, values := poolFixture()
		values[key] = ""
		values["LB_POOL_START"] = "bad"
		values["NAS_IP"] = "bad"
		if err := ValidateAddressRoles(schema, values); err != nil {
			t.Fatal(err)
		}
	}
}
func TestSingleAddressPool(t *testing.T) {
	schema, values := poolFixture()
	values["LB_POOL_END"] = values["LB_POOL_START"]
	for _, key := range []string{"TRAEFIK_IP", "PLEX_IP", "OTEL_IP"} {
		values[key] = values["LB_POOL_START"]
	}
	if err := ValidateAddressRoles(schema, values); err != nil {
		t.Fatal(err)
	}
	values["NAS_IP"] = values["LB_POOL_START"]
	if ValidateAddressRoles(schema, values) == nil {
		t.Fatal("single-address collision accepted")
	}
}
