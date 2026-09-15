#!/usr/bin/env bash
# Lightweight bootstrap launcher for OpenCode Prime installer

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY_FILE="$SCRIPT_DIR/src/index.ts"

IS_INFO_CMD=false
for arg in "$@"; do
    if [ "$arg" = "status" ] || [ "$arg" = "version" ] || [ "$arg" = "--help" ] || [ "$arg" = "-h" ] || [ "$arg" = "help" ] || [ "$arg" = "unregister" ] || [ "$arg" = "session" ] || [ "$arg" = "auth" ] || [ "$arg" = "desktop" ] || [ "$arg" = "code" ] || [ "$arg" = "project" ] || [ "$arg" = "provider" ]; then
        IS_INFO_CMD=true
    fi
done

# 0. Check for OpenCode CLI and offer automated install if missing (only for installation workflows)
if [ "$IS_INFO_CMD" = false ] && ! command -v opencode >/dev/null 2>&1; then
    echo ""
    echo "============================================================"
    echo "  ⚠️  OpenCode CLI was not found in your PATH"
    echo "============================================================"
    echo ""
    echo "OpenCode is required to run agents, commands, and workflows."
    
    INSTALL_OPENCODE=false
    for arg in "$@"; do
        if [ "$arg" = "-Yes" ] || [ "$arg" = "--yes" ] || [ "$arg" = "-y" ]; then
            INSTALL_OPENCODE=true
        fi
    done
    
    if [ "$INSTALL_OPENCODE" = false ] && [ -t 0 ]; then
        read -r -p "Would you like to install OpenCode CLI automatically now? [Y/n] " choice
        case "$choice" in
            [nN][oO]|[nN])
                INSTALL_OPENCODE=false
                ;;
            *)
                INSTALL_OPENCODE=true
                ;;
        esac
    fi
    
    if [ "$INSTALL_OPENCODE" = true ]; then
        echo -e "\n🚀 Installing OpenCode CLI via official installer..."
        if curl -fsSL https://opencode.ai/install | bash; then
            export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH"
            echo -e "✔ OpenCode CLI installed successfully!\n"
        else
            echo "⚠️ Automatic installation encountered an issue. You can install it manually from https://opencode.ai"
        fi
    else
        echo -e "ℹ️ Skipping OpenCode CLI installation. You can install it later from https://opencode.ai\n"
    fi
fi

# 0.5 Check for Bun runtime and offer automated install if missing — the
# interactive TUI (ocp dashboard / wizard) can only be hosted by Bun.
if [ "$IS_INFO_CMD" = false ] && ! command -v bun >/dev/null 2>&1; then
    echo ""
    echo "============================================================"
    echo "  ⚠️  Bun runtime was not found in your PATH"
    echo "============================================================"
    echo ""
    echo "Bun hosts the interactive TUI (ocp dashboard / wizard). Everything else also works with Node.js."

    INSTALL_BUN=false
    for arg in "$@"; do
        if [ "$arg" = "-Yes" ] || [ "$arg" = "--yes" ] || [ "$arg" = "-y" ]; then
            INSTALL_BUN=true
        fi
    done

    if [ "$INSTALL_BUN" = false ] && [ -t 0 ]; then
        read -r -p "Would you like to install Bun automatically now? [Y/n] " choice
        case "$choice" in
            [nN][oO]|[nN])
                INSTALL_BUN=false
                ;;
            *)
                INSTALL_BUN=true
                ;;
        esac
    fi

    if [ "$INSTALL_BUN" = true ]; then
        echo -e "\n🚀 Installing Bun via official installer..."
        # Capture first, then pipe: `curl | bash` would report bash's status,
        # so a dead curl would feed bash empty stdin and "succeed". Honor a
        # custom BUN_INSTALL like bun's own installer does.
        if BUN_INSTALL_SCRIPT="$(curl -fsSL https://bun.sh/install)" && printf '%s' "$BUN_INSTALL_SCRIPT" | bash; then
            export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
            echo -e "✔ Bun installed successfully!\n"
        else
            echo "⚠️ Automatic installation encountered an issue. Install Bun manually: curl -fsSL https://bun.sh/install | bash"
        fi
    else
        echo -e "ℹ️ Skipping Bun installation. The TUI dashboard/wizard will stay unavailable; run this installer again to install it later.\n"
    fi
fi

# 1. In a git/dev checkout, prefer source whenever TypeScript/plugin files are
# newer than the bundled engine; otherwise a stale ignored install/dist/index.js
# can hide fixes. Release installs still use the bundle for instant startup.
BUNDLED_FILE="$SCRIPT_DIR/dist/index.js"
SRC_FILE="$SCRIPT_DIR/src/index.ts"
USE_SOURCE=false
if [ -f "$SRC_FILE" ]; then
    if [ ! -f "$BUNDLED_FILE" ]; then
        USE_SOURCE=true
    elif find "$REPO_ROOT/install/src" "$REPO_ROOT/plugins" -type f \( -name '*.ts' -o -name '*.tsx' \) -newer "$BUNDLED_FILE" 2>/dev/null | grep -q .; then
        USE_SOURCE=true
    fi
fi

if [ "$USE_SOURCE" = true ]; then
    if command -v bun >/dev/null 2>&1; then
        exec bun run "$SRC_FILE" "$@"
    fi
    if command -v node >/dev/null 2>&1; then
        if [ ! -d "$REPO_ROOT/node_modules" ]; then
            echo "Installing installer dependencies via npm..."
            npm install --prefix "$REPO_ROOT"
        fi
        exec npx --prefix "$REPO_ROOT" tsx "$SRC_FILE" "$@"
    fi
fi

if [ -f "$BUNDLED_FILE" ]; then
    if command -v bun >/dev/null 2>&1; then
        exec bun "$BUNDLED_FILE" "$@"
    fi
    if command -v node >/dev/null 2>&1; then
        exec node "$BUNDLED_FILE" "$@"
    fi
fi

# 2. Try Bun with source files
if command -v bun >/dev/null 2>&1; then
    exec bun run "$SRC_FILE" "$@"
fi

# 3. Try Node.js + tsx
if command -v node >/dev/null 2>&1; then
    if [ ! -d "$REPO_ROOT/node_modules" ]; then
        echo "Installing installer dependencies via npm..."
        npm install --prefix "$REPO_ROOT"
    fi
    exec npx --prefix "$REPO_ROOT" tsx "$SRC_FILE" "$@"
fi

# 3. Neither found — print friendly instructions
echo ""
echo "============================================================"
echo "  Runtime Missing: Bun or Node.js is required to install"
echo "============================================================"
echo ""
echo "Please install Bun (recommended) or Node.js:"
echo "  • Bun: curl -fsSL https://bun.sh/install | bash"
echo "  • Node: https://nodejs.org/"
echo ""
exit 1
