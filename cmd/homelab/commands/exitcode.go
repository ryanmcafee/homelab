package commands

import "errors"

// Exit codes shared by the level-0 verification commands:
//
//	0  every check passed
//	1  at least one check failed, or the command errored
//	2  the command was invoked wrongly (bad flag, missing required input)
const (
	ExitOK      = 0
	ExitFailure = 1
	ExitUsage   = 2
)

// UsageError marks an error caused by how the command was invoked rather than
// by the state of the repository. main maps it to exit code 2.
type UsageError struct{ Err error }

func (e *UsageError) Error() string { return e.Err.Error() }
func (e *UsageError) Unwrap() error { return e.Err }

// NewUsageError wraps err as a usage error.
func NewUsageError(err error) error { return &UsageError{Err: err} }

// ExitCode maps a command error to a process exit code.
func ExitCode(err error) int {
	if err == nil {
		return ExitOK
	}
	var ue *UsageError
	if errors.As(err, &ue) {
		return ExitUsage
	}
	return ExitFailure
}
