#!/usr/bin/env bash
# Portable entrypoint for the unified agent pipeline (/orchestrate).
#
# Start a new run:
#   bash .pipeline/orchestrate.sh "task description" [--runner claude|cursor|codex|gemini] \
#     [--model-profile auto|manual] [--models JSON] [--approve-plan] [--design] [--handoff] \
#     [--sandbox] [--max-cycles n] [--max-post-tester-cycles n] [--no-ui]
#
# Resume an interrupted or stale run:
#   bash .pipeline/orchestrate.sh --resume [--runner ...] [--no-ui]
#
# Extend a run that halted with MAX_CYCLES (continues the same fix loop,
# repeatable as many times as needed):
#   bash .pipeline/orchestrate.sh --resume --extend <n> [--runner ...] [--no-ui]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PIPELINE_DIR="$SCRIPT_DIR"

# Determine JS runtime (prefer bun over node as per workspace guidelines)
if command -v bun >/dev/null 2>&1; then
  JS_RUNNER="bun"
else
  JS_RUNNER="node"
fi

BASE_PORT="$("$JS_RUNNER" -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIPELINE_DIR/config.json','utf8')).uiPort||4600)}catch{console.log(4600)}")"

USAGE='Usage: bash .pipeline/orchestrate.sh "task description" [--runner claude|cursor|codex|gemini|host] [--mode chat|cli] [--model-profile auto|manual] [--models JSON] [--approve-plan] [--design] [--handoff] [--sandbox] [--max-cycles n] [--max-post-tester-cycles n] [--no-ui]
   or: bash .pipeline/orchestrate.sh --continue
   or: bash .pipeline/orchestrate.sh --resume [--extend <n>] [--runner ...] [--no-ui]'

RESUME=0
CONTINUE=0
TASK=""
if [ "${1:-}" = "--resume" ]; then
  RESUME=1
elif [ "${1:-}" = "--continue" ]; then
  CONTINUE=1
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

# Guardrail 3: pre-flight mutex check. Allow --continue when awaiting chat handoff.
if [ -f "$PIPELINE_DIR/.lock" ] && [ "$CONTINUE" -eq 0 ]; then
  LOCK_PID="$("$JS_RUNNER" -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIPELINE_DIR/.lock','utf8')).pid||'')}catch{console.log('')}")"
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "[orchestrate] Pipeline is locked by a running orchestrator (pid $LOCK_PID). Retry after it finishes." >&2
    exit 1
  fi
  echo "[orchestrate] Clearing stale lock (owning process is gone)."
  rm -f "$PIPELINE_DIR/.lock"
fi

# Find a dashboard for THIS repo: reuse any healthy pipeline-ui server on ports.
UI_PORT="$BASE_PORT"
if [ "$NO_UI" -eq 1 ]; then
  UI_PORT="disabled"
  rm -f "$PIPELINE_DIR/ui.url"
else
  FOUND=0
  for PORT in $(seq "$BASE_PORT" $((BASE_PORT + 20))); do
    HEALTH="$(curl -sf --max-time 1 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
    if [ -n "$HEALTH" ]; then
      IS_PIPELINE_UI="$("$JS_RUNNER" -e "try{console.log(JSON.parse(process.argv[1]).service||'')}catch{console.log('')}" "$HEALTH")"
      if [ "$IS_PIPELINE_UI" = "pipeline-ui" ]; then
        # Register this repoRoot with the running server
        REG_RESPONSE="$(curl -sf -H "Content-Type: application/json" -d "{\"repoRoot\":\"$REPO_ROOT\"}" "http://127.0.0.1:$PORT/api/register" 2>/dev/null || true)"
        IS_OK="$("$JS_RUNNER" -e "try{console.log(JSON.parse(process.argv[1]).ok?1:0)}catch{console.log(0)}" "$REG_RESPONSE")"
        if [ "$IS_OK" -eq 1 ]; then
          UI_PORT="$PORT"
          FOUND=1
          break
        fi
      fi
      continue
    fi

    # Port health check returned empty. Verify if the port is physically in use (zombie/other app).
    PORT_FREE="$("$JS_RUNNER" -e "
      const net = require('net');
      const server = net.createServer();
      server.once('error', () => process.exit(1));
      server.once('listening', () => { server.close(); process.exit(0); });
      server.listen($PORT, '127.0.0.1');
    " 2>/dev/null && echo "1" || echo "0")"

    if [ "$PORT_FREE" = "1" ]; then
      UI_PORT="$PORT"
      echo "[orchestrate] Starting dashboard at http://localhost:$UI_PORT ..."
      (cd "$REPO_ROOT" && PIPELINE_UI_PORT="$UI_PORT" nohup "$JS_RUNNER" pipeline/ui-server.mjs > "$PIPELINE_DIR/ui-server.out" 2>&1 & echo $! > "$PIPELINE_DIR/ui-server.pid")
      
      # Poll /healthz to make sure it started successfully and is responsive
      START_OK=0
      for RETRY in $(seq 1 15); do
        sleep 0.2
        # Check if the process is still running
        PID_FILE="$PIPELINE_DIR/ui-server.pid"
        if [ -f "$PID_FILE" ]; then
          PID="$(cat "$PID_FILE")"
          if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
            # Process died immediately
            break
          fi
        fi

        NEW_HEALTH="$(curl -sf --max-time 1 "http://127.0.0.1:$UI_PORT/healthz" 2>/dev/null || true)"
        if [ -n "$NEW_HEALTH" ]; then
          NEW_SERVICE="$("$JS_RUNNER" -e "try{console.log(JSON.parse(process.argv[1]).service||'')}catch{console.log('')}" "$NEW_HEALTH")"
          if [ "$NEW_SERVICE" = "pipeline-ui" ]; then
            # Register this repoRoot with the newly started server
            curl -sf -H "Content-Type: application/json" -d "{\"repoRoot\":\"$REPO_ROOT\"}" "http://127.0.0.1:$UI_PORT/api/register" >/dev/null 2>&1 || true
            START_OK=1
            break
          fi
        fi
      done

      if [ "$START_OK" -eq 1 ]; then
        FOUND=1
        break
      else
        echo "[orchestrate] Warning: Dashboard failed to start on port $UI_PORT. Cleaning up and trying next port." >&2
        # Clean up failed process
        PID_FILE="$PIPELINE_DIR/ui-server.pid"
        if [ -f "$PID_FILE" ]; then
          PID="$(cat "$PID_FILE")"
          if [ -n "$PID" ]; then
            kill "$PID" 2>/dev/null || true
          fi
          rm -f "$PID_FILE"
        fi
      fi
    fi
  done

  if [ "$FOUND" -eq 0 ]; then
    echo "[orchestrate] No free port in $BASE_PORT-$((BASE_PORT + 20)); continuing without dashboard." >&2
    NO_UI=1
    rm -f "$PIPELINE_DIR/ui.url"
    UI_PORT="disabled"
  else
    ENCODED_ROOT="$("$JS_RUNNER" -e "console.log(encodeURIComponent(process.argv[1]))" "$REPO_ROOT")"
    echo "[orchestrate] Live dashboard: http://localhost:$UI_PORT/?project=$ENCODED_ROOT"
    echo "http://localhost:$UI_PORT/?project=$ENCODED_ROOT" > "$PIPELINE_DIR/ui.url"
  fi
