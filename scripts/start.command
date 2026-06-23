#!/usr/bin/env bash
# Double-clickable launcher for macOS Finder. Runs scripts/start.sh.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/start.sh"
