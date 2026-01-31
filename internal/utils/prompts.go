package utils

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/ryanmcafee/homelab/internal/logger"
)

// AutoAccept is a global flag for auto-accepting all prompts
var AutoAccept = false

// Confirm prompts the user for confirmation
func Confirm(message string) bool {
	if AutoAccept {
		logger.Info(fmt.Sprintf("%s [y/N] y (auto-accepted)", message))
		return true
	}

	if DryRun {
		logger.Warn(fmt.Sprintf("%s [y/N] (dry-run - skipped)", message))
		return false
	}

	reader := bufio.NewReader(os.Stdin)
	fmt.Printf("%s [y/N] ", message)
	response, _ := reader.ReadString('\n')
	response = strings.TrimSpace(strings.ToLower(response))

	return response == "y" || response == "yes"
}

// PromptSelect prompts the user to select from a list of options
func PromptSelect(message string, options []string, defaultIdx int) int {
	if AutoAccept {
		logger.Info(fmt.Sprintf("%s (auto-accepted: %s)", message, options[defaultIdx]))
		return defaultIdx
	}

	if DryRun {
		logger.Warn(fmt.Sprintf("%s (dry-run - using default: %s)", message, options[defaultIdx]))
		return defaultIdx
	}

	fmt.Println(message)
	for i, option := range options {
		fmt.Printf("  %d) %s\n", i+1, option)
	}
	fmt.Println()

	reader := bufio.NewReader(os.Stdin)
	fmt.Printf("Enter choice [1-%d] (default: %d): ", len(options), defaultIdx+1)
	response, _ := reader.ReadString('\n')
	response = strings.TrimSpace(response)

	if response == "" {
		return defaultIdx
	}

	var choice int
	_, err := fmt.Sscanf(response, "%d", &choice)
	if err != nil || choice < 1 || choice > len(options) {
		logger.Warn(fmt.Sprintf("Invalid choice, using default: %s", options[defaultIdx]))
		return defaultIdx
	}

	return choice - 1
}
