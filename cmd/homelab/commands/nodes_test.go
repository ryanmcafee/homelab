package commands

import (
	"slices"
	"testing"
)

// kubectl sorts nodes by name, so a stale talos-8uq-* entry precedes the
// rebuilt talos-n27-* one sharing its InternalIP.
const recreatedNodeList = `talos-8uq-sf6=10.0.0.22=Unknown
talos-aa1-bb1=10.0.0.11=True
talos-n27-ngr=10.0.0.22=True
talos-w01-w01=10.0.0.21 fd00::21=True
`

func TestParseK8sNodes(t *testing.T) {
	got := parseK8sNodes(recreatedNodeList + "\n")
	want := []k8sNode{
		{name: "talos-8uq-sf6", ips: []string{"10.0.0.22"}, ready: false},
		{name: "talos-aa1-bb1", ips: []string{"10.0.0.11"}, ready: true},
		{name: "talos-n27-ngr", ips: []string{"10.0.0.22"}, ready: true},
		{name: "talos-w01-w01", ips: []string{"10.0.0.21", "fd00::21"}, ready: true},
	}
	if len(got) != len(want) {
		t.Fatalf("parsed %d nodes, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].name != want[i].name || !slices.Equal(got[i].ips, want[i].ips) || got[i].ready != want[i].ready {
			t.Errorf("node %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestPickNodeByIP(t *testing.T) {
	tests := []struct {
		name    string
		list    string
		ip      string
		want    string
		wantErr bool
	}{
		{name: "single match", list: recreatedNodeList, ip: "10.0.0.11", want: "talos-aa1-bb1"},
		{name: "matches a secondary address", list: recreatedNodeList, ip: "fd00::21", want: "talos-w01-w01"},
		{name: "prefers the Ready node over a stale one sorting first", list: recreatedNodeList, ip: "10.0.0.22", want: "talos-n27-ngr"},
		{name: "single NotReady match is returned", list: "talos-x=10.0.0.5=False\n", ip: "10.0.0.5", want: "talos-x"},
		{name: "no match", list: recreatedNodeList, ip: "10.0.0.99", wantErr: true},
		{name: "empty list", list: "", ip: "10.0.0.11", wantErr: true},
		{name: "several NotReady matches are ambiguous", list: "a=10.0.0.5=False\nb=10.0.0.5=Unknown\n", ip: "10.0.0.5", wantErr: true},
		{name: "several Ready matches are ambiguous", list: "a=10.0.0.5=True\nb=10.0.0.5=True\n", ip: "10.0.0.5", wantErr: true},
		{name: "does not match an IP prefix", list: "a=10.0.0.50=True\n", ip: "10.0.0.5", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := pickNodeByIP(parseK8sNodes(tt.list), tt.ip)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %t", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPickNewReadyNodeByIP(t *testing.T) {
	tests := []struct {
		name    string
		list    string
		ip      string
		oldName string
		want    string
		wantOK  bool
	}{
		{name: "stale node sorting first does not hide the new one", list: recreatedNodeList, ip: "10.0.0.22", oldName: "talos-8uq-sf6", want: "talos-n27-ngr", wantOK: true},
		{name: "old node still Ready and alone is not accepted", list: "talos-old=10.0.0.22=True\n", ip: "10.0.0.22", oldName: "talos-old"},
		{name: "new node not Ready yet", list: "talos-old=10.0.0.22=Unknown\ntalos-zzz=10.0.0.22=False\n", ip: "10.0.0.22", oldName: "talos-old"},
		{name: "new node sorting first", list: "talos-aaa=10.0.0.22=True\ntalos-old=10.0.0.22=Unknown\n", ip: "10.0.0.22", oldName: "talos-old", want: "talos-aaa", wantOK: true},
		{name: "no old node accepts any Ready node", list: recreatedNodeList, ip: "10.0.0.11", want: "talos-aa1-bb1", wantOK: true},
		{name: "node at another IP is ignored", list: recreatedNodeList, ip: "10.0.0.99", oldName: "talos-8uq-sf6"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := pickNewReadyNodeByIP(parseK8sNodes(tt.list), tt.ip, tt.oldName)
			if ok != tt.wantOK || got != tt.want {
				t.Errorf("got (%q, %t), want (%q, %t)", got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestStaleNodesByIP(t *testing.T) {
	list := recreatedNodeList + "talos-0ld-0ld=10.0.0.22=Unknown\n"
	got := staleNodesByIP(parseK8sNodes(list), "10.0.0.22", "talos-n27-ngr")
	want := []string{"talos-8uq-sf6", "talos-0ld-0ld"}
	if !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}
