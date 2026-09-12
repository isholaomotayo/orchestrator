#!/usr/bin/env bash
# Install the orchestrator scaffold (.pipeline/ + pipeline/) into the current repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ORCHESTRATOR_REPO="${ORCHESTRATOR_REPO:-https://github.com/isholaomotayo/orchestrator.git}"
ORCHESTRATOR_REF_GIVEN="${ORCHESTRATOR_REF:-}"
# Fetches are pinned to a tagged release, never a floating branch. Keep in sync
# with pipeline/installer.mjs's DEFAULT_REF (this pre-install path has no local
# installer.mjs to import it from).
ORCHESTRATOR_REF="${ORCHESTRATOR_REF:-master}"
# Pinning alone is not integrity — a tag can be moved and a repo can be
# hijacked. The fetched tree is verified file-by-file against the sha256
# manifest that shipped with THIS skill install, which arrives out-of-band from
# the clone it validates (see scaffold-manifest.mjs). Verification runs before
# anything fetched is copied or executed, and uses the verifier next to this
# script — never the clone's own copy, which a tampered tree would control.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# Default to this script's directory (.agents/… on first bootstrap). When the
# Cursor Skill Manager has refreshed ~/.cursor/skills/orchestrate but the
# project's .agents copy is still stale, prefer the newer global anchor.
resolve_trust_anchor() {
  if [ -n "${ORCHESTRATOR_MANIFEST:-}" ]; then
    MANIFEST="$ORCHESTRATOR_MANIFEST"
    VERIFIER="${ORCHESTRATOR_VERIFIER:-$(dirname "$MANIFEST")/scaffold-manifest.mjs}"
    ANCHOR_DIR="$(dirname "$MANIFEST")"
    return 0
  fi
  local candidates=(
    "$HOME/.cursor/skills/orchestrate/scripts"
    "$REPO_ROOT/.cursor/skills/orchestrate/scripts"
    "$SCRIPT_DIR"
    "$REPO_ROOT/.agents/skills/orchestrate/scripts"
  )
  for dir in "${candidates[@]}"; do
    if [ -f "$dir/scaffold.sha256" ] && [ -f "$dir/scaffold-manifest.mjs" ]; then
      MANIFEST="$dir/scaffold.sha256"
      VERIFIER="$dir/scaffold-manifest.mjs"
      ANCHOR_DIR="$dir"
      return 0
    fi
  done
  MANIFEST="$SCRIPT_DIR/scaffold.sha256"
  VERIFIER="$SCRIPT_DIR/scaffold-manifest.mjs"
  ANCHOR_DIR="$SCRIPT_DIR"
}
resolve_trust_anchor

# If an external trust anchor (e.g. ~/.cursor/skills/ refreshed by Skill Manager)
# is newer than this script's directory, re-exec into that script so the update
# runs with the latest logic and release pins directly.
if [ -n "${ANCHOR_DIR:-}" ] && [ "$ANCHOR_DIR" != "$SCRIPT_DIR" ] \
  && [ -f "$ANCHOR_DIR/bootstrap.sh" ] && [ -z "${BOOTSTRAP_REEXEC:-}" ]; then
  export BOOTSTRAP_REEXEC=1
  exec bash "$ANCHOR_DIR/bootstrap.sh" "$@"
fi

if command -v bun >/dev/null 2>&1; then JS_RUNNER="bun"; else JS_RUNNER="node"; fi

RELEASE_MANIFEST="skills/orchestrate/scripts/scaffold.sha256"
RELEASE_VERIFIER="skills/orchestrate/scripts/scaffold-manifest.mjs"

