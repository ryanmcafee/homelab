package logger

import (
	"fmt"
	"github.com/fatih/color"
)

var (
	cyan   = color.New(color.FgCyan).SprintFunc()
	green  = color.New(color.FgGreen).SprintFunc()
	red    = color.New(color.FgRed).SprintFunc()
	yellow = color.New(color.FgYellow).SprintFunc()
)

// Info logs an informational message
func Info(message string) {
	fmt.Printf("%s %s\n", cyan("[INFO]"), message)
}

// OK logs a success message
func OK(message string) {
	fmt.Printf("%s %s\n", green("[OK]"), message)
}

// Error logs an error message
func Error(message string) {
	fmt.Printf("%s %s\n", red("[ERROR]"), message)
}

// Warn logs a warning message
func Warn(message string) {
	fmt.Printf("%s %s\n", yellow("[WARN]"), message)
}
