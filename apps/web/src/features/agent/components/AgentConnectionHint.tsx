import { useTranslation } from '../../../i18n'
import { INK_3 } from '../agentStyles'
import { useAgentStore } from '../store'

/** 跟着的那一轮断了流、正在续播时，面板顶部的一条细提示；接上就消失，界面不像卡死。 */
export default function AgentConnectionHint() {
  const { t } = useTranslation('agent')
  const reconnecting = useAgentStore((state) => state.reconnecting && state.turn === 'running')
  if (!reconnecting) return null
  return (
    <p
      role="status"
      className={`mx-3 mb-1 flex shrink-0 items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-[11px] ${INK_3}`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warning"
        aria-hidden="true"
      />
      {t('connection.reconnecting')}
    </p>
  )
}
