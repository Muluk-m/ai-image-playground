import { useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import type { CloudProjectSession, ProjectSyncStatus } from '../lib/cloudProjects'

const LABEL_KEY = {
  loading: 'sync.loading',
  pending: 'sync.pending',
  syncing: 'sync.syncing',
  saved: 'sync.saved',
  error: 'sync.error',
  'load-error': 'sync.loadError',
  conflict: 'sync.conflict',
  'media-local': 'sync.mediaLocal',
} as const satisfies Record<ProjectSyncStatus, string>

export default function ProjectSyncStatus({ session }: { session: CloudProjectSession }) {
  const { t } = useTranslation('canvas')
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  return (
    <div
      className="pointer-events-auto max-w-sm text-xs text-muted-foreground"
      role={state.status === 'error' || state.status === 'conflict' ? 'alert' : 'status'}
    >
      <p>{t(LABEL_KEY[state.status])}</p>
      {state.message && <p className="mt-1">{state.message}</p>}
      {(state.status === 'error' || state.status === 'pending') && (
        <button
          type="button"
          className="ml-2 underline"
          onClick={() => void session.sync().catch(() => {})}
        >
          {t('sync.retry')}
        </button>
      )}
      {state.status === 'saved' && <small>{t('sync.localOnly')}</small>}
    </div>
  )
}
