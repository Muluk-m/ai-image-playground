import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import type { CanvasCloudSession } from '../lib/cloudNodeProjects'
import type { ProjectSyncStatus } from '../lib/cloudProjects'

const LABEL_KEY = {
  deleted: 'sync.deleted',
  loading: 'sync.loading',
  'local-error': 'sync.localError',
  'auth-error': 'sync.authError',
  'permission-error': 'sync.permissionError',
  'quota-error': 'sync.quotaError',
  'format-error': 'sync.formatError',
  pending: 'sync.pending',
  local: 'sync.local',
  offline: 'sync.offline',
  syncing: 'sync.syncing',
  saved: 'sync.saved',
  error: 'sync.error',
  'load-error': 'sync.loadError',
  conflict: 'sync.conflict',
  'media-local': 'sync.mediaLocal',
} as const satisfies Record<ProjectSyncStatus, string>

/** 一切正常时的那几个状态：画布上只在出岔子时才出声，这些安静掉。 */
const QUIET: Partial<Record<ProjectSyncStatus, true>> = {
  saved: true,
  syncing: true,
  loading: true,
}

/**
 * 「等待保存」在画布上要持续这么久才露面。pending 是健康的中间态：本机改动已经落进 IndexedDB，
 * 只是还在 80ms 节流、等上一次发送的回执，或在发送前把新出的图收成云媒体（多张候选图时要好几秒）。
 * 跑节点时结果和占位一直在写，状态在 pending 与 syncing 之间来回跳，一跳就亮出「等待保存 / 重试」，
 * 像是出了故障又自己好了。只有一直卡在 pending 才提示并给重试；真正失败走 offline、media-local
 * 和各种 error，不受这个延迟影响。
 */
export const PENDING_VISIBLE_AFTER_MS = 8000

/** 当前状态是否已经连续停在 pending 超过阈值；离开 pending 立即复位。 */
function usePendingStalled(pending: boolean): boolean {
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    setStalled(false)
    if (!pending) return
    const timer = setTimeout(() => setStalled(true), PENDING_VISIBLE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [pending])
  return pending && stalled
}

export default function ProjectSyncStatus({
  session,
  quiet = false,
}: {
  session: CanvasCloudSession
  quiet?: boolean
}) {
  const { t } = useTranslation(['canvas', 'errors'])
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [resolving, setResolving] = useState(false)
  const pendingStalled = usePendingStalled(state.status === 'pending')
  const resolve = async (choice: 'cloud' | 'copy') => {
    if (resolving) return
    setResolving(true)
    try {
      const copy = await session.resolveConflict(choice)
      if (choice === 'copy' && copy) {
        const { useAgentStore } = await import('../../agent/store')
        await useAgentStore.getState().selectProject(copy.id)
      }
    } catch {
      // The session retains both the conflict and an actionable failure message.
    } finally {
      setResolving(false)
    }
  }
  if (quiet && (QUIET[state.status] || (state.status === 'pending' && !pendingStalled))) return null
  return (
    <div
      className="pointer-events-auto max-w-sm text-xs text-muted-foreground"
      role={state.status.endsWith('error') || state.status === 'conflict' ? 'alert' : 'status'}
    >
      <p className="inline-flex items-center gap-1.5">
        {['loading', 'pending', 'syncing'].includes(state.status) && (
          <Icon name="loading" size="xs" className="animate-spin motion-reduce:animate-none" />
        )}
        {t(LABEL_KEY[state.status])}
      </p>
      {state.message && <p className="mt-1">{t(state.message)}</p>}
      {(state.status.endsWith('error') ||
        state.status === 'pending' ||
        state.status === 'media-local') && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="ml-2"
          onClick={() =>
            void (state.status === 'load-error' ? session.reload() : session.sync()).catch(() => {})
          }
        >
          {t('sync.retry')}
        </Button>
      )}
      {(state.status === 'conflict' || state.status === 'deleted') && (
        <div className="mt-2 space-y-2">
          {state.status === 'conflict' && <p>{t('sync.conflictHelp')}</p>}
          <div className="flex flex-wrap gap-2">
            {state.status === 'conflict' && (
              <Button
                type="button"
                disabled={resolving}
                variant="outline"
                size="sm"
                onClick={() => void resolve('cloud')}
              >
                {t('sync.useCloud')}
              </Button>
            )}
            <Button
              type="button"
              disabled={resolving}
              variant="outline"
              size="sm"
              onClick={() => void resolve('copy')}
            >
              {t('sync.saveCopy')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