fi

# Detect IDE chat invocation (host mode) for user-facing guidance.
is_chat_invocation() {
  "$JS_RUNNER" -e "
    const e = process.env;
    if (e.PIPELINE_INVOCATION === 'chat') process.exit(0);
    if (e.PIPELINE_INVOCATION === 'cli') process.exit(1);
    if (e.CURSOR_AGENT === '1' || e.CLAUDE_CODE === '1' || e.CLAUDECODE) process.exit(0);
    if (e.CI === 'true' || e.GITHUB_ACTIONS) process.exit(1);
    if (process.stdout.isTTY && process.stdin.isTTY) process.exit(1);
    if (e.VSCODE_PID && !process.stdout.isTTY) process.exit(0);
    process.exit(1);
  "
}

print_dashboard_banner() {
  [ "$NO_UI" -eq 0 ] || return 0
  local url="http://localhost:$UI_PORT"
  echo ""
  echo "================================================================"
  echo "  LIVE DASHBOARD (open in your browser to follow progress)"
  echo "  $url"
  echo "================================================================"
  if is_chat_invocation; then
    echo ""
    echo "  Chat mode: the orchestrator hands each stage to this chat."
    echo "  Use the dashboard for stage status, checker results, and artifacts."
    echo "  After each handoff, complete the stage here, then run --continue."
    echo ""
  fi
}

if is_chat_invocation || [ "$NO_UI" -eq 0 ]; then
  print_dashboard_banner
fi

cd "$REPO_ROOT"
set +e
if [ "$CONTINUE" -eq 1 ]; then
  PIPELINE_UI_PORT="$UI_PORT" "$JS_RUNNER" pipeline/orchestrator.mjs --continue "${ORCH_ARGS[@]+"${ORCH_ARGS[@]}"}"
elif [ "$RESUME" -eq 1 ]; then
  PIPELINE_UI_PORT="$UI_PORT" "$JS_RUNNER" pipeline/orchestrator.mjs "${ORCH_ARGS[@]}"
else
  PIPELINE_UI_PORT="$UI_PORT" "$JS_RUNNER" pipeline/orchestrator.mjs --task "$TASK" "${ORCH_ARGS[@]+"${ORCH_ARGS[@]}"}"
fi
EXIT_CODE=$?
set -e

echo ""
if [ -f "$PIPELINE_DIR/review_report.md" ]; then
  echo "[orchestrate] Final review: .pipeline/review_report.md"
  if [ -f "$PIPELINE_DIR/ui.url" ]; then
    echo "[orchestrate] Dashboard: $(cat "$PIPELINE_DIR/ui.url")"
  fi
elif [ -f "$PIPELINE_DIR/stage-handoff.json" ]; then
  echo "[orchestrate] ── Chat handoff (expected in IDE chat mode) ─────────────"
  echo "[orchestrate] 1. Complete the stage in this chat (see .pipeline/stage-handoff.json)"
  echo "[orchestrate] 2. Then run: bash .pipeline/orchestrate.sh --continue"
  if [ -f "$PIPELINE_DIR/ui.url" ]; then
    echo "[orchestrate] Dashboard: $(cat "$PIPELINE_DIR/ui.url")"
  elif [ "$NO_UI" -eq 0 ]; then
    echo "[orchestrate] Dashboard: http://localhost:$UI_PORT"
  fi
  echo "[orchestrate] ────────────────────────────────────────────────────────"
elif [ -f "$PIPELINE_DIR/checker_report.md" ]; then
  echo "[orchestrate] Pipeline halted — inspect .pipeline/checker_report.md and .pipeline/changes.md"
  if [ -f "$PIPELINE_DIR/ui.url" ]; then
    echo "[orchestrate] Dashboard: $(cat "$PIPELINE_DIR/ui.url")"
  fi
fi
exit $EXIT_CODE
