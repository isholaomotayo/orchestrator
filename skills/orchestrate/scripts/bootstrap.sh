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

for agentFile in AGENTS.md CLAUDE.md GEMINI.md; do
  if [ -f "$TMP/$agentFile" ] && [ ! -f "$REPO_ROOT/$agentFile" ]; then
    cp "$TMP/$agentFile" "$REPO_ROOT/"
  fi
done

if [ -f "$TMP/.cursor/commands/orchestrate.md" ]; then
  mkdir -p "$REPO_ROOT/.cursor/commands"
  if [ ! -f "$REPO_ROOT/.cursor/commands/orchestrate.md" ]; then
    cp "$TMP/.cursor/commands/orchestrate.md" "$REPO_ROOT/.cursor/commands/"
  fi
fi

# Install skill into .gemini/skills/ for native Gemini CLI skill loading
if [ -d "$TMP/skills/orchestrate" ]; then
  mkdir -p "$REPO_ROOT/.gemini/skills/orchestrate"
  if [ ! -f "$REPO_ROOT/.gemini/skills/orchestrate/SKILL.md" ]; then
    cp "$TMP/skills/orchestrate/SKILL.md" "$REPO_ROOT/.gemini/skills/orchestrate/"
    cp "$TMP/skills/orchestrate/REFERENCE.md" "$REPO_ROOT/.gemini/skills/orchestrate/" 2>/dev/null || true
    echo "[orchestrate] Gemini skill installed → .gemini/skills/orchestrate/"
  fi
fi

# IMPORTANT: never copy the root skills/ dir into consumers — root
# skills/orchestrate/SKILL.md (together with pipeline/orchestrator.mjs) is the
# self-repo detection marker for the self-targeting guard. The installed paths
# below (.agents/skills/…) do NOT match the marker path, so consumers are safe.

# Install skill into .agents/skills/ (Antigravity IDE/CLI + agents-standard discovery)
if [ -d "$TMP/skills/orchestrate" ]; then
  mkdir -p "$REPO_ROOT/.agents/skills/orchestrate"
  if [ ! -f "$REPO_ROOT/.agents/skills/orchestrate/SKILL.md" ]; then
    cp -R "$TMP/skills/orchestrate/." "$REPO_ROOT/.agents/skills/orchestrate/"
    echo "[orchestrate] Agents-standard skill installed → .agents/skills/orchestrate/"
  fi
fi

# Antigravity workflow (registers /orchestrate in Antigravity chat)
if [ -f "$TMP/.agents/workflows/orchestrate.md" ]; then
  mkdir -p "$REPO_ROOT/.agents/workflows"
  if [ ! -f "$REPO_ROOT/.agents/workflows/orchestrate.md" ]; then
    cp "$TMP/.agents/workflows/orchestrate.md" "$REPO_ROOT/.agents/workflows/"
    echo "[orchestrate] Antigravity workflow installed → .agents/workflows/orchestrate.md"
  fi
fi

# Antigravity always-on rule (chat-mode mandate + isolation)
if [ -f "$TMP/.agent/rules/orchestrate.md" ]; then
  mkdir -p "$REPO_ROOT/.agent/rules"
  if [ ! -f "$REPO_ROOT/.agent/rules/orchestrate.md" ]; then
    cp "$TMP/.agent/rules/orchestrate.md" "$REPO_ROOT/.agent/rules/"
    echo "[orchestrate] Antigravity rule installed → .agent/rules/orchestrate.md"
  fi
fi

# Cursor rulebook (previously omitted)
if [ -f "$TMP/.cursorrules" ] && [ ! -f "$REPO_ROOT/.cursorrules" ]; then
  cp "$TMP/.cursorrules" "$REPO_ROOT/"
  echo "[orchestrate] Cursor rules installed → .cursorrules"
fi

if [ -f "$REPO_ROOT/.pipeline/orchestrate.sh" ]; then
  chmod +x "$REPO_ROOT/.pipeline/orchestrate.sh"
elif [ -f "$REPO_ROOT/.pipeline/spawn.sh" ]; then
  cp "$REPO_ROOT/.pipeline/spawn.sh" "$REPO_ROOT/.pipeline/orchestrate.sh"
  chmod +x "$REPO_ROOT/.pipeline/orchestrate.sh" "$REPO_ROOT/.pipeline/spawn.sh"
fi

echo "[orchestrate] Scaffold installed. Run: bash .pipeline/orchestrate.sh \"your task\""
