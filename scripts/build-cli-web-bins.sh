#!/bin/sh
set -eu

# Cross-compiles the 5 static release binaries of `cli-go` into `apps/web/public/cli/bin/v<ver>/`
# with a 12-char content SHA-256 suffix so Cloudflare Pages (`test` and `muvloom`) can serve them
# with `Cache-Control: public, max-age=31536000, immutable` without ever caching stale bytes across
# same-BundleVersion Skill hot-update rebuilds.

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ver=$(sed -n 's/^const BundleVersion = "\([^"]*\)".*/\1/p' "$repo_root/cli-go/internal/skill/install.go")
if [ -z "$ver" ]; then
  echo "Could not read BundleVersion from cli-go/internal/skill/install.go" >&2
  exit 1
fi

sha12() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -c1-12
  else
    shasum -a 256 "$1" | cut -c1-12
  fi
}

out_dir="$repo_root/apps/web/public/cli/bin/v$ver"
rm -rf "$repo_root/apps/web/public/cli/bin"
mkdir -p "$out_dir"

for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do
  goos=${target%/*}
  goarch=${target#*/}
  ext=
  [ "$goos" = windows ] && ext=.exe
  tmp_bin="$out_dir/.tmp_${goos}_${goarch}"
  (
    cd "$repo_root/cli-go"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath \
      -ldflags "-s -w -X github.com/Muluk-m/ai-image-playground/cli-go/internal/cli.Version=$ver" \
      -o "$tmp_bin" ./cmd/muvloom
  )
  h=$(sha12 "$tmp_bin")
  mv "$tmp_bin" "$out_dir/muvloom_${goos}_${goarch}-${h}${ext}"
done

echo "Built 5 content-hashed static CLI $ver binaries in $out_dir"
