package utils

import (
	"os"
	"path/filepath"
	"runtime"
)

// PathSeparator returns the OS-specific path separator
func PathSeparator() string {
	if runtime.GOOS == "windows" {
		return "\\"
	}
	return "/"
}

// JoinPath joins path elements using OS-specific separator
func JoinPath(elem ...string) string {
	return filepath.Join(elem...)
}

// HomeDir returns the user's home directory
func HomeDir() (string, error) {
	return os.UserHomeDir()
}

// FileExists checks if a file exists
func FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// DirExists checks if a directory exists
func DirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// CreateDir creates a directory if it doesn't exist
func CreateDir(path string) error {
	if DirExists(path) {
		return nil
	}
	return os.MkdirAll(path, 0755)
}
