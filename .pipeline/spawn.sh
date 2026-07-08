#!/usr/bin/env bash
# Deprecated: use .pipeline/orchestrate.sh or /orchestrate
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/orchestrate.sh" "$@"
