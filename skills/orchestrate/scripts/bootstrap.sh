#!/usr/bin/env bash
# Install the orchestrator scaffold (.pipeline/ + pipeline/) into the current repo.
set -euo pipefail

ORCHESTRATOR_REPO="${ORCHESTRATOR_REPO:-https://github.com/isholaomotayo/orchestrator.git}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

if [ -f "$REPO_ROOT/.pipeline/orchestrate.sh" ] && [ -d "$REPO_ROOT/pipeline" ]; then
  echo "[orchestrate] Pipeline scaffold already present."
  exit 0
fi

if [ -f "$REPO_ROOT/.pipeline/spawn.sh" ] && [ -d "$REPO_ROOT/pipeline" ] && [ ! -f "$REPO_ROOT/.pipeline/orchestrate.sh" ]; then
  cp "$REPO_ROOT/.pipeline/spawn.sh" "$REPO_ROOT/.pipeline/orchestrate.sh"
  chmod +x "$REPO_ROOT/.pipeline/orchestrate.sh"
  echo "[orchestrate] Migrated legacy spawn.sh → orchestrate.sh"
  exit 0
fi

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "[orchestrate] Fetching scaffold from $ORCHESTRATOR_REPO ..."
  git clone --depth 1 "$ORCHESTRATOR_REPO" "$TMP"

cp -R "$TMP/.pipeline" "$REPO_ROOT/"
cp -R "$TMP/pipeline" "$REPO_ROOT/"

if [ ! -f "$REPO_ROOT/package.json" ]; then
  cp "$TMP/package.json" "$REPO_ROOT/"
else
  node -e "
    const fs = require('fs');
    const path = require('path');
    const root = process.argv[1];
    const src = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const dstPath = path.join(root, 'package.json');
    const dst = fs.existsSync(dstPath)
      ? JSON.parse(fs.readFileSync(dstPath, 'utf8'))
      : {};
    dst.scripts = { ...(dst.scripts || {}), ...(src.scripts || {}) };
    if (!dst.description && src.description) dst.description = src.description;
    fs.writeFileSync(dstPath, JSON.stringify(dst, null, 2) + '\n');
  " "$TMP"
fi

for agentFile in AGENTS.md CLAUDE.md; do
  if [ -f "$TMP/$agentFile" ] && [ ! -f "$REPO_ROOT/$agentFile" ]; then
    cp "$TMP/$agentFile" "$REPO_ROOT/"
  fi
done

if [ -f "$REPO_ROOT/.pipeline/orchestrate.sh" ]; then
  chmod +x "$REPO_ROOT/.pipeline/orchestrate.sh"
elif [ -f "$REPO_ROOT/.pipeline/spawn.sh" ]; then
  cp "$REPO_ROOT/.pipeline/spawn.sh" "$REPO_ROOT/.pipeline/orchestrate.sh"
  chmod +x "$REPO_ROOT/.pipeline/orchestrate.sh" "$REPO_ROOT/.pipeline/spawn.sh"
fi

echo "[orchestrate] Scaffold installed. Run: bash .pipeline/orchestrate.sh \"your task\""
