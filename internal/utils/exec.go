package utils

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/ryanmcafee/homelab/internal/logger"
)

// CommandResult holds the result of a command execution
type CommandResult struct {
	Stdout  string
	Stderr  string
	Success bool
	Code    int
}

// DryRun is a global flag for dry-run mode
var DryRun = false

// ExecCommand runs a command and returns the result
func ExecCommand(name string, args ...string) (*CommandResult, error) {
	if DryRun {
		logger.Warn(fmt.Sprintf("Would run: %s %s", name, strings.Join(args, " ")))
		return &CommandResult{Success: true, Code: 0}, nil
	}

	cmd := exec.Command(name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	code := 0
	success := true

	if err != nil {
		success = false
		if exitError, ok := err.(*exec.ExitError); ok {
			code = exitError.ExitCode()
		} else {
			code = 1
		}
	}

	return &CommandResult{
		Stdout:  stdout.String(),
		Stderr:  stderr.String(),
		Success: success,
		Code:    code,
	}, err
}

// ExecCommandWithEnv runs a command with custom environment variables
func ExecCommandWithEnv(name string, env map[string]string, args ...string) (*CommandResult, error) {
	if DryRun {
		logger.Warn(fmt.Sprintf("Would run: %s %s", name, strings.Join(args, " ")))
		return &CommandResult{Success: true, Code: 0}, nil
	}

	cmd := exec.Command(name, args...)
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	code := 0
	success := true

	if err != nil {
		success = false
		if exitError, ok := err.(*exec.ExitError); ok {
			code = exitError.ExitCode()
		} else {
			code = 1
		}
	}

	return &CommandResult{
		Stdout:  stdout.String(),
		Stderr:  stderr.String(),
		Success: success,
		Code:    code,
	}, err
}

// ExecCommandWithStdin runs a command with stdin input
func ExecCommandWithStdin(stdin string, name string, args ...string) (*CommandResult, error) {
	if DryRun {
		logger.Warn(fmt.Sprintf("Would run: %s %s", name, strings.Join(args, " ")))
		return &CommandResult{Success: true, Code: 0}, nil
	}

	cmd := exec.Command(name, args...)
	cmd.Stdin = strings.NewReader(stdin)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	code := 0
	success := true

	if err != nil {
		success = false
		if exitError, ok := err.(*exec.ExitError); ok {
			code = exitError.ExitCode()
		} else {
			code = 1
		}
	}

	return &CommandResult{
		Stdout:  stdout.String(),
		Stderr:  stderr.String(),
		Success: success,
		Code:    code,
	}, err
}
