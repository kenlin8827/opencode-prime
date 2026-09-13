#!/bin/sh
# install/scripts/tools/tgrep.sh — install/upgrade tgrep for the current
# POSIX platform (darwin/linux, x86_64/aarch64). Referenced from
# install/tools.jsonc as "@script:tgrep"; resolved by runInstallCommand in
# install/src/installer.ts. See ripgrep.sh for the full behavior notes
# (user-profile guard, OCP_RELEASE_MIRROR fallback).

set -e

cmd=$(command -v tgrep || true)
case "$cmd" in
  "$HOME"/* | '')
    ;;
  *)
    hint="Update it with the tool that installed it"
    case "$cmd" in
      *homebrew* | *Cellar*) hint="Update via \`brew upgrade tgrep\`" ;;
      /usr/bin/* | /bin/*) hint="Update via \`sudo apt upgrade tgrep\`" ;;
    esac
    echo "[ocp] tgrep found at $cmd - outside your user profile, so ocp will not touch it. $hint, or uninstall it there and re-run ocp update to manage tgrep under \$HOME/.local/bin."
    exit 2
    ;;
esac

tag=$(curl -sIL -o /dev/null -w '%{url_effective}' https://github.com/microsoft/tgrep/releases/latest | sed 's|.*/tag/||')
if [ -z "$tag" ]; then
  tag="v1.0.5"
fi

arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch="x86_64" ;;
  aarch64 | arm64) arch="aarch64" ;;
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
esac

os=$(uname -s)
case "$os" in
  Darwin*) os="apple-darwin" ;;
  Linux*) os="unknown-linux-musl" ;;
  *) echo "Unsupported OS: $os" >&2; exit 1 ;;
esac

official="https://github.com/microsoft/tgrep/releases/download/$tag/tgrep-$tag-$arch-$os.tar.gz"
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

bin=$(find "$tmp" -type f -name tgrep | head -n 1)
if [ -z "$bin" ]; then
  echo "error: tgrep not found in archive" >&2
  exit 1
fi
mkdir -p "$HOME/.local/bin"
chmod +x "$bin"
mv "$bin" "$HOME/.local/bin/tgrep"
