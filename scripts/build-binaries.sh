#!/usr/bin/env bash
# Cross-compile homelab CLI for multiple platforms

set -euo pipefail

VERSION=${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo "dev")}
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "none")
DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS="-X main.version=${VERSION} -X main.commit=${COMMIT} -X main.date=${DATE} -w -s"

echo "Building homelab CLI binaries..."
echo "  Version: ${VERSION}"
echo "  Commit:  ${COMMIT}"
echo "  Date:    ${DATE}"
echo ""

mkdir -p bin

# Linux AMD64
echo "Building linux-amd64..."
GOOS=linux GOARCH=amd64 go build -ldflags="${LDFLAGS}" -o bin/homelab-linux-amd64 ./cmd/homelab

# macOS AMD64
echo "Building darwin-amd64..."
GOOS=darwin GOARCH=amd64 go build -ldflags="${LDFLAGS}" -o bin/homelab-darwin-amd64 ./cmd/homelab

# macOS ARM64
echo "Building darwin-arm64..."
GOOS=darwin GOARCH=arm64 go build -ldflags="${LDFLAGS}" -o bin/homelab-darwin-arm64 ./cmd/homelab

# Windows AMD64
echo "Building windows-amd64..."
GOOS=windows GOARCH=amd64 go build -ldflags="${LDFLAGS}" -o bin/homelab-windows-amd64.exe ./cmd/homelab

echo ""
echo "Build complete!"
ls -lh bin/
