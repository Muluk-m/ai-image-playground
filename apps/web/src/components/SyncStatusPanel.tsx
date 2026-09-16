import { syncNow } from '../lib/sync/engine'
import { type AssetUploadProgress, useSyncStatus } from '../lib/sync/status'

/** 设置页「数据管理」里的同步状态。只标状态，不解释规则。 */
export default function SyncStatusPanel() {
  const enabled = useSyncStatus((s) => s.enabled)
  const status = useSyncStatus((s) => s.status)
  const pending = useSyncStatus((s) => s.pending)
  const lastSyncedAt = useSyncStatus((s) => s.lastSyncedAt)
  const uploads = useSyncStatus((s) => s.uploads)
  if (!enabled) return null

  const failed = status === 'error'
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm flex items-center justify-between gap-3">
      <div className="min-w-0">
        <h4 className="text-sm font-bold text-foreground">同步</h4>
        <p
          className={`mt-1 text-[13px] ${failed ? 'text-destructive dark:text-destructive' : 'text-muted-foreground dark:text-muted-foreground'}`}
        >
          {syncLabel({ status, pending, lastSyncedAt, uploads })}
        </p>
      </div>
      {failed ? (
        <button
          type="button"
          onClick={() => void syncNow()}
          className="shrink-0 rounded-xl bg-muted/80 px-3 py-1.5 text-xs font-medium text-foreground transition-all hover:bg-muted hover:text-foreground dark:hover:text-white"
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
  uploads = null,
  now = Date.now(),
}: {
  status: 'idle' | 'syncing' | 'error'
  pending: number
  lastSyncedAt: number | null
  uploads?: AssetUploadProgress | null
  now?: number
}): string {
  if (status === 'error') return '同步失败'
  if (uploads) return `上传素材图 ${uploads.done}/${uploads.total}`
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
