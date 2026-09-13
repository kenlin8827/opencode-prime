#!/bin/sh
# install/scripts/tools/ripgrep.sh — install/upgrade ripgrep for the current
# POSIX platform (darwin/linux, x86_64/aarch64). Referenced from
# install/tools.jsonc as "@script:ripgrep"; resolved by runInstallCommand in
# install/src/installer.ts.
#
# Behavior (matches the former inline one-liner):
#   - rg outside the user profile belongs to another package manager — we
#     refuse to overwrite it and tell the user to update it there.
#   - Otherwise download the latest release into ~/.local/bin.
#   - OCP_RELEASE_MIRROR, when set, is tried before the official GitHub
#     release asset (mirror outage falls back to the official URL).

set -e

cmd=$(command -v rg || true)
case "$cmd" in
  "$HOME"/* | '')
    ;;
  *)
    hint="Update it with the tool that installed it"
    case "$cmd" in
      *homebrew* | *Cellar*) hint="Update via \`brew upgrade ripgrep\`" ;;
      /usr/bin/* | /bin/*) hint="Update via \`sudo apt upgrade ripgrep\`" ;;
    esac
    echo "[ocp] rg found at $cmd - outside your user profile, so ocp will not touch it. $hint, or uninstall it there and re-run ocp update to manage rg under \$HOME/.local/bin."
    exit 2
    ;;
esac

tag=$(curl -sIL -o /dev/null -w '%{url_effective}' https://github.com/BurntSushi/ripgrep/releases/latest | sed 's|.*/tag/||')
if [ -z "$tag" ]; then
  tag="15.2.0"
fi

arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch="x86_64" ;;
  aarch64 | arm64) arch="aarch64" ;;
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
esac

os=$(uname -s)
case "$os" in
  Darwin*) asset="$arch-apple-darwin" ;;
  Linux*) asset="$arch-unknown-linux-musl" ;;
  *) echo "Unsupported OS: $os" >&2; exit 1 ;;
esac

official="https://github.com/BurntSushi/ripgrep/releases/download/$tag/ripgrep-$tag-$asset.tar.gz"
mirror=$(printf '%s' "${OCP_RELEASE_MIRROR:-}" | sed 's|/*$||')

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "$mirror" ]; then
  if ! curl -fsSL "$mirror/$official" | tar -xz -C "$tmp"; then
    curl -fsSL "$official" | tar -xz -C "$tmp"
  fi
else
  curl -fsSL "$official" | tar -xz -C "$tmp"
fi

bin=$(find "$tmp/ripgrep-$tag-$asset" -type f -name rg | head -n 1)
if [ -z "$bin" ]; then
  echo "error: rg not found in archive" >&2
  exit 1
fi
mkdir -p "$HOME/.local/bin"
chmod +x "$bin"
mv "$bin" "$HOME/.local/bin/rg"
