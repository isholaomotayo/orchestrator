#!/usr/bin/env bash
# Portable entrypoint for the unified agent pipeline.
# Usage: bash .pipeline/spawn.sh "task description" [--runner claude|cursor|codex|gemini] [--sandbox] [--no-ui]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PIPELINE_DIR="$SCRIPT_DIR"
UI_PORT="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIPELINE_DIR/config.json','utf8')).uiPort||4600)}catch{console.log(4600)}")"

TASK="${1:-}"
if [ -z "$TASK" ] || [[ "$TASK" == --* ]]; then
  echo "Usage: bash .pipeline/spawn.sh \"task description\" [--runner claude|cursor|codex|gemini] [--sandbox] [--no-ui]" >&2
  exit 2
fi
shift

NO_UI=0
ORCH_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-ui) NO_UI=1 ;;
    *) ORCH_ARGS+=("$1") ;;
  esac
  shift
done

# Guardrail 3: pre-flight mutex check (orchestrator re-checks atomically).
if [ -f "$PIPELINE_DIR/.lock" ]; then
  echo "[spawn] Pipeline is locked by another running agent (.pipeline/.lock exists). Waiting is not supported — retry later or remove the stale lock." >&2
  exit 1
fi

# Start the dashboard server if it isn't already listening.
if [ "$NO_UI" -eq 0 ]; then
  if ! curl -sf "http://localhost:$UI_PORT/healthz" >/dev/null 2>&1; then
    echo "[spawn] Starting dashboard at http://localhost:$UI_PORT ..."
    (cd "$REPO_ROOT" && nohup node pipeline/ui-server.mjs > "$PIPELINE_DIR/ui-server.out" 2>&1 & echo $! > "$PIPELINE_DIR/ui-server.pid")
    sleep 0.5
  fi
  echo "[spawn] Live dashboard: http://localhost:$UI_PORT"
fi

cd "$REPO_ROOT"
set +e
node pipeline/orchestrator.mjs --task "$TASK" "${ORCH_ARGS[@]+"${ORCH_ARGS[@]}"}"
EXIT_CODE=$?
set -e

echo ""
if [ -f "$PIPELINE_DIR/review_report.md" ]; then
  echo "[spawn] Final review: .pipeline/review_report.md"
elif [ -f "$PIPELINE_DIR/checker_report.md" ]; then
  echo "[spawn] Pipeline halted — inspect .pipeline/checker_report.md and .pipeline/changes.md"
fi
exit $EXIT_CODE
