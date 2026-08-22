#!/usr/bin/env bash
# Install the orchestrator scaffold (.pipeline/ + pipeline/) into the current repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ORCHESTRATOR_REPO="${ORCHESTRATOR_REPO:-https://github.com/isholaomotayo/orchestrator.git}"
# Fetches are pinned to a tagged release, never a floating branch. Keep in sync
# with pipeline/installer.mjs's DEFAULT_REF (this pre-install path has no local
# installer.mjs to import it from).
ORCHESTRATOR_REF="${ORCHESTRATOR_REF:-v1.0.1}"
# Pinning alone is not integrity — a tag can be moved and a repo can be
# hijacked. The fetched tree is verified file-by-file against the sha256
# manifest that shipped with THIS skill install, which arrives out-of-band from
# the clone it validates (see scaffold-manifest.mjs). Verification runs before
# anything fetched is copied or executed, and uses the verifier next to this
# script — never the clone's own copy, which a tampered tree would control.
MANIFEST="${ORCHESTRATOR_MANIFEST:-$SCRIPT_DIR/scaffold.sha256}"
VERIFIER="$SCRIPT_DIR/scaffold-manifest.mjs"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

if command -v bun >/dev/null 2>&1; then JS_RUNNER="bun"; else JS_RUNNER="node"; fi

UPDATE=0
FORCE=0
SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=1 ;;
    --force) FORCE=1; UPDATE=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --help|-h)
      echo "Usage: bash bootstrap.sh                install the scaffold (no-op if present)"
      echo "       bash bootstrap.sh --update       refresh engine files; keep edited prompts/docs (.new written beside them)"
      echo "       bash bootstrap.sh --force        also overwrite edited prompts/docs"
      echo "       bash bootstrap.sh --skip-verify  accept a fetched tree that does not match the shipped"
      echo "                                       integrity manifest (local development against a fork only)"
      echo ""
      echo "Fetches are pinned to $ORCHESTRATOR_REF and verified against scaffold.sha256 before anything runs."
      echo "Env: ORCHESTRATOR_REPO, ORCHESTRATOR_REF, ORCHESTRATOR_MANIFEST"
      exit 0 ;;
  esac
done

# Refreshing an installed scaffold: fetch upstream and let the installer decide
# what may be overwritten. It preserves .pipeline/config.json, run state and any
# prompt you have edited — see pipeline/installer.mjs.
if [ "$UPDATE" -eq 1 ]; then
  if [ ! -d "$REPO_ROOT/pipeline" ]; then
    echo "[orchestrate] Nothing to update — no scaffold here. Run bootstrap.sh without --update first." >&2
    exit 1
  fi
  UPDATE_ARGS=(--apply --repo "$REPO_ROOT" --source "$ORCHESTRATOR_REPO" --ref "$ORCHESTRATOR_REF")
  [ "$SKIP_VERIFY" -eq 1 ] && UPDATE_ARGS+=(--skip-verify)
  [ "$FORCE" -eq 1 ] && UPDATE_ARGS+=(--force)
  exec "$JS_RUNNER" "$REPO_ROOT/pipeline/installer.mjs" "${UPDATE_ARGS[@]}"
fi

if [ -f "$REPO_ROOT/.pipeline/orchestrate.sh" ] && [ -d "$REPO_ROOT/pipeline" ]; then
  echo "[orchestrate] Pipeline scaffold already present. Use --update to refresh it from upstream."
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

echo "[orchestrate] Fetching scaffold from $ORCHESTRATOR_REPO@$ORCHESTRATOR_REF ..."
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$ORCHESTRATOR_REF" "$ORCHESTRATOR_REPO" "$TMP"

# Verify BEFORE copying or executing anything from the fetched tree.
if [ "$SKIP_VERIFY" -eq 1 ]; then
  echo "[orchestrate] Warning: --skip-verify given; the fetched tree was NOT integrity-checked." >&2
elif [ ! -f "$MANIFEST" ] || [ ! -f "$VERIFIER" ]; then
  echo "[orchestrate] Integrity manifest not found next to this script ($MANIFEST)." >&2
  echo "[orchestrate] Reinstall the skill (npx skills add …) so the manifest is present, or pass --skip-verify to install without verification." >&2
  exit 1
elif ! "$JS_RUNNER" "$VERIFIER" --verify "$TMP" --manifest "$MANIFEST"; then
  echo "[orchestrate] Refusing to install: the fetched tree does not match the reviewed release recorded in scaffold.sha256." >&2
  echo "[orchestrate] This means the pinned tag now resolves to different content than was reviewed. Do not bypass this without understanding why." >&2
  exit 1
fi

cp -R "$TMP/.pipeline" "$REPO_ROOT/"
cp -R "$TMP/pipeline" "$REPO_ROOT/"

if [ ! -f "$REPO_ROOT/package.json" ]; then
  cp "$TMP/package.json" "$REPO_ROOT/"
else
  "$JS_RUNNER" "$TMP/pipeline/merge-package-json.mjs" "$TMP" "$REPO_ROOT"
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

# Record what was delivered, so a later --update can tell an untouched file from
# one you have edited. Uses the freshly cloned installer, not the copied one.
if [ -f "$TMP/pipeline/installer.mjs" ]; then
  "$JS_RUNNER" "$TMP/pipeline/installer.mjs" --write-manifest --src "$TMP" --repo "$REPO_ROOT" --source "$ORCHESTRATOR_REPO" \
    && echo "[orchestrate] Install manifest written → .pipeline/install.json" \
    || echo "[orchestrate] Warning: could not write install manifest; --update will refresh engine files only." >&2
fi

echo "[orchestrate] Scaffold installed ($ORCHESTRATOR_REF, integrity-verified). Run: bash .pipeline/orchestrate.sh \"your task\""
echo "[orchestrate] Updates are explicit: a run tells you when one is available; apply it with bootstrap.sh --update."
