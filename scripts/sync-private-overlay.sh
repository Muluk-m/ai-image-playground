#!/usr/bin/env bash
# 把本地 `private/` 对齐到公开树钉住的 overlay 提交（`private.lock`）。
#
# 公开树和 overlay 是两份历史，本地两边各自 checkout 很容易错位：overlay 引用了公开树还没有
# （或已经删掉）的宿主面成员，typecheck / 全量测试就红，看起来像代码坏了，其实只是版本没对上。
# 生产与 `with-overlay` 作业都按 lock 取，本地也按 lock 取，四处看到的是同一对组合。
#
# 用法：scripts/sync-private-overlay.sh        # 对齐到 private.lock
#       scripts/sync-private-overlay.sh --check # 只报告，不动 private/
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
lock=$(tr -d '[:space:]' < "$root/private.lock")
if [ ! -d "$root/private/.git" ]; then
  echo "private/ is not a git checkout; clone the overlay there first (see CLAUDE.md)." >&2
  exit 1
fi
head=$(git -C "$root/private" rev-parse HEAD)
if [ "$head" = "$lock" ]; then
  echo "private/ already at $(printf %.12s "$lock")"
  exit 0
fi
if [ "${1:-}" = "--check" ]; then
  echo "private/ is at $(printf %.12s "$head"), lock wants $(printf %.12s "$lock")" >&2
  exit 1
fi
if [ -n "$(git -C "$root/private" status --porcelain)" ]; then
  echo "private/ has uncommitted changes; commit or stash them before syncing." >&2
  exit 1
fi
git -C "$root/private" fetch --quiet origin
git -C "$root/private" checkout --quiet --detach "$lock"
echo "private/ → $(printf %.12s "$lock") ($(git -C "$root/private" log -1 --format=%s))"
