import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { agentHistorySession } from '../lib/historySession'
import { useAgentStore } from '../store'

export default function AgentHistoryStatus() {
  const { t } = useTranslation('agent')
  const historyCached = useAgentStore((state) => state.historyCached)
  const historyLoading = useAgentStore((state) => state.historyLoading)
  const historyFailed = useAgentStore((state) => state.historyFailed)
  const session = agentHistorySession({ historyCached, historyLoading, historyFailed })
  if (session.phase === 'idle') return null
  const failed = session.phase === 'failed'
  const cached = session.cached
  return (
    <div
      role={failed ? 'alert' : 'status'}
      className={`studio-agent-history-state ${failed ? 'studio-agent-history-state--failed' : ''}`}
    >
      {session.phase === 'loading' && (
        <span className="studio-agent-history-pulse" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      <span>
        {session.phase === 'loading'
          ? t(cached ? 'history.syncing' : 'history.loading')
          : t(cached ? 'history.syncFailed' : 'history.failed')}
      </span>
      {failed && (
        <Button
          type="button"
          variant="ghost"
          className="h-auto text-xs"
          onClick={() => void useAgentStore.getState().retryHistory()}
        >
          {t('history.retry')}
        </Button>
      )}
    </div>
  )
}
