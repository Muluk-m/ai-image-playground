import { syncNow } from '../lib/sync/engine'
import { useSyncStatus } from '../lib/sync/status'

/** 设置页「数据管理」里的同步状态。只标状态，不解释规则。 */
export default function SyncStatusPanel() {
  const enabled = useSyncStatus((s) => s.enabled)
  const status = useSyncStatus((s) => s.status)
  const pending = useSyncStatus((s) => s.pending)
  const lastSyncedAt = useSyncStatus((s) => s.lastSyncedAt)
  if (!enabled) return null

  const failed = status === 'error'
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-white/[0.06] dark:bg-white/[0.02] shadow-sm flex items-center justify-between gap-3">
      <div className="min-w-0">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">模板与素材同步</h4>
        <p
          className={`mt-1 text-[13px] ${failed ? 'text-red-500 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
        >
          {syncLabel({ status, pending, lastSyncedAt })}
        </p>
      </div>
      {failed ? (
        <button
          type="button"
          onClick={() => void syncNow()}
          className="shrink-0 rounded-xl bg-gray-100/80 px-3 py-1.5 text-xs font-medium text-gray-700 transition-all hover:bg-gray-200 hover:text-gray-900 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white"
        >
          立即重试
        </button>
      ) : null}
    </div>
  )
}

export function syncLabel({
  status,
  pending,
  lastSyncedAt,
  now = Date.now(),
}: {
  status: 'idle' | 'syncing' | 'error'
  pending: number
  lastSyncedAt: number | null
  now?: number
}): string {
  if (status === 'error') return '同步失败'
  if (status === 'syncing') return '同步中'
  if (pending > 0) return `${pending} 项待同步`
  if (lastSyncedAt === null) return '尚未同步'
  return `已同步 · ${relativeTime(now - lastSyncedAt)}`
}

function relativeTime(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
