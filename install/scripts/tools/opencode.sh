#!/bin/sh
# install/scripts/tools/opencode.sh — install/upgrade opencode PINNED TO v1
# for the current POSIX platform (darwin/linux, x86_64/aarch64). Referenced
# from install/tools.jsonc as "@script:opencode"; resolved by
# runInstallCommand in install/src/installer.ts. Also invoked directly by
# install/install.sh (the bootstrap opencode auto-install).
#
# Why pinned: OpenCode Prime's plugins and @opencode-ai/* dependencies target
# the opencode v1 API surface. A v2 binary breaks them at runtime, so this
# script NEVER installs v2:
#   - it resolves the newest v1 tag (not "latest overall") and passes it to
#     the official installer via --version;
#   - it REFUSES (exit 1) when a v2+ binary is already on PATH instead of
#     overwriting or shadowing it — downgrading a user's binary without
#     consent would be destructive;
#   - it re-verifies the binary major after install (TOCTOU guard).
#
# Behavior:
#   - opencode v2+ on PATH → refuse, exit 1, print the downgrade path.
#   - opencode v1 on PATH but outside the user profile (another manager owns
#     it, e.g. brew/choco) → exit 2 (benign refusal, same convention as
#     tgrep.sh/ripgrep.sh: `ocp update` reports it as externally managed).
#   - Otherwise resolve the newest v1 release of anomalyco/opencode
#     (OCP_API_MIRROR-aware, pinned fallback when the API is unreachable)
#     and install exactly that version via the official installer.
#   - Already at the resolved version → exit 0 without downloading.

set -e

REPO="anomalyco/opencode"
# Known-good v1 release — fallback ONLY when the GitHub API is unreachable
# (rate-limit, CN network). Stale-but-v1 beats newest-but-v2 every time;
# `ocp update` moves it forward within v1 afterwards.
V1_FALLBACK="1.18.32"

semver_of() {
  # First semver-looking token of a `--version` output ("opencode 1.18.32" → 1.18.32).
  printf '%s' "$1" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true
}

major_of() {
  printf '%s' "$1" | cut -d. -f1
}

# 0. Refuse v2+: never touch, never shadow, never "upgrade" a v2 binary.
if command -v opencode >/dev/null 2>&1; then
  installed="$(semver_of "$(opencode --version 2>/dev/null || true)")"
  installed_major="$(major_of "$installed")"
  if [ -n "$installed_major" ] && [ "$installed_major" != "1" ]; then
    echo "[ocp] REFUSED: opencode v$installed is installed, but OpenCode Prime is locked to opencode v1 (v2 breaks OCP plugins and the v1 SDK)." >&2
    echo "[ocp] To use OCP: uninstall opencode v$installed, install the newest v1 (see https://github.com/$REPO/releases), then re-run." >&2
    exit 1
  fi
  # v1 owned by another manager — don't shadow it, same convention as tgrep.sh.
  cmd="$(command -v opencode)"
  case "$cmd" in
    "$HOME"/*) ;;
    *)
      echo "[ocp] opencode v$installed found at $cmd - outside your user profile, so ocp will not touch it."
      exit 2
      ;;
  esac
else
  installed=""
fi

# 1. Resolve the newest v1 tag (API lists newest-first; first v1 wins).
#    OCP_API_MIRROR (ghproxy-style prefix) is tried first when set.
api_path="https://api.github.com/repos/$REPO/releases?per_page=100"
mirror="$(printf '%s' "${OCP_API_MIRROR:-}" | sed 's|/*$||')"
tag=""
for base in ${mirror:+"$mirror/$api_path"} "$api_path"; do
  [ -n "$base" ] || continue
  tag="$(curl -fsSL --max-time 20 "$base" 2>/dev/null | grep -o '"tag_name": *"v1[^"]*"' | head -n 1 | sed 's/.*"v//;s/"//' || true)"
  [ -n "$tag" ] && break
done
if [ -z "$tag" ]; then
  tag="$V1_FALLBACK"
  echo "[ocp] Could not reach the GitHub API — falling back to pinned v1 release v$tag."
fi
# Strip a leading 'v' if the API ever returns one unquoted oddly; the
# official installer accepts both but canonicalizes without it.
tag="${tag#v}"

# 2. Idempotence: already at the resolved v1 → nothing to do.
if [ -n "$installed" ] && [ "$installed" = "$tag" ]; then
  echo "[ocp] opencode v$installed already installed (newest v1)."
  exit 0
fi

# 3. Install exactly the resolved v1 via the official installer.
echo "[ocp] Installing opencode v$tag (newest v1; OCP is locked to major 1)..."
if ! curl -fsSL https://opencode.ai/install | bash -s -- --version "$tag"; then
  echo "[ocp] opencode v$tag installation failed." >&2
  exit 1
fi

# 4. TOCTOU verify: the binary on PATH must be v1 after install.
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
now="$(semver_of "$(opencode --version 2>/dev/null || true)")"
now_major="$(major_of "$now")"
if [ "$now_major" != "1" ]; then
  echo "[ocp] Post-install check FAILED: opencode reports '${now:-unknown}', expected v1. A new major was published mid-install or another opencode shadows PATH ($(command -v opencode || echo 'not found'))." >&2
  exit 1
fi
echo "[ocp] opencode v$now installed."
