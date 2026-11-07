#!/bin/sh
# Installs the native muvloom CLI from GitHub releases, verifying its SHA-256 checksum.
#   MUVLOOM_VERSION=0.1.0   pin a release (default: latest cli-v* release)
#   MUVLOOM_INSTALL_DIR=... install directory. Default: where muvloom already is (one copy, and
#                           it is the one that runs), else /usr/local/bin when that is on PATH and
#                           writable without sudo, else ~/.local/bin. For a system-wide install
#                           that needs administrator rights: sudo MUVLOOM_INSTALL_DIR=/usr/local/bin sh
#   MUVLOOM_DISTRIBUTION_URL=http://127.0.0.1:PORT/PATH local CI distribution only
set -eu

REPO="Muluk-m/ai-image-playground"
# MUVLOOM_SYSTEM_BIN_DIR exists so the tests can stand in for /usr/local/bin.
SYSTEM_BIN_DIR="${MUVLOOM_SYSTEM_BIN_DIR:-/usr/local/bin}"

fail() { echo "muvloom install: $*" >&2; exit 1; }

api="https://api.github.com/repos/$REPO/releases"
download="https://github.com/$REPO/releases/download"
if [ -n "${MUVLOOM_DISTRIBUTION_URL:-}" ]; then
  # This test seam cannot redirect installs to a third-party distribution.
  # Require a numeric port and a path; no credentials, queries or fragments.
  printf '%s\n' "$MUVLOOM_DISTRIBUTION_URL" |
    grep -Eq '^http://127\.0\.0\.1:[0-9]+(/[A-Za-z0-9_-]+)+$' ||
    fail "distribution override must be a loopback URL with a port and path"
  api="$MUVLOOM_DISTRIBUTION_URL/releases"
  download="$MUVLOOM_DISTRIBUTION_URL"
fi

fetch() {
  # Ignore user curl config (which may contain credentials). GitHub's public
  # release CDN needs HTTPS redirects; loopback fixtures must never redirect.
  if [ -n "${MUVLOOM_DISTRIBUTION_URL:-}" ]; then
    curl -q -fsSL --max-redirs 0 --noproxy '*' "$@"
  else
    curl -q -fsSL --proto '=https' --proto-redir '=https' "$@"
  fi
}

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

# Where to install when MUVLOOM_INSTALL_DIR is not given. Agent hosts run commands in shells
# whose PATH differs from the user's terminal, and sudo is not available to them, so the choice
# favours places that need neither.
choose_install_dir() {
  if [ -n "${MUVLOOM_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$MUVLOOM_INSTALL_DIR"
    return
  fi
  # 1. Replace the copy that is already installed: otherwise the old one keeps running.
  found="$(command -v muvloom 2>/dev/null || true)"
  if [ -n "$found" ] && [ -f "$found" ] && [ -w "$(dirname -- "$found")" ]; then
    dirname -- "$found"
    return
  fi
  # 2. The system-wide directory, when every shell finds it and no sudo is needed.
  case ":$PATH:" in
    *":$SYSTEM_BIN_DIR:"*)
      if [ -d "$SYSTEM_BIN_DIR" ] && [ -w "$SYSTEM_BIN_DIR" ]; then
        printf '%s\n' "$SYSTEM_BIN_DIR"
        return
      fi
      ;;
  esac
  # 3. Per user.
  printf '%s\n' "$HOME/.local/bin"
}
INSTALL_DIR="$(choose_install_dir)"

if [ -n "${MUVLOOM_VERSION:-}" ]; then
  tag="cli-v${MUVLOOM_VERSION#v}"
else
  # Highest stable cli-vX.Y.Z by version, not API order; prerelease tags carry a suffix
  # and never match. Releases are only published for exact cli-vX.Y.Z tags.
  tags=""
  page=1
  while [ "$page" -le 20 ]; do
    body="$(fetch "$api?per_page=100&page=$page")" ||
      fail "could not list releases"
    found="$(printf '%s' "$body" | grep -o '"tag_name": *"[^"]*"' || true)"
    [ -n "$found" ] || break
    tags="$tags
$found"
    page=$((page + 1))
  done
  version="$(printf '%s\n' "$tags" | grep -o '"cli-v[0-9]*\.[0-9]*\.[0-9]*"' |
    sed 's/"cli-v\([^"]*\)"/\1/' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
  [ -n "$version" ] || fail "could not find a muvloom release"
  tag="cli-v$version"
fi

asset="muvloom_${os}_${arch}"
base="$download/$tag"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset ($tag)" >&2
fetch -o "$tmp/$asset" "$base/$asset" || fail "download failed: $base/$asset"
fetch -o "$tmp/checksums.txt" "$base/checksums.txt" || fail "download failed: $base/checksums.txt"

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
# Another copy earlier on PATH would keep running instead of this one (typically one in a
# directory this user cannot write). Say so rather than leave two versions in silence.
other="$(command -v muvloom 2>/dev/null || true)"
if [ -n "$other" ] && [ -f "$other" ] && [ ! "$other" -ef "$INSTALL_DIR/muvloom" ]; then
  echo "Note: $other is earlier on PATH and will keep running instead; remove it, or put $INSTALL_DIR first." >&2
fi
"$INSTALL_DIR/muvloom" version
