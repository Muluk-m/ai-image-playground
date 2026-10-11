#!/bin/sh
set -eu

# Keep the pinned browser runtime outside the workspace/lockfile, shared by CI and releases.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime_dir=${PAGES_SMOKE_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ai-image-playground/playwright-1.58.2}
mkdir -p "$runtime_dir"
# Other projects may use a different pinned Chromium from the shared browser cache.
export PLAYWRIGHT_SKIP_BROWSER_GC=1
if ! node -e 'const p=require(process.argv[1]); process.exit(p.version === "1.58.2" ? 0 : 1)' \
  "$runtime_dir/node_modules/playwright/package.json" 2>/dev/null; then
  npm install --prefix "$runtime_dir" --no-package-lock --no-save playwright@1.58.2
fi
if ! node -e 'const fs=require("node:fs"); const {chromium}=require(process.argv[1]); process.exit(fs.existsSync(chromium.executablePath()) ? 0 : 1)' \
  "$runtime_dir/node_modules/playwright"; then
  if [ "$(uname -s)" = Linux ]; then
    "$runtime_dir/node_modules/.bin/playwright" install --with-deps chromium
  else
    "$runtime_dir/node_modules/.bin/playwright" install chromium
  fi
fi
export PAGES_SMOKE_RUNTIME_DIR="$runtime_dir"
case "${1:-}" in
  --install) exit 0 ;;
  --test)
    cd "$repo_root/apps/web"
    exec pnpm test src/__tests__/scripts/pagesBrowserSmoke.test.ts --maxWorkers=1
    ;;
esac
export NODE_PATH="$runtime_dir/node_modules${NODE_PATH:+:$NODE_PATH}"
export PAGES_SMOKE_OUTPUT_DIR="${PAGES_SMOKE_OUTPUT_DIR:-$runtime_dir/results}"
exec node "$repo_root/scripts/pages-browser-smoke.cjs" "$@"
