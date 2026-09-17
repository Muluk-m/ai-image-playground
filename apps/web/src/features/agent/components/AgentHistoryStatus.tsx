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
      className="mx-1 rounded-xl border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground"
    >
      <p>{loading ? t('history.loading') : t('history.failed')}</p>
      {failed && (
        <button
          type="button"
          className="mt-2 font-medium text-primary hover:underline"
          onClick={() => void useAgentStore.getState().retryHistory()}
        >
          {t('history.retry')}
        </button>
      )}
    </div>
  )
}
