#!/usr/bin/env bash
# Read PR filenames (one per line) from GitHub's pull files API. Print the
# job-condition value. Keep this list in sync with tilt-ci.yml's push filter.
set -euo pipefail

seen=false
relevant=false
while IFS= read -r path; do
  seen=true
  case "$path" in
    charts/*|localdev/*|scripts/*|configuration/*|tests/e2e/*|tests/health/*|cmd/*|internal/*|Tiltfile|Taskfile.yml|go.mod|go.sum|mise.toml|package.json|bun.lock|tsconfig.json|biome.json|.github/workflows/tilt-ci.yml)
      relevant=true
      ;;
  esac
done

if [[ "$seen" == false ]]; then
  echo '::error::GitHub returned no changed paths; refusing to skip level 2.' >&2
  exit 1
fi
printf '%s\n' "$relevant"