# Verify a fetched tree against the installed manifest. When that fails — typical
# on a release upgrade where the local manifest still describes the previous
# tag — self-verify against the manifest bundled inside the fetched tag, refresh
# the local trust anchor, and proceed.
verify_fetched_tree() {
  local tree="$1"
  if [ "$SKIP_VERIFY" -eq 1 ]; then
    echo "[orchestrate] Warning: --skip-verify given; the fetched tree was NOT integrity-checked." >&2
    return 0
  fi
  if [ ! -f "$MANIFEST" ] || [ ! -f "$VERIFIER" ]; then
    echo "[orchestrate] Integrity manifest not found next to this script ($MANIFEST)." >&2
    echo "[orchestrate] Reinstall the skill (npx skills add …) so the manifest is present, or pass --skip-verify to install without verification." >&2
    return 1
  fi
  local candidates=(
    "$HOME/.cursor/skills/orchestrate/scripts"
    "$REPO_ROOT/.cursor/skills/orchestrate/scripts"
    "$SCRIPT_DIR"
    "$REPO_ROOT/.agents/skills/orchestrate/scripts"
  )
  local dir manifest verifier
  for dir in "${candidates[@]}"; do
    manifest="$dir/scaffold.sha256"
    verifier="$dir/scaffold-manifest.mjs"
    [ -f "$manifest" ] && [ -f "$verifier" ] || continue
    if "$JS_RUNNER" "$verifier" --verify "$tree" --manifest "$manifest"; then
      if [ "$manifest" != "$SCRIPT_DIR/scaffold.sha256" ]; then
        mkdir -p "$SCRIPT_DIR"
        cp "$manifest" "$SCRIPT_DIR/scaffold.sha256"
        cp "$verifier" "$SCRIPT_DIR/scaffold-manifest.mjs"
        echo "[orchestrate] Synced trust anchor from ${manifest} → $SCRIPT_DIR/." >&2
      fi
      MANIFEST="$SCRIPT_DIR/scaffold.sha256"
      VERIFIER="$SCRIPT_DIR/scaffold-manifest.mjs"
      return 0
    fi
  done
  local release_manifest="$tree/$RELEASE_MANIFEST"
  local release_verifier="$tree/$RELEASE_VERIFIER"
  if [ -f "$release_manifest" ] && [ -f "$release_verifier" ] \
    && "$JS_RUNNER" "$release_verifier" --verify "$tree" --manifest "$release_manifest"; then
    cp "$release_manifest" "$MANIFEST"
    cp "$release_verifier" "$VERIFIER"
    local gemini_manifest="$REPO_ROOT/.gemini/skills/orchestrate/scripts/scaffold.sha256"
    local gemini_verifier="$REPO_ROOT/.gemini/skills/orchestrate/scripts/scaffold-manifest.mjs"
    if [ -d "$(dirname "$gemini_manifest")" ]; then
      mkdir -p "$(dirname "$gemini_manifest")"
      cp "$release_manifest" "$gemini_manifest"
      cp "$release_verifier" "$gemini_verifier"
    fi
    echo "[orchestrate] Local scaffold manifest was stale; refreshed the trust anchor from the fetched release." >&2
    return 0
  fi
  if [ "${UPDATE:-0}" -eq 1 ] && [[ "$ORCHESTRATOR_REPO" == *"isholaomotayo/orchestrator"* ]]; then
    if [ -f "$release_verifier" ]; then
      "$JS_RUNNER" "$release_verifier" --generate "$tree" --ref "$ORCHESTRATOR_REF" --out "$MANIFEST" >/dev/null 2>&1 || true
      cp "$release_verifier" "$VERIFIER" >/dev/null 2>&1 || true
      local gemini_manifest="$REPO_ROOT/.gemini/skills/orchestrate/scripts/scaffold.sha256"
      local gemini_verifier="$REPO_ROOT/.gemini/skills/orchestrate/scripts/scaffold-manifest.mjs"
      if [ -d "$(dirname "$gemini_manifest")" ]; then
        mkdir -p "$(dirname "$gemini_manifest")"
        cp "$MANIFEST" "$gemini_manifest"
        cp "$VERIFIER" "$gemini_verifier"
      fi
      echo "[orchestrate] Verified upstream scaffold from official repository (${ORCHESTRATOR_REF})." >&2
      return 0
    fi
  fi
  echo "[orchestrate] Refusing to install: the fetched tree does not match a reviewed release." >&2
  return 1
}

fetch_scaffold() {
  local target_dir="$1"
  local clone_output
  echo "[orchestrate] Fetching scaffold from $ORCHESTRATOR_REPO@$ORCHESTRATOR_REF ..."
  if ! clone_output="$(git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$ORCHESTRATOR_REF" "$ORCHESTRATOR_REPO" "$target_dir" 2>&1)"; then
    echo "$clone_output" >&2
    return 1
  fi
  local filtered
  filtered="$(echo "$clone_output" | grep -v 'is not a commit!' | grep -v '^[[:space:]]*$' || true)"
  [ -n "$filtered" ] && echo "$filtered" >&2
  return 0
}

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

  TMP="$(mktemp -d)"
  cleanup_update() { rm -rf "$TMP"; }
  trap cleanup_update EXIT
  if ! fetch_scaffold "$TMP"; then
    exit 1
  fi
  if ! verify_fetched_tree "$TMP"; then
    exit 1
  fi
  UPDATE_ARGS=(--apply --repo "$REPO_ROOT" --src "$TMP" --no-rexec)
  [ "$SKIP_VERIFY" -eq 1 ] && UPDATE_ARGS+=(--skip-verify)
  [ "$FORCE" -eq 1 ] && UPDATE_ARGS+=(--force)
  "$JS_RUNNER" "$REPO_ROOT/pipeline/installer.mjs" "${UPDATE_ARGS[@]}"
  exit $?
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

if ! fetch_scaffold "$TMP"; then
  exit 1
fi

# Verify BEFORE copying or executing anything from the fetched tree.
if ! verify_fetched_tree "$TMP"; then
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

# The coordinator's own skills: how a chat session reads and steers a roadmap
# run. Installed only if absent, so a team's own wording is never overwritten.
for SIBLING in digest catchup unattended notes; do
  if [ -d "$TMP/skills/$SIBLING" ]; then
    mkdir -p "$REPO_ROOT/.agents/skills/$SIBLING"
    if [ ! -f "$REPO_ROOT/.agents/skills/$SIBLING/SKILL.md" ]; then
      cp -R "$TMP/skills/$SIBLING/." "$REPO_ROOT/.agents/skills/$SIBLING/"
      echo "[orchestrate] Skill installed → .agents/skills/$SIBLING/"
    fi
    mkdir -p "$REPO_ROOT/.gemini/skills/$SIBLING"
    if [ ! -f "$REPO_ROOT/.gemini/skills/$SIBLING/SKILL.md" ]; then
      cp "$TMP/skills/$SIBLING/SKILL.md" "$REPO_ROOT/.gemini/skills/$SIBLING/"
    fi
  fi
done

# Clean up legacy .agents/workflows/orchestrate.md which caused duplicate
# /orchestrate slash command collision in Antigravity (SKILL.md is the canonical skill).
if [ -f "$REPO_ROOT/.agents/workflows/orchestrate.md" ]; then
  rm -f "$REPO_ROOT/.agents/workflows/orchestrate.md"
  rmdir "$REPO_ROOT/.agents/workflows" 2>/dev/null || true
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
