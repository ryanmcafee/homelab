package commands

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeGPUCheckRunner is a test double that records which runner methods were
// invoked and returns canned values controlled by the test case.
//
// It implements the gpuCheckRunner interface declared in verify.go. Tests fail
// to compile until Task 2 lands the production definition — that is the
// expected RED state for Task 1.
type fakeGPUCheckRunner struct {
	// calls records ordered method invocations for assertion.
	calls []string

	// canned return values keyed by method name
	allocatable map[string]map[string]string // node -> resource -> qty
	allocErr    error

	runtimeClass    map[string]bool
	runtimeClassErr error

	namespaceHealthy map[string]bool
	namespaceErr     error

	devNodes    map[string][]string
	devNodesErr error
}

func newFakeRunner() *fakeGPUCheckRunner {
	return &fakeGPUCheckRunner{
		allocatable:      map[string]map[string]string{},
		runtimeClass:     map[string]bool{},
		namespaceHealthy: map[string]bool{},
		devNodes:         map[string][]string{},
	}
}

func (f *fakeGPUCheckRunner) NodeAllocatable(ctx context.Context, node string) (map[string]string, error) {
	f.calls = append(f.calls, "NodeAllocatable:"+node)
	if f.allocErr != nil {
		return nil, f.allocErr
	}
	if v, ok := f.allocatable[node]; ok {
		return v, nil
	}
	return map[string]string{}, nil
}

func (f *fakeGPUCheckRunner) RuntimeClassExists(ctx context.Context, name string) (bool, error) {
	f.calls = append(f.calls, "RuntimeClassExists:"+name)
	if f.runtimeClassErr != nil {
		return false, f.runtimeClassErr
	}
	return f.runtimeClass[name], nil
}

func (f *fakeGPUCheckRunner) NamespacePodsHealthy(ctx context.Context, namespace string) (bool, error) {
	f.calls = append(f.calls, "NamespacePodsHealthy:"+namespace)
	if f.namespaceErr != nil {
		return false, f.namespaceErr
	}
	return f.namespaceHealthy[namespace], nil
}

func (f *fakeGPUCheckRunner) DevDriDeviceNodes(ctx context.Context, namespace string) ([]string, error) {
	f.calls = append(f.calls, "DevDriDeviceNodes:"+namespace)
	if f.devNodesErr != nil {
		return nil, f.devNodesErr
	}
	if v, ok := f.devNodes[namespace]; ok {
		return v, nil
	}
	return nil, nil
}

// TestVerifyGPUDispatch covers the vendor dispatch logic for `homelab verify gpu`.
//
// The production dispatcher `verifyGPU(ctx, vendor, runner)` is expected to:
//   - Return nil and invoke no runner methods when vendor="none".
//   - Invoke NVIDIA check sequence when vendor="nvidia".
//   - Invoke Intel check sequence when vendor="intel".
//   - Return an error mentioning "GPU_VENDOR not set" when vendor="".
//   - Return an error mentioning "unsupported GPU vendor" for unknown vendors.
//   - Propagate underlying check errors with the failing check name.
func TestVerifyGPUDispatch(t *testing.T) {
	tests := []struct {
		name          string
		vendor        string
		setup         func(f *fakeGPUCheckRunner)
		wantErr       bool
		wantErrSubstr string
		// wantCallSubstrs is a list of substrings that MUST appear somewhere
		// in the recorded call list. Order is not asserted.
		wantCallSubstrs []string
		// forbidCalls asserts no method was invoked (used by "none" case).
		forbidCalls bool
	}{
		{
			name:   "nvidia dispatch invokes nvidia check set",
			vendor: "nvidia",
			setup: func(f *fakeGPUCheckRunner) {
				f.runtimeClass["nvidia"] = true
				f.allocatable["worker-1"] = map[string]string{"nvidia.com/gpu": "1"}
				f.namespaceHealthy["gpu-operator"] = true
			},
			wantErr: false,
			wantCallSubstrs: []string{
				"RuntimeClassExists:nvidia",
				"NodeAllocatable:worker-1",
				"NamespacePodsHealthy:gpu-operator",
			},
		},
		{
			name:   "intel dispatch invokes intel check set",
			vendor: "intel",
			setup: func(f *fakeGPUCheckRunner) {
				f.allocatable["worker-1"] = map[string]string{"gpu.intel.com/xe": "1"}
				f.namespaceHealthy["intel-device-plugins"] = true
				f.devNodes["intel-device-plugins"] = []string{"card0", "renderD128"}
			},
			wantErr: false,
			wantCallSubstrs: []string{
				"NodeAllocatable:worker-1",
				"NamespacePodsHealthy:intel-device-plugins",
				"DevDriDeviceNodes:intel-device-plugins",
			},
		},
		{
			name:        "none dispatch skips all checks and returns nil",
			vendor:      "none",
			setup:       func(f *fakeGPUCheckRunner) {},
			wantErr:     false,
			forbidCalls: true,
		},
		{
			name:          "missing GPU_VENDOR key returns error",
			vendor:        "",
			setup:         func(f *fakeGPUCheckRunner) {},
			wantErr:       true,
			wantErrSubstr: "GPU_VENDOR not set",
		},
		{
			name:          "invalid vendor returns unsupported error",
			vendor:        "amd",
			setup:         func(f *fakeGPUCheckRunner) {},
			wantErr:       true,
			wantErrSubstr: "unsupported GPU vendor",
		},
		{
			name:   "exec failure is propagated with check name",
			vendor: "intel",
			setup: func(f *fakeGPUCheckRunner) {
				// Allocatable returns an error — dispatch must surface it
				// and name the failing check.
				f.allocErr = errors.New("kubectl: connection refused")
			},
			wantErr:       true,
			wantErrSubstr: "allocatable",
		},
		{
			name:   "nvidia runtime-class missing returns runtime-class error",
			vendor: "nvidia",
			setup: func(f *fakeGPUCheckRunner) {
				f.runtimeClass["nvidia"] = false // explicit absence
			},
			wantErr:       true,
			wantErrSubstr: "runtime-class",
		},
		{
			name:   "nvidia allocatable missing resource returns allocatable error",
			vendor: "nvidia",
			setup: func(f *fakeGPUCheckRunner) {
				f.runtimeClass["nvidia"] = true
				f.allocatable["worker-1"] = map[string]string{} // no nvidia.com/gpu
			},
			wantErr:       true,
			wantErrSubstr: "allocatable",
		},
		{
			name:   "nvidia namespace unhealthy returns namespace-health error",
			vendor: "nvidia",
			setup: func(f *fakeGPUCheckRunner) {
				f.runtimeClass["nvidia"] = true
				f.allocatable["worker-1"] = map[string]string{"nvidia.com/gpu": "1"}
				f.namespaceHealthy["gpu-operator"] = false
			},
			wantErr:       true,
			wantErrSubstr: "namespace-health",
		},
		{
			name:   "intel dev-dri missing card0 returns dev-dri error",
			vendor: "intel",
			setup: func(f *fakeGPUCheckRunner) {
				f.allocatable["worker-1"] = map[string]string{"gpu.intel.com/xe": "1"}
				f.namespaceHealthy["intel-device-plugins"] = true
				f.devNodes["intel-device-plugins"] = []string{"renderD128"} // missing card0
			},
			wantErr:       true,
			wantErrSubstr: "dev-dri",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeRunner()
			if tt.setup != nil {
				tt.setup(f)
			}

			err := verifyGPU(context.Background(), tt.vendor, "worker-1", f)

			if tt.wantErr && err == nil {
				t.Fatalf("expected error, got nil (calls=%v)", f.calls)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected error: %v (calls=%v)", err, f.calls)
			}
			if tt.wantErr && tt.wantErrSubstr != "" {
				if !strings.Contains(err.Error(), tt.wantErrSubstr) {
					t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErrSubstr)
				}
			}
			if tt.forbidCalls && len(f.calls) != 0 {
				t.Fatalf("expected zero runner calls, got %v", f.calls)
			}
			for _, want := range tt.wantCallSubstrs {
				found := false
				for _, got := range f.calls {
					if got == want {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("expected call %q in %v", want, f.calls)
				}
			}
		})
	}
}

