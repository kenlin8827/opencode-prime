#!/bin/sh
# install/scripts/tools/opencode.sh — install/upgrade opencode PINNED TO v2
# for the current POSIX platform (darwin/linux, x86_64/aarch64). Referenced
# from install/tools.jsonc as "@script:opencode"; resolved by
# runInstallCommand in install/src/installer.ts. Also invoked directly by
# install/install.sh (the bootstrap opencode auto-install).
#
# Why pinned: OpenCode Prime v2's plugins, @opencode/plugin SDK and V2-native
# config contract target the opencode v2 API surface. A v1 binary cannot load
# them, so this script pins the major explicitly:
#   - it resolves the newest v2 tag (not "latest overall") and passes it to
#     the official installer via --version;
#   - a v1 binary inside the user profile is UPGRADED to the newest v2 — that
#     is the documented runtime transition (`curl https://opencode.ai/install`
#     replaces the v1 binary in place; V2 keeps the same config locations);
#   - it re-verifies the binary major after install (TOCTOU guard).
#
# Behavior:
#   - opencode v2 on PATH inside the profile → install/upgrade the resolved
#     v2 tag (idempotent when already on it).
#   - opencode on PATH outside the user profile (another manager owns it,
#     e.g. brew/choco) → exit 2 (benign refusal, same convention as
#     tgrep.sh/ripgrep.sh: `ocp update` reports it as externally managed).
#   - opencode v3+ (newer than this line knows) → refuse, exit 1 — never
#     downgrade a user's binary without consent.
#   - Otherwise resolve the newest v2 release of anomalyco/opencode
#     (OCP_API_MIRROR-aware, pinned fallback when the API is unreachable)
#     and install exactly that version via the official installer.

set -e

REPO="anomalyco/opencode"
REQUIRED_MAJOR=2
# Known-good v2 release — fallback ONLY when the GitHub API is unreachable
# (rate-limit, CN network). Stale-but-v2 beats newest-but-v3 every time;
# `ocp update` moves it forward within v2 afterwards.
V2_FALLBACK="2.0.15"

semver_of() {
  # First semver-looking token of a `--version` output ("opencode 2.0.15" → 2.0.15).
  printf '%s' "$1" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true
}

major_of() {
  printf '%s' "$1" | cut -d. -f1
}

# 0. Inspect what's on PATH.
if command -v opencode >/dev/null 2>&1; then
  installed="$(semver_of "$(opencode --version 2>/dev/null || true)")"
  installed_major="$(major_of "$installed")"
  if [ -n "$installed_major" ] && [ "$installed_major" -gt "$REQUIRED_MAJOR" ]; then
    echo "[ocp] REFUSED: opencode v$installed is newer than the major OpenCode Prime pins (v$REQUIRED_MAJOR.x). This OCP line cannot run on it — see https://github.com/kenlin8827/opencode-prime/releases for a matching release; leaving the v$installed binary untouched." >&2
    exit 1
  fi
  # Owned by another manager — don't shadow it, same convention as tgrep.sh.
  cmd="$(command -v opencode)"
  case "$cmd" in
    "$HOME"/*) ;;
    *)
      if [ -n "$installed_major" ] && [ "$installed_major" -lt "$REQUIRED_MAJOR" ]; then
        echo "[ocp] opencode v$installed at $cmd is outside your user profile and BELOW the v$REQUIRED_MAJOR runtime OCP requires. Upgrade it with the manager that owns it (brew/choco/your package manager), then re-run."
        exit 2
      fi
      echo "[ocp] opencode v$installed found at $cmd - outside your user profile, so ocp will not touch it."
      exit 2
      ;;
  esac
else
  installed=""
fi

# 1. Resolve the newest v2 tag (API lists newest-first; first v2 wins).
#    OCP_API_MIRROR (ghproxy-style prefix) is tried first when set.
api_path="https://api.github.com/repos/$REPO/releases?per_page=100"
mirror="$(printf '%s' "${OCP_API_MIRROR:-}" | sed 's|/*$||')"
tag=""
for base in ${mirror:+"$mirror/$api_path"} "$api_path"; do
  [ -n "$base" ] || continue
  tag="$(curl -fsSL --max-time 20 "$base" 2>/dev/null | grep -o '"tag_name": *"v2[^"]*"' | head -n 1 | sed 's/.*"v//;s/"//' || true)"
  [ -n "$tag" ] && break
done
if [ -z "$tag" ]; then
  tag="$V2_FALLBACK"
  echo "[ocp] Could not reach the GitHub API — falling back to pinned v2 release v$tag."
fi
# Strip a leading 'v' if the API ever returns one unquoted oddly; the
# official installer accepts both but canonicalizes without it.
tag="${tag#v}"

# 2. Idempotence: already at the resolved v2 → nothing to do.
if [ -n "$installed" ] && [ "$installed" = "$tag" ]; then
  echo "[ocp] opencode v$installed already installed (newest v2)."
  exit 0
fi

# 3. Install exactly the resolved v2 via the official installer (a v1 binary
#    in the profile is replaced in place — the documented V1→V2 path).
echo "[ocp] Installing opencode v$tag (newest v2; OCP v2 requires the v2 runtime)..."
if ! curl -fsSL https://opencode.ai/install | bash -s -- --version "$tag"; then
  echo "[ocp] opencode v$tag installation failed." >&2
  exit 1
fi

# 4. TOCTOU verify: the binary on PATH must be v2 after install.
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
now="$(semver_of "$(opencode --version 2>/dev/null || true)")"
now_major="$(major_of "$now")"
if [ "$now_major" != "$REQUIRED_MAJOR" ]; then
  echo "[ocp] Post-install check FAILED: opencode reports '${now:-unknown}', expected v$REQUIRED_MAJOR. A new major was published mid-install or another opencode shadows PATH ($(command -v opencode || echo 'not found'))." >&2
  exit 1
fi
echo "[ocp] opencode v$now installed."
