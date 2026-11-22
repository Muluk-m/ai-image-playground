#!/bin/sh
set -eu

# Cross-compiles the 5 static release binaries of `cli-go` into `apps/web/public/cli/bin/v<ver>/`
# so Cloudflare Pages (`test` and `muvloom`) serves SHA-256-verified CLI binaries directly from
# Muvloom's same-origin CDN via `/cli/skill-manifest.json`.

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ver=$(sed -n 's/^const BundleVersion = "\([^"]*\)".*/\1/p' "$repo_root/cli-go/internal/skill/install.go")
if [ -z "$ver" ]; then
  echo "Could not read BundleVersion from cli-go/internal/skill/install.go" >&2
  exit 1
fi

out_dir="$repo_root/apps/web/public/cli/bin/v$ver"
rm -rf "$repo_root/apps/web/public/cli/bin"
mkdir -p "$out_dir"

for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do
  goos=${target%/*}
  goarch=${target#*/}
  ext=
  [ "$goos" = windows ] && ext=.exe
  (
    cd "$repo_root/cli-go"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath \
      -ldflags "-s -w -X github.com/Muluk-m/ai-image-playground/cli-go/internal/cli.Version=$ver" \
      -o "$out_dir/muvloom_${goos}_${goarch}${ext}" ./cmd/muvloom
  )
done

echo "Built 5 static CLI $ver binaries in $out_dir"
