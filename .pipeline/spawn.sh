#!/usr/bin/env bash
# Portable entrypoint for the unified agent pipeline.
#
# Start a new run:
#   bash .pipeline/spawn.sh "task description" [--runner claude|cursor|codex|gemini] \
#     [--sandbox] [--max-cycles n] [--max-post-tester-cycles n] [--no-ui]
#
# Extend a run that halted with MAX_CYCLES (continues the same fix loop,
# repeatable as many times as needed):
#   bash .pipeline/spawn.sh --resume --extend <n> [--runner ...] [--no-ui]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PIPELINE_DIR="$SCRIPT_DIR"
BASE_PORT="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIPELINE_DIR/config.json','utf8')).uiPort||4600)}catch{console.log(4600)}")"

USAGE='Usage: bash .pipeline/spawn.sh "task description" [--runner claude|cursor|codex|gemini] [--sandbox] [--max-cycles n] [--max-post-tester-cycles n] [--no-ui]
   or: bash .pipeline/spawn.sh --resume --extend <n> [--runner ...] [--no-ui]'

RESUME=0
TASK=""
if [ "${1:-}" = "--resume" ]; then
  RESUME=1
else
  TASK="${1:-}"
  if [ -z "$TASK" ] || [[ "$TASK" == --* ]]; then
    echo "$USAGE" >&2
    exit 2
  fi
  shift
fi

NO_UI=0
ORCH_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-ui) NO_UI=1 ;;
    *) ORCH_ARGS+=("$1") ;;
  esac
  shift
done

# Guardrail 3: pre-flight mutex check. A lock owned by a dead process (kill -9,
# crash, reboot) is cleared automatically; a live one blocks.
if [ -f "$PIPELINE_DIR/.lock" ]; then
  LOCK_PID="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIPELINE_DIR/.lock','utf8')).pid||'')}catch{console.log('')}")"
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "[spawn] Pipeline is locked by a running orchestrator (pid $LOCK_PID). Retry after it finishes." >&2
    exit 1
  fi
  echo "[spawn] Clearing stale lock (owning process is gone)."
  rm -f "$PIPELINE_DIR/.lock"
fi

# Find a dashboard for THIS repo: reuse a healthy server whose /healthz
# repoRoot matches, skip ports serving other repos, start on the first free one.
UI_PORT="$BASE_PORT"
if [ "$NO_UI" -eq 0 ]; then
  FOUND=0
  for PORT in $(seq "$BASE_PORT" $((BASE_PORT + 20))); do
    HEALTH="$(curl -sf --max-time 1 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
    if [ -z "$HEALTH" ]; then
      UI_PORT="$PORT"
      echo "[spawn] Starting dashboard at http://localhost:$UI_PORT ..."
      (cd "$REPO_ROOT" && PIPELINE_UI_PORT="$UI_PORT" nohup node pipeline/ui-server.mjs > "$PIPELINE_DIR/ui-server.out" 2>&1 & echo $! > "$PIPELINE_DIR/ui-server.pid")
      sleep 0.5
      FOUND=1
      break
    fi
    SERVED_ROOT="$(node -e "try{console.log(JSON.parse(process.argv[1]).repoRoot||'')}catch{console.log('')}" "$HEALTH")"
    if [ "$SERVED_ROOT" = "$REPO_ROOT" ]; then
      UI_PORT="$PORT"
      FOUND=1
      break
    fi
    # Healthy server for a different repo — try the next port.
  done
  if [ "$FOUND" -eq 0 ]; then
    echo "[spawn] No free port in $BASE_PORT-$((BASE_PORT + 20)); continuing without dashboard." >&2
    NO_UI=1
  else
    echo "[spawn] Live dashboard: http://localhost:$UI_PORT"
  fi
fi

cd "$REPO_ROOT"
set +e
if [ "$RESUME" -eq 1 ]; then
  PIPELINE_UI_PORT="$UI_PORT" node pipeline/orchestrator.mjs "${ORCH_ARGS[@]}"
else
  PIPELINE_UI_PORT="$UI_PORT" node pipeline/orchestrator.mjs --task "$TASK" "${ORCH_ARGS[@]+"${ORCH_ARGS[@]}"}"
fi
EXIT_CODE=$?
set -e

echo ""
if [ -f "$PIPELINE_DIR/review_report.md" ]; then
  echo "[spawn] Final review: .pipeline/review_report.md"
elif [ -f "$PIPELINE_DIR/checker_report.md" ]; then
  echo "[spawn] Pipeline halted — inspect .pipeline/checker_report.md and .pipeline/changes.md"
fi
exit $EXIT_CODE
