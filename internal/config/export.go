package config

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"text/template"
)

// Export renders a ResolvedConfig through a Go template file and returns the output string.
func Export(rc *ResolvedConfig, templatePath string) (string, error) {
	data, err := os.ReadFile(templatePath)
	if err != nil {
		return "", fmt.Errorf("reading template %s: %w", templatePath, err)
	}

	tmpl, err := template.New(filepath.Base(templatePath)).Parse(string(data))
	if err != nil {
		return "", fmt.Errorf("parsing template %s: %w", templatePath, err)
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, rc); err != nil {
		return "", fmt.Errorf("executing template %s: %w", templatePath, err)
	}

	return buf.String(), nil
}

// ExportToFile renders a template and writes the result to a file, creating directories as needed.
func ExportToFile(rc *ResolvedConfig, templatePath string, outputPath string) error {
	result, err := Export(rc, templatePath)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(outputPath), 0755); err != nil {
		return fmt.Errorf("creating output directory: %w", err)
	}

	if err := os.WriteFile(outputPath, []byte(result), 0644); err != nil {
		return fmt.Errorf("writing output %s: %w", outputPath, err)
	}

	return nil
}

// readFileString is a helper for tests.
func readFileString(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
