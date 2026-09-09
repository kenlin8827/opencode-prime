#!/usr/bin/env bash
# scripts/pack.sh — build a release archive from the current repo state.
#
# Produces release archives in dist/:
#   opencode-prime-<version>.tar.gz   (for macOS / Linux / WSL)
#   opencode-prime-<version>.zip       (for Windows)
#
# Each archive contains:
#   install/version.json
#   install/options.jsonc
#   install/install.sh
#   install/install.ps1
#   install/versions/<ver>.manifest.txt   (auto-generated if missing)
#   bin/*                                 (dispatchers: opencode-prime, ocp)
#   <every file listed in the manifest>    (prompts/, plugins/, etc.)
#
# Usage:
#   ./scripts/pack.sh                    # build both tar.gz + zip
#   ./scripts/pack.sh --tar               # only tar.gz
#   ./scripts/pack.sh --zip              # only zip
#   ./scripts/pack.sh --out /tmp/dist    # custom output directory

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION_FILE="$REPO_ROOT/install/VERSION"
INST_DIR="$REPO_ROOT/install/versions"

# --- read version --------------------------------------------------------

read_version() {
    # version.json is authoritative; a legacy install/VERSION is tolerated as fallback.
    local vj="$REPO_ROOT/install/version.json"
    if [[ -f "$vj" ]]; then
        local v
        v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$vj" | head -n 1 | tr -d ' \r')"
        if [[ -n "$v" ]]; then echo "$v"; return; fi
    fi
    if [[ -f "$VERSION_FILE" ]]; then
        head -1 "$VERSION_FILE" | tr -d '\r\n '
    else
        (cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null) || echo "unknown"
    fi
}

VERSION="$(read_version)"
MANIFEST="$INST_DIR/$VERSION.manifest.txt"

# --- read manifest -------------------------------------------------------

read_manifest() {
    [[ -f "$1" ]] || return 0
    grep -v '^\s*#' "$1" | grep -v '^\s*$' | sed 's/\\/\//g' | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# --- generate manifest if missing (inline, no dependency on install.sh) --

INCLUDE_PREFIXES=("commands/" "plugins/" "instructions/" "opencode.template.jsonc" "tui.template.jsonc" "tiers.json" "profiles/" "prompts/" "providers/" "scripts/")
EXCLUDE_PATTERNS=('^scripts/pack\.' '^scripts/verify\.')

generate_manifest() {
    local out="$1"
    : > "$out"
    while IFS= read -r -d '' file; do
        local rel="${file#"$REPO_ROOT"/}"
        rel="${rel//\\//}"
        local include=0
        for p in "${INCLUDE_PREFIXES[@]}"; do
            [[ "$rel" == "${p%/}" || "$rel" == "$p"* ]] && include=1 && break
        done
        if [[ $include -eq 1 ]]; then
            for ex in "${EXCLUDE_PATTERNS[@]}"; do
                [[ "$rel" =~ $ex ]] && include=0 && break
            done
        fi
        [[ $include -eq 1 ]] && printf '%s\n' "$rel" >> "$out"
    done < <(find "$REPO_ROOT" -type f -print0 | sort -z)
}

# --- arg parse -----------------------------------------------------------

BUILD_TAR=1
BUILD_ZIP=1
OUT_DIR="$REPO_ROOT/dist"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tar) BUILD_ZIP=0; shift ;;
        --zip) BUILD_TAR=0; shift ;;
        --out) OUT_DIR="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,28p' "$0"
            exit 0
            ;;
        *) echo "unknown arg: $1" >&2; exit 1 ;;
    esac
done

# --- main ----------------------------------------------------------------

# Resolve OUT_DIR to an absolute path now — the tar/zip steps below run from
# the staging directory, so a relative --out would break there.
OUT_DIR="$(mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"

# Ensure manifest exists
if [[ ! -f "$MANIFEST" ]]; then
    echo "manifest missing for version $VERSION, generating..."
    mkdir -p "$INST_DIR"
    generate_manifest "$MANIFEST"
    manifest_n=$(wc -l < "$MANIFEST" | tr -d ' ')
    echo "wrote $MANIFEST ($manifest_n files)"
fi

# Build a staging directory with the exact layout we want in the archive.
STAGE="$(mktemp -d)"
PKG_DIR="$STAGE/opencode-prime-$VERSION"
mkdir -p "$PKG_DIR"

# Pre-build zero-dependency bundled installer if bun is available
DIST_SRC="$REPO_ROOT/install/dist"
if command -v bun >/dev/null 2>&1; then
    echo "Building zero-dependency bundled installer..."
    bun build "$REPO_ROOT/install/src/index.ts" --outdir "$DIST_SRC" --target bun --external '@opentui/core-*'
fi

# 1. Fully mirror install/ directory
mkdir -p "$PKG_DIR/install"
(cd "$REPO_ROOT" && find install -type f ! -path '*/.*' ! -path '*/node_modules/*' ! -path '*/tests/*' | while read -r file; do
    mkdir -p "$PKG_DIR/$(dirname "$file")"
    cp "$file" "$PKG_DIR/$file"
done)

# 2. Fully mirror bin/ directory
mkdir -p "$PKG_DIR/bin"
(cd "$REPO_ROOT" && find bin -type f ! -path '*/.*' | while read -r file; do
    mkdir -p "$PKG_DIR/$(dirname "$file")"
    cp "$file" "$PKG_DIR/$file"
done)

# 3. Mirror package.json if present
if [[ -f "$REPO_ROOT/package.json" ]]; then
    cp "$REPO_ROOT/package.json" "$PKG_DIR/"
fi

# 3. Copy every file listed in the manifest
manifest_files="$(read_manifest "$MANIFEST")"
file_count=0
while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    src="$REPO_ROOT/$f"
    dst="$PKG_DIR/$f"
    if [[ ! -e "$src" ]]; then
        echo "WARN: missing source: $f" >&2
        continue
    fi
    mkdir -p "$(dirname "$dst")"
    cp -R "$src" "$dst"
    file_count=$((file_count + 1))
done <<< "$manifest_files"

echo "staged $file_count manifest file(s) + install scripts + bin dispatchers"

# Ensure POSIX execution permissions for all shell scripts and bin dispatchers
find "$PKG_DIR" -type f -name "*.sh" -exec chmod 755 {} + 2>/dev/null || true
if [[ -d "$PKG_DIR/bin" ]]; then
    find "$PKG_DIR/bin" -type f -exec chmod 755 {} + 2>/dev/null || true
fi

# 4. Build archives (opencode-prime)
PRIME_TAR="opencode-prime-$VERSION.tar.gz"
PRIME_ZIP="opencode-prime-$VERSION.zip"

if [[ $BUILD_TAR -eq 1 ]]; then
    (cd "$STAGE" && tar czf "$OUT_DIR/$PRIME_TAR" "opencode-prime-$VERSION")
    echo "built: $OUT_DIR/$PRIME_TAR"
fi

if [[ $BUILD_ZIP -eq 1 ]]; then
    (cd "$STAGE" && zip -qr "$OUT_DIR/$PRIME_ZIP" "opencode-prime-$VERSION")
    echo "built: $OUT_DIR/$PRIME_ZIP"
fi

# Clean up
rm -rf "$STAGE"

echo "done (version: $VERSION, files: $file_count)"
