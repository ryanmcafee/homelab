package config

import (
	"strings"
	"testing"
)

func TestExportDotenv(t *testing.T) {
	rc := &ResolvedConfig{
		Values: map[string]ConfigValue{
			"DOMAIN":  {Key: "DOMAIN", Value: "test.local", Source: "test"},
			"IP_ADDR": {Key: "IP_ADDR", Value: "192.168.1.1", Source: "test"},
		},
		Set: "test",
	}

	result, err := Export(rc, testdataPath("templates", "dotenv.tmpl"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(result, "DOMAIN=test.local") {
		t.Errorf("output missing DOMAIN=test.local, got:\n%s", result)
	}
	if !strings.Contains(result, "IP_ADDR=192.168.1.1") {
		t.Errorf("output missing IP_ADDR=192.168.1.1, got:\n%s", result)
	}
}

func TestExportMissingTemplate(t *testing.T) {
	rc := &ResolvedConfig{
		Values: map[string]ConfigValue{},
		Set:    "test",
	}

	_, err := Export(rc, testdataPath("templates", "nonexistent.tmpl"))
	if err == nil {
		t.Fatal("expected error for missing template")
	}
}

func TestExportToFile(t *testing.T) {
	rc := &ResolvedConfig{
		Values: map[string]ConfigValue{
			"KEY": {Key: "KEY", Value: "val", Source: "test"},
		},
		Set: "test",
	}

	tmpDir := t.TempDir()
	outPath := tmpDir + "/output.env"

	err := ExportToFile(rc, testdataPath("templates", "dotenv.tmpl"), outPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify file was created and contains expected content
	data, err := readFileString(outPath)
	if err != nil {
		t.Fatalf("reading output: %v", err)
	}
	if !strings.Contains(data, "KEY=val") {
		t.Errorf("output file missing KEY=val, got:\n%s", data)
	}
}
