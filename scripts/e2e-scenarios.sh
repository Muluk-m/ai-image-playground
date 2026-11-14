#!/bin/sh
set -eu

# 浏览器场景套件（#1847）。Playwright 版本与浏览器运行时由 pages-browser-smoke.sh 固定并安装，
# 这里只复用它，再交给 scripts/e2e/run.ts。说明：docs/agents/browser-scenarios.md
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sh "$repo_root/scripts/pages-browser-smoke.sh" --install
exec sh "$repo_root/scripts/pages-browser-smoke.sh" --run node "$repo_root/scripts/e2e/run.ts" "$@"
