import Credits from '../../../components/Credits'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { formatElapsed } from '../../../hooks/useElapsed'
import { useTranslation } from '../../../i18n'
import { useAgentStore } from '../store'
import type { AgentImageActionStep } from '../types'

export default function AgentImageActionStepView({ message }: { message: AgentImageActionStep }) {
  const { t } = useTranslation('agent')
  const label = t('imageAction.removeBackground')
  const download = () => {
    if (!message.resultSource) return
    const link = document.createElement('a')
    link.href = message.resultSource
    link.download = `muvloom-${message.artifactId}-cutout.png`
    link.click()
  }
  return (
    <section className="studio-agent-action-step" aria-label={label}>
      <div className="studio-agent-action-step-head">
        {message.thumbnail ? (
          <img src={message.thumbnail} alt="" />
        ) : (
          <span className="studio-agent-action-step-thumb" />
        )}
        <div className="min-w-0">
          <p>{label}</p>
          <span className="studio-agent-action-chip">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="rounded-full"
              aria-label={t('imageAction.dismiss')}
              onClick={() => useAgentStore.getState().dismissImageAction(message.id)}
            >
              <Icon name="close" size="xs" />
            </Button>
            {label}
          </span>
        </div>
      </div>
      {message.status === 'running' && (
        <p className="studio-agent-action-step-note">{t('imageAction.running')}</p>
      )}
      {message.status === 'failed' && (
        <p className="studio-agent-action-step-note" role="alert">
          {message.error && message.error !== 'source_unavailable'
            ? message.error
            : t('imageAction.failed')}
        </p>
      )}
      {message.status === 'succeeded' && message.resultSource && (
        <div className="studio-agent-action-step-result">
          <img src={message.resultSource} alt={label} />
        </div>
      )}
      {message.status === 'succeeded' && (
        <div className="studio-agent-action-step-foot">
          <Button
            type="button"
            variant="ghost"
            className="h-8 px-2"
            aria-label={t('tool.downloadResult')}
            disabled={!message.resultSource}
            onClick={download}
          >
            <Icon name="download" size="xs" />
          </Button>
          <p>
            {message.durationMs !== undefined && <span>{formatElapsed(message.durationMs)}</span>}
            {message.credits !== undefined && <Credits credits={message.credits} />}
          </p>
        </div>
      )}
    </section>
  )
}
