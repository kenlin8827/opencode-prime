#!/usr/bin/env bash
# Verify release artifacts against the version manifest.
#
# Cross-checks dist/opencode-prime-<version>
# archives against install/versions/<version>.manifest.txt:
#
#   1. File-list completeness — every manifest entry plus the bundled
#      install/bin companion files must exist in the archive, with no
#      unexpected extras.
#   2. Content integrity — sha256 of every manifest file inside the
#      archive must match the repository working tree.
#
# Reads install/version.json (falling back to install/VERSION) to pick the
# version, exactly like pack.sh.
# Run this after scripts/pack.sh and before publishing a release.
#
# Usage: bash scripts/verify.sh [dist-dir]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="${1:-$REPO_ROOT/dist}"
VERSION_FILE="$REPO_ROOT/install/VERSION"
INST_DIR="$REPO_ROOT/install/versions"

# --- read version ---------------------------------------------------------

# version.json is authoritative; a legacy install/VERSION is tolerated as fallback.
VERSION_JSON="$REPO_ROOT/install/version.json"
VER=""
if [[ -f "$VERSION_JSON" ]]; then
    VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VERSION_JSON" | head -n 1 | tr -d ' \r')"
fi
if [[ -z "$VER" ]]; then
    [[ -f "$VERSION_FILE" ]] || { echo "missing install/version.json or install/VERSION" >&2; exit 1; }
    VER="$(tr -d '\r\n ' < "$VERSION_FILE")"
fi
MANIFEST="$INST_DIR/$VER.manifest.txt"
[[ -f "$MANIFEST" ]] || { echo "missing manifest for version $VER: $MANIFEST" >&2; exit 1; }

# --- prompt budget gate (layered disclosure: L0/L1 sizes) -------------------

if command -v bun >/dev/null 2>&1; then
    bun run "$REPO_ROOT/scripts/measure-prompts.ts" || { echo "prompt budget gate failed — slim the prompts before releasing" >&2; exit 1; }
else
    echo "warn: bun not found — skipping prompt budget gate" >&2
fi

# --- historical manifest immutability gate --------------------------------
# Manifests are per-version historical records: manifest generation MUST only ever
# (re)write the CURRENT version's file. Any modification or deletion of a
# previously committed manifest means generate was run against a stale
# version.json — restore the file from git before releasing.
# Legitimate exceptions: deleting manifests below `minVersion` and rewriting
# history.manifest.txt — that is the intended compaction flow.
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    CUR_REL="install/versions/$VER.manifest.txt"
    MIN_VER="$(sed -n 's/.*"minVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VERSION_JSON" | head -n 1 | tr -d ' \r')"
    # The current version's manifest is the release in progress — it may
    # legitimately differ from HEAD (or be untracked). Historical ones may not.
    VIOLATIONS=""
    while IFS= read -r v; do
        [[ -z "$v" || "$v" == "$CUR_REL" ]] && continue
        # legal compaction: history manifest rewrite, or deletion below the floor
        [[ "$v" == "install/versions/history.manifest.txt" ]] && continue
        if [[ -n "$MIN_VER" && "$v" =~ ^install/versions/([0-9]+(\.[0-9]+)+)\.manifest\.txt$ ]]; then
            if printf '%s\n%s\n' "${BASH_REMATCH[1]}" "$MIN_VER" | sort -C -V; then
                [[ "${BASH_REMATCH[1]}" != "$MIN_VER" ]] && continue
            fi
        fi
        VIOLATIONS+="$v"$'\n'
    done < <({ git -C "$REPO_ROOT" diff --name-only HEAD -- install/versions/; git -C "$REPO_ROOT" ls-files --deleted -- install/versions/; } | sort -u)
    if [[ -n "$VIOLATIONS" ]]; then
        while IFS= read -r v; do [[ -n "$v" ]] && echo "  IMMUTABILITY VIOLATION: $v" >&2; done <<< "$VIOLATIONS"
        echo "historical manifest(s) modified relative to HEAD - restore with 'git show HEAD:<file> > <file>' and re-run generate only after bumping version.json" >&2
        exit 1
    fi
    echo "historical manifests: immutable (OK)"
