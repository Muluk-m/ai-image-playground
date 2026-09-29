import { useTranslation } from '../../../i18n'
import { useAgentStore } from '../store'

export default function AgentHistoryStatus() {
  const { t } = useTranslation('agent')
  const loading = useAgentStore((state) => state.historyLoading)
  const failed = useAgentStore((state) => state.historyFailed)
  if (!loading && !failed) return null
  return (
    <div
      role={failed ? 'alert' : 'status'}
      className={`studio-agent-history-state ${failed ? 'studio-agent-history-state--failed' : ''}`}
    >
      {loading && (
        <span className="studio-agent-history-pulse" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      <span>{loading ? t('history.loading') : t('history.failed')}</span>
      {failed && (
        <button type="button" onClick={() => void useAgentStore.getState().retryHistory()}>
          {t('history.retry')}
        </button>
      )}
    </div>
  )
}
