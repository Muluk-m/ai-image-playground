import { useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import type { CloudProjectSession, ProjectSyncStatus } from '../lib/cloudProjects'

const LABEL_KEY = {
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

export default function ProjectSyncStatus({ session }: { session: CloudProjectSession }) {
  const { t } = useTranslation(['canvas', 'errors'])
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  return (
    <div
      className="pointer-events-auto max-w-sm text-xs text-muted-foreground"
      role={state.status.endsWith('error') || state.status === 'conflict' ? 'alert' : 'status'}
    >
      <p>{t(LABEL_KEY[state.status])}</p>
      {state.message && <p className="mt-1">{t(state.message)}</p>}
      {((state.status.endsWith('error') && state.status !== 'load-error') ||
        state.status === 'pending') && (
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
