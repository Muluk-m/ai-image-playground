#!/bin/sh
# Installs the native muvloom CLI from GitHub releases, verifying its SHA-256 checksum.
#   MUVLOOM_VERSION=0.1.0   pin a release (default: latest cli-v* release)
#   MUVLOOM_INSTALL_DIR=... install directory (default: ~/.local/bin)
set -eu

REPO="Muluk-m/ai-image-playground"
INSTALL_DIR="${MUVLOOM_INSTALL_DIR:-$HOME/.local/bin}"

fail() { echo "muvloom install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported operating system $(uname -s); supported: macOS, Linux, Windows x64" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) fail "unsupported architecture $(uname -m); supported: arm64, x86_64" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

if [ -n "${MUVLOOM_VERSION:-}" ]; then
  tag="cli-v${MUVLOOM_VERSION#v}"
else
  # Highest stable cli-vX.Y.Z by version, not API order; prerelease tags carry a suffix
  # and never match. Releases are only published for exact cli-vX.Y.Z tags.
  version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" |
    grep -o '"tag_name": *"cli-v[0-9]*\.[0-9]*\.[0-9]*"' | sed 's/.*"cli-v\([^"]*\)"/\1/' |
    sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
  [ -n "$version" ] || fail "could not find a muvloom release"
  tag="cli-v$version"
fi

asset="muvloom_${os}_${arch}"
base="https://github.com/$REPO/releases/download/$tag"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset ($tag)" >&2
curl -fsSL -o "$tmp/$asset" "$base/$asset" || fail "download failed: $base/$asset"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt" || fail "download failed: $base/checksums.txt"

expected="$(grep " $asset\$" "$tmp/checksums.txt" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "no checksum published for $asset"
actual="$(sha256 "$tmp/$asset")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"

mkdir -p "$INSTALL_DIR"
chmod 0755 "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/muvloom"

echo "muvloom installed at $INSTALL_DIR/muvloom" >&2
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add it to PATH: export PATH=\"$INSTALL_DIR:\$PATH\"" >&2 ;;
esac
"$INSTALL_DIR/muvloom" version