// TestVerifyGPUInterfaceContract ensures fakeGPUCheckRunner satisfies the
// production interface. This is a compile-time guard that will fail Task 1
// until Task 2 defines gpuCheckRunner.
func TestVerifyGPUInterfaceContract(t *testing.T) {
	var _ gpuCheckRunner = (*fakeGPUCheckRunner)(nil)
}

// TestPrintGPUStatus asserts that status mode is read-only: it invokes the
// runner but swallows errors and never panics, for all three vendors.
// Status mode is advisory and must never block `task gpu:status` on a
// transient cluster failure.
func TestPrintGPUStatus(t *testing.T) {
	tests := []struct {
		name      string
		vendor    string
		setup     func(f *fakeGPUCheckRunner)
		wantCalls bool // whether the runner should be invoked at all
	}{
		{
			name:      "nvidia status invokes runner and tolerates healthy cluster",
			vendor:    "nvidia",
			wantCalls: true,
			setup: func(f *fakeGPUCheckRunner) {
				f.allocatable["worker-1"] = map[string]string{"nvidia.com/gpu": "1"}
				f.namespaceHealthy["gpu-operator"] = true
			},
		},
		{
			name:      "intel status invokes runner and tolerates healthy cluster",
			vendor:    "intel",
			wantCalls: true,
			setup: func(f *fakeGPUCheckRunner) {
				f.allocatable["worker-1"] = map[string]string{"gpu.intel.com/xe": "1"}
				f.namespaceHealthy["intel-device-plugins"] = true
			},
		},
		{
			name:      "none status is a no-op and invokes no checks",
			vendor:    "none",
			wantCalls: false,
			setup:     func(f *fakeGPUCheckRunner) {},
		},
		{
			name:      "nvidia status swallows allocatable error",
			vendor:    "nvidia",
			wantCalls: true,
			setup: func(f *fakeGPUCheckRunner) {
				f.allocErr = errors.New("kubectl: connection refused")
				f.namespaceHealthy["gpu-operator"] = true
			},
		},
		{
			name:      "intel status swallows namespace-health error",
			vendor:    "intel",
			wantCalls: true,
			setup: func(f *fakeGPUCheckRunner) {
				f.allocatable["worker-1"] = map[string]string{"gpu.intel.com/xe": "1"}
				f.namespaceErr = errors.New("kubectl: forbidden")
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeRunner()
			if tt.setup != nil {
				tt.setup(f)
			}

			// printGPUStatus has no return value; the contract is
			// "never panics, returns normally".
			printGPUStatus(context.Background(), tt.vendor, "worker-1", f)

			if tt.wantCalls && len(f.calls) == 0 {
				t.Fatalf("expected runner calls for vendor=%s, got none", tt.vendor)
			}
			if !tt.wantCalls && len(f.calls) != 0 {
				t.Fatalf("expected zero runner calls for vendor=%s, got %v", tt.vendor, f.calls)
			}
		})
	}
}
