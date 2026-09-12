#!/usr/bin/env bash
# scripts/install-hooks.sh
#
# Point git at the committed .githooks/ directory so the pre-commit hook runs
# automatically for everyone who has cloned the repo.
#
# Called automatically by the `prepare` npm/pnpm script (pnpm install).
# Safe to run multiple times.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
HOOKS_DIR="$REPO_ROOT/.githooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "[hooks] .githooks/ not found — skipping hook installation." >&2
  exit 0
fi

# Skip inside CI environments where there is nothing to commit.
if [ "${CI:-}" = "true" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  exit 0
fi

current="$(git -C "$REPO_ROOT" config --local core.hooksPath 2>/dev/null || true)"
if [ "$current" = ".githooks" ]; then
  exit 0
fi

git -C "$REPO_ROOT" config core.hooksPath .githooks
chmod +x "$HOOKS_DIR"/* 2>/dev/null || true
echo "[hooks] git hooks installed from .githooks/ (pre-commit: manifest auto-regen)." >&2
