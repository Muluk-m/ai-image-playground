#!/bin/sh
# Installs the native muvloom CLI from GitHub releases, verifying its SHA-256 checksum.
#   MUVLOOM_VERSION=0.1.0        pin an exact release (never downgrades a newer install)
#   MUVLOOM_MIN_VERSION=0.2.5    install the latest release that is at least this version
#   MUVLOOM_INSTALL_DIR=...      install directory. Default: where muvloom already is (one copy, and
#                                it is the one that runs), else /usr/local/bin when that is on PATH and
#                                writable without sudo, else ~/.local/bin. For a system-wide install
#                                that needs administrator rights: sudo MUVLOOM_INSTALL_DIR=/usr/local/bin sh
#   MUVLOOM_NO_MODIFY_PATH=1     leave the user shell profile unchanged
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

# 0 if $1 is a dotted X.Y.Z and is strictly less than $2.
version_less() {
  [ -n "$1" ] && [ -n "$2" ] || return 1
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || return 1
  printf '%s\n' "$2" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || return 1
  [ "$1" = "$2" ] && return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = "$1" ]
}

# Parse `muvloom X.Y.Z (os/arch)` from `muvloom version`.
installed_version() {
  [ -x "$1" ] || return 0
  out="$("$1" version 2>/dev/null || true)"
  printf '%s\n' "$out" | sed -n 's/^muvloom \([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1
}

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
BIN="$INSTALL_DIR/muvloom"

list_latest_version() {
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
  printf '%s\n' "$version"
}

if [ -n "${MUVLOOM_VERSION:-}" ]; then
  target="${MUVLOOM_VERSION#v}"
  printf '%s\n' "$target" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
    fail "MUVLOOM_VERSION must be an exact X.Y.Z version"
else
  target="$(list_latest_version)"
fi

if [ -n "${MUVLOOM_MIN_VERSION:-}" ]; then
  min="${MUVLOOM_MIN_VERSION#v}"
  printf '%s\n' "$min" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
    fail "MUVLOOM_MIN_VERSION must be an exact X.Y.Z version"
  if version_less "$target" "$min"; then
    fail "latest or pinned release $target is older than MUVLOOM_MIN_VERSION $min"
  fi
fi

current="$(installed_version "$BIN")"
skip_download=""
if [ -n "$current" ]; then
  if version_less "$target" "$current"; then
    echo "muvloom $current is already installed at $BIN; not downgrading to $target" >&2
    skip_download=1
  elif [ -n "${MUVLOOM_MIN_VERSION:-}" ] && ! version_less "$current" "${MUVLOOM_MIN_VERSION#v}" &&
    ! version_less "$current" "$target" && [ "$current" = "$target" ]; then
    # Already meets the minimum and matches the resolved target.
    echo "muvloom $current is already installed at $BIN" >&2
    skip_download=1
  fi
fi

if [ -z "$skip_download" ]; then
  tag="cli-v$target"
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
  mv "$tmp/$asset" "$BIN"
  trap - EXIT
  rm -rf "$tmp"
fi

echo "muvloom installed at $BIN" >&2

# Persist PATH in the user's profile so later agent shells find the CLI. Windows already
# writes the user PATH; Unix previously only printed an export for the current shell.
# MUVLOOM_NO_MODIFY_PATH=1 skips this (CI and already-configured hosts).
ensure_profile_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) on_path=1 ;;
    *) on_path= ;;
  esac
  if [ "${MUVLOOM_NO_MODIFY_PATH:-}" = "1" ]; then
    [ -n "$on_path" ] || echo "Add it to PATH: export PATH=\"$INSTALL_DIR:\$PATH\"" >&2
    return
  fi
  # Standard system directories are already on a login PATH; do not edit profiles for them.
  if [ "$INSTALL_DIR" = "$SYSTEM_BIN_DIR" ] || [ "$INSTALL_DIR" = "/usr/local/bin" ] || [ "$INSTALL_DIR" = "/usr/bin" ]; then
    [ -n "$on_path" ] || echo "Add it to PATH: export PATH=\"$INSTALL_DIR:\$PATH\"" >&2
    return
  fi
  existing=""
  for candidate in "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
    if [ -f "$candidate" ] && grep -F "$INSTALL_DIR" "$candidate" >/dev/null 2>&1; then
      existing="$candidate"
      break
    fi
  done
  if [ -n "$existing" ]; then
    echo "PATH already includes $INSTALL_DIR in $existing" >&2
    [ -n "$on_path" ] || echo "Add it to this session: export PATH=\"$INSTALL_DIR:\$PATH\"" >&2
    return
  fi
  case "${SHELL:-}" in
    */zsh)
      if [ -f "$HOME/.zprofile" ]; then
        profile="$HOME/.zprofile"
      elif [ -f "$HOME/.zshrc" ]; then
        profile="$HOME/.zshrc"
      else
        profile="$HOME/.zprofile"
      fi
      ;;
    */bash)
      if [ -f "$HOME/.bashrc" ]; then
        profile="$HOME/.bashrc"
      elif [ -f "$HOME/.bash_profile" ]; then
        profile="$HOME/.bash_profile"
      elif [ -f "$HOME/.profile" ]; then
        profile="$HOME/.profile"
      else
        # Nothing exists yet: create .bashrc, which interactive bash and many agent shells read.
        profile="$HOME/.bashrc"
      fi
      ;;
    *)
      if [ -f "$HOME/.profile" ]; then
        profile="$HOME/.profile"
      elif [ -f "$HOME/.zprofile" ]; then
        profile="$HOME/.zprofile"
      else
        profile="$HOME/.profile"
      fi
      ;;
  esac
  if [ ! -f "$profile" ]; then
    umask 022
    # shellcheck disable=SC2174
    mkdir -p "$(dirname -- "$profile")"
    : >"$profile"
  fi
  printf '\n# muvloom CLI\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >>"$profile"
  echo "Added $INSTALL_DIR to PATH in $profile" >&2
  [ -n "$on_path" ] || echo "Add it to this session: export PATH=\"$INSTALL_DIR:\$PATH\"" >&2
}
ensure_profile_path

# Another copy earlier on PATH would keep running instead of this one (typically one in a
# directory this user cannot write). Say so rather than leave two versions in silence.
other="$(command -v muvloom 2>/dev/null || true)"
if [ -n "$other" ] && [ -f "$other" ] && [ ! "$other" -ef "$BIN" ]; then
  echo "Note: $other is earlier on PATH and will keep running instead; remove it, or put $INSTALL_DIR first." >&2
fi
"$BIN" version
