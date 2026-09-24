import { useState, useSyncExternalStore } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import type { CloudProjectSession, ProjectSyncStatus } from '../lib/cloudProjects'

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

export default function ProjectSyncStatus({
  session,
  quiet = false,
}: {
  session: CloudProjectSession
  quiet?: boolean
}) {
  const { t } = useTranslation(['canvas', 'errors'])
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [resolving, setResolving] = useState(false)
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
  if (quiet && QUIET[state.status]) return null
  return (
    <div
      className="pointer-events-auto max-w-sm text-xs text-muted-foreground"
      role={state.status.endsWith('error') || state.status === 'conflict' ? 'alert' : 'status'}
    >
      <p>{t(LABEL_KEY[state.status])}</p>
      {state.message && <p className="mt-1">{t(state.message)}</p>}
      {(state.status.endsWith('error') || state.status === 'pending') && (
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
