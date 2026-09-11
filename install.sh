#!/usr/bin/env bash
# Remote one-line installer for OpenCode Prime (OCP)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh | bash
#
# Options:
#   -v, --version <ver>   Install a specific version (default: latest)
#
# This script downloads the latest release archive, extracts it, and runs the
# in-repo installer (install/install.sh). It is the pipe-friendly equivalent of
# the manual download-extract-install cycle documented in the README.
#
# All remaining arguments (after -v is consumed) are forwarded to the in-repo
# installer. For example:
#   curl -fsSL ... | bash -s -- -v 0.9.0 install -f -y
#   curl -fsSL ... | bash -s -- status

set -e

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
REPO="kenlin8827/opencode-prime"
RELEASE_BASE="https://github.com/${REPO}/releases/latest/download"
INSTALL_DIR="$HOME/.local/share/opencode-prime"
TMP_TAR="/tmp/ocp.tar.gz"
VERSION=""
INSTALLER_ARGS=()

# Parse -v/--version for this wrapper; forward everything else.
while [ $# -gt 0 ]; do
    case "$1" in
        -v|--version)
            VERSION="$2"; shift 2 ;;
        --version=*)
            VERSION="${1#*=}"; shift ;;
        *)
            INSTALLER_ARGS+=("$1"); shift ;;
    esac
done

# Color helpers (only if stdout is a TTY)
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

log()   { echo -e "${GREEN}[OCP]${NC} $1"; }
warn()  { echo -e "${YELLOW}[OCP]${NC} $1"; }
err()   { echo -e "${RED}[OCP ERROR]${NC} $1" >&2; }
info()  { echo -e "${CYAN}[OCP]${NC} $1"; }

# ---------------------------------------------------------------------------
# Detect platform
# ---------------------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Linux*|MINGW*|MSYS*|CYGWIN*)
        PLATFORM="linux"
        ;;
    Darwin)
        PLATFORM="macos"
        ;;
    *)
        # Fallback: treat unknown Unix-likes as Linux
        PLATFORM="linux"
        ;;
esac

info "Detected platform: ${PLATFORM} (${ARCH})"

# ---------------------------------------------------------------------------
# Build download URL (versioned or latest)
# ---------------------------------------------------------------------------
if [ -n "$VERSION" ]; then
    ARCHIVE_URL="https://github.com/${REPO}/releases/download/v${VERSION}/opencode-prime-${VERSION}.tar.gz"
    log "Downloading OpenCode Prime v${VERSION}..."
else
    ARCHIVE_URL="${RELEASE_BASE}/opencode-prime-latest.tar.gz"
    log "Downloading OpenCode Prime latest release..."
fi
log "  URL: ${ARCHIVE_URL}"

# Try curl first, then wget as fallback
if command -v curl >/dev/null 2>&1; then
    DOWNLOAD_CMD=(curl -fsSL -o "$TMP_TAR" "$ARCHIVE_URL")
elif command -v wget >/dev/null 2>&1; then
    DOWNLOAD_CMD=(wget -q -O "$TMP_TAR" "$ARCHIVE_URL")
else
    err "Neither curl nor wget found. Please install one of them:"
    err "  • curl: package manager (brew install curl / apt install curl)"
    err "  • wget: package manager (brew install wget / apt install wget)"
    exit 1
fi

if ! "${DOWNLOAD_CMD[@]}"; then
    err "Failed to download the release archive."
    err "Please check your internet connection and try again."
    err "If the problem persists, download manually from:"
    err "  https://github.com/${REPO}/releases/latest"
    exit 1
fi

log "Download complete."

# ---------------------------------------------------------------------------
# Extract
# ---------------------------------------------------------------------------
log "Extracting to ${INSTALL_DIR}..."

# Clean previous installation directory
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

if ! tar xzf "$TMP_TAR" -C "$INSTALL_DIR" --strip-components=1; then
    err "Failed to extract the archive."
    rm -f "$TMP_TAR"
    exit 1
fi

# Clean up temp file
rm -f "$TMP_TAR"

log "Extraction complete."

# ---------------------------------------------------------------------------
# Run the in-repo installer
# ---------------------------------------------------------------------------
INSTALLER="$INSTALL_DIR/install/install.sh"

if [ ! -f "$INSTALLER" ]; then
    err "Installer script not found at: ${INSTALLER}"
    err "The archive may be corrupted. Please try again."
    exit 1
fi

chmod +x "$INSTALLER"

log "Starting OpenCode Prime installer..."
echo "============================================================"

# Forward remaining arguments to the in-repo installer
exec bash "$INSTALLER" "${INSTALLER_ARGS[@]}"

