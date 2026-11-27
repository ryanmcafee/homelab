package verify

import (
	"context"
	"errors"
	"testing"
	"time"
)

type flakyHelmRunner struct {
	stderrs [][]byte
	calls   int
}

func (*flakyHelmRunner) LookPath(string) (string, error) { return "/fake/helm", nil }

func (r *flakyHelmRunner) Run(context.Context, string, string, ...string) ([]byte, []byte, error) {
	r.calls++
	if r.calls <= len(r.stderrs) {
		return nil, r.stderrs[r.calls-1], errors.New("exit status 1")
	}
	return []byte("kind: ConfigMap\n"), nil, nil
}

func withoutRetryDelay(t *testing.T) {
	t.Helper()
	saved := helmPullRetryDelays
	helmPullRetryDelays = []time.Duration{0, 0}
	t.Cleanup(func() { helmPullRetryDelays = saved })
}

func TestRenderUpstreamRetriesTransientPullErrors(t *testing.T) {
	withoutRetryDelay(t)
	src := ChartSource{App: "radarr", RepoURL: "oci.trueforge.org/truecharts", Chart: "radarr", TargetRevision: "30.1.1"}
	for _, tc := range []struct {
		name      string
		stderrs   [][]byte
		wantCalls int
		wantErr   bool
	}{
		{"429 then success", [][]byte{[]byte(`Error: failed to perform "FetchReference" on source: GET "https://oci.trueforge.org/v2/truecharts/radarr/manifests/30.1.1": response status code 429: toomanyrequests`)}, 2, false},
		{"5xx twice then success", [][]byte{[]byte("response status code 502: Bad Gateway"), []byte("net/http: TLS handshake timeout")}, 3, false},
		{"transient on every attempt", [][]byte{[]byte("status code 503"), []byte("status code 503"), []byte("status code 503")}, 3, true},
		{"missing version is not retried", [][]byte{[]byte("Error: failed to perform \"FetchReference\": manifest unknown, status code 404")}, 1, true},
		{"401 is not retried", [][]byte{[]byte("response status code 401: unauthorized")}, 1, true},
		{"schema failure is not retried", [][]byte{[]byte("Error: values don't meet the specifications of the schema(s)")}, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &flakyHelmRunner{stderrs: tc.stderrs}
			_, err := renderUpstream(context.Background(), r, t.TempDir(), src, "1.34.0", t.TempDir())
			if r.calls != tc.wantCalls {
				t.Errorf("helm ran %d times, want %d", r.calls, tc.wantCalls)
			}
			if (err != nil) != tc.wantErr {
				t.Errorf("err = %v, want error %v", err, tc.wantErr)
			}
		})
	}
}
