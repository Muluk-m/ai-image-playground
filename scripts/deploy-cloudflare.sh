#!/bin/sh
set -e
# Build public web and upload to Cloudflare Pages. Does not touch image.nainma.online DNS.
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

pnpm --filter @image-playground/web build
cp "$ROOT/apps/web/cf/runtime-config.json" "$ROOT/apps/web/dist/runtime-config.json"

npx wrangler pages deploy "$ROOT/apps/web/dist" --project-name ai-image-playground
