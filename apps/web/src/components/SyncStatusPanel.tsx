import { i18next, useTranslation } from '../i18n'
import { syncNow } from '../lib/sync/engine'
import { type AssetUploadProgress, useSyncStatus } from '../lib/sync/status'

/** 设置页「数据管理」里的同步状态。只标状态，不解释规则。 */
export default function SyncStatusPanel() {
  // 标签由 syncLabel 这个纯函数拼出来，订阅语言变化才能在切换后重渲染。
  const { t } = useTranslation('shell')
  const enabled = useSyncStatus((s) => s.enabled)
  const status = useSyncStatus((s) => s.status)
  const pending = useSyncStatus((s) => s.pending)
  const lastSyncedAt = useSyncStatus((s) => s.lastSyncedAt)
  const uploads = useSyncStatus((s) => s.uploads)
  if (!enabled) return null

  const failed = status === 'error'
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-white/[0.06] dark:bg-white/[0.02] shadow-sm flex items-center justify-between gap-3">
      <div className="min-w-0">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">{t('sync.title')}</h4>
        <p
          className={`mt-1 text-[13px] ${failed ? 'text-red-500 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
        >
          {syncLabel({ status, pending, lastSyncedAt, uploads })}
        </p>
      </div>
      {failed ? (
        <button
          type="button"
          onClick={() => void syncNow()}
          className="shrink-0 rounded-xl bg-gray-100/80 px-3 py-1.5 text-xs font-medium text-gray-700 transition-all hover:bg-gray-200 hover:text-gray-900 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white"
        >
          {t('sync.retryNow')}
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
  if (status === 'error') return i18next.t('sync.failed', { ns: 'shell' })
  if (uploads)
    return i18next.t('sync.uploading', { ns: 'shell', done: uploads.done, total: uploads.total })
  if (status === 'syncing') return i18next.t('sync.syncing', { ns: 'shell' })
  if (pending > 0) return i18next.t('sync.pending', { ns: 'shell', count: pending })
  if (lastSyncedAt === null) return i18next.t('sync.never', { ns: 'shell' })
  return i18next.t('sync.syncedAt', { ns: 'shell', relative: relativeTime(now - lastSyncedAt) })
}

function relativeTime(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return i18next.t('sync.justNow', { ns: 'shell' })
  if (minutes < 60) return i18next.t('sync.minutesAgo', { ns: 'shell', count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return i18next.t('sync.hoursAgo', { ns: 'shell', count: hours })
  return i18next.t('sync.daysAgo', { ns: 'shell', count: Math.floor(hours / 24) })
}
