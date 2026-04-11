package commands

import "testing"

func TestFindVMAddress(t *testing.T) {
	const fullState = `data.talos_machine_configuration.worker["worker-1"]
proxmox_virtual_environment_file.machine_config["cp-1"]
proxmox_virtual_environment_file.machine_config["worker-1"]
proxmox_virtual_environment_vm.controlplane["cp-1"]
proxmox_virtual_environment_vm.controlplane["cp-2"]
proxmox_virtual_environment_vm.worker["worker-1"]
proxmox_virtual_environment_vm.worker["worker-2"]
proxmox_virtual_environment_vm.worker["worker-3"]
random_id.this`

	tests := []struct {
		name    string
		output  string
		node    string
		want    string
		wantErr bool
	}{
		{
			name:   "matches worker by key",
			output: fullState,
			node:   "worker-1",
			want:   `proxmox_virtual_environment_vm.worker["worker-1"]`,
		},
		{
			name:   "matches controlplane by key",
			output: fullState,
			node:   "cp-2",
			want:   `proxmox_virtual_environment_vm.controlplane["cp-2"]`,
		},
		{
			name:    "no match returns error",
			output:  fullState,
			node:    "worker-9",
			wantErr: true,
		},
		{
			name:    "empty state returns error",
			output:  "",
			node:    "worker-1",
			wantErr: true,
		},
		{
			name:    "avoids prefix-substring match",
			output:  `proxmox_virtual_environment_vm.worker["worker-10"]`,
			node:    "worker-1",
			wantErr: true,
		},
		{
			name:   "ignores non-vm resources that share the key",
			output: fullState,
			node:   "worker-2",
			want:   `proxmox_virtual_environment_vm.worker["worker-2"]`,
		},
		{
			name:   "trims whitespace",
			output: "   proxmox_virtual_environment_vm.worker[\"worker-1\"]   \n",
			node:   "worker-1",
			want:   `proxmox_virtual_environment_vm.worker["worker-1"]`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := findVMAddress(tc.output, tc.node)
			if (err != nil) != tc.wantErr {
				t.Fatalf("findVMAddress err = %v, wantErr = %v", err, tc.wantErr)
			}
			if got != tc.want {
				t.Errorf("findVMAddress = %q, want %q", got, tc.want)
			}
		})
	}
}