fi

# manifest entries (skip comments/blank lines)
manifest_entries() {
    grep -v '^[[:space:]]*#' "$MANIFEST" | sed 's/[[:space:]]*$//' | grep -v '^$' | sort -u
}

# dynamically scan all companion files (install/, bin/, package.json)
extras() {
    (cd "$REPO_ROOT" && find install -type f ! -path '*/.*' ! -path '*/node_modules/*' ! -path '*/tests/*' ! -path '*/.tmp/*')
    (cd "$REPO_ROOT" && find bin -type f ! -path '*/.*')
    [[ -f "$REPO_ROOT/package.json" ]] && echo "package.json"
}

EXPECTED="$( { manifest_entries; extras; } | sort -u )"

WORK="$DIST_DIR/.verify-tmp"
rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

verify_archive() {
    local archive="$1" extract_dir="$2" name
    name="$(basename "$archive")"
    if [[ ! -f "$archive" ]]; then
        echo "=== $name === NOT FOUND"
        FAILURES=$((FAILURES + 1))
        return
    fi

    mkdir -p "$extract_dir"
    case "$archive" in
        *.zip)  unzip -q "$archive" -d "$extract_dir" ;;
        *.tar.gz) tar -xzf "$archive" -C "$extract_dir" ;;
        *) echo "unsupported archive type: $archive" >&2; exit 1 ;;
    esac

    # package root is the single top-level directory inside the archive
    local pkg_root
    pkg_root="$(find "$extract_dir" -mindepth 1 -maxdepth 1 | head -1)"
    [[ -d "$pkg_root" ]] || pkg_root="$extract_dir"

    local actual missing extra
    actual="$(cd "$pkg_root" && find . -type f | sed 's|^\./||' | sort -u)"

    missing="$(comm -23 <(printf '%s\n' "$EXPECTED") <(printf '%s\n' "$actual"))"
    extra="$(comm -13 <(printf '%s\n' "$EXPECTED") <(printf '%s\n' "$actual"))"

    echo "=== $name ==="
    echo "expected: $(printf '%s\n' "$EXPECTED" | wc -l | tr -d ' '), actual: $(printf '%s\n' "$actual" | wc -l | tr -d ' ')"
    if [[ -n "$missing" ]]; then
        while IFS= read -r f; do echo "  MISSING: $f"; FAILURES=$((FAILURES + 1)); done <<< "$missing"
    fi
    if [[ -n "$extra" ]]; then
        while IFS= read -r f; do echo "  UNEXPECTED: $f"; FAILURES=$((FAILURES + 1)); done <<< "$extra"
    fi
    [[ -z "$missing" && -z "$extra" ]] && echo "file list: OK"

    # content integrity: hash every manifest file against the repo source
    local diffs=0 rel h1 h2
    while IFS= read -r rel; do
        [[ -f "$pkg_root/$rel" ]] || continue # already reported as missing
        h1="$(sha256_of "$REPO_ROOT/$rel")"
        h2="$(sha256_of "$pkg_root/$rel")"
        if [[ "$h1" != "$h2" ]]; then
            echo "  CONTENT DIFF: $rel"
            diffs=$((diffs + 1))
            FAILURES=$((FAILURES + 1))
        fi
    done < <(manifest_entries)
    [[ $diffs -eq 0 ]] && echo "content integrity: OK ($(manifest_entries | wc -l | tr -d ' ') files)"
    echo ''
}

verify_archive "$DIST_DIR/opencode-prime-$VER.zip" "$WORK/prime-zip"
verify_archive "$DIST_DIR/opencode-prime-$VER.tar.gz" "$WORK/prime-tgz"

if [[ $FAILURES -gt 0 ]]; then
    echo "verify: FAILED ($FAILURES problem(s))" >&2
    exit 1
fi
echo "verify: OK (version $VER)"
