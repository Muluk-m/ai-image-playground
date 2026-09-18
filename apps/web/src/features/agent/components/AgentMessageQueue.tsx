import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '../../../i18n'
import { ICON_BUTTON, INK, INK_3 } from '../agentStyles'
import { hasWaitingMessages } from '../lib/messageQueue'
import { useAgentStore } from '../store'

/**
 * 输入框上方的排队列表：智能体忙时发出、服务端还排着的消息，按处理顺序。每条可撤回；
 * 列表来自服务端，刷新与换设备看到的是同一份。轮到时没能开轮的那一条带着原因留在列表里，
 * 由用户移除。
 */
export default function AgentMessageQueue() {
  const { t } = useTranslation('agent')
  const queue = useAgentStore((state) => state.queue)
  const [withdrawing, setWithdrawing] = useState<ReadonlySet<string>>(new Set())
  if (queue.length === 0) return null
  const waiting = queue.filter((message) => message.failure === undefined).length

  const withdraw = async (queueId: string) => {
    setWithdrawing((current) => new Set(current).add(queueId))
    try {
      await useAgentStore.getState().withdrawQueued(queueId)
    } finally {
      setWithdrawing((current) => {
        const next = new Set(current)
        next.delete(queueId)
        return next
      })
    }
  }

  return (
    <section aria-label={t('queue.title', { count: queue.length })} className="shrink-0 px-3 pt-2">
      {hasWaitingMessages(queue) && (
        <p className={`mb-1 flex items-baseline gap-1.5 text-[11px] ${INK_3}`}>
          <span className={`font-medium ${INK}`}>{t('queue.title', { count: waiting })}</span>
          <span>{t('queue.hint')}</span>
        </p>
      )}
      <ol className="flex max-h-32 flex-col gap-1 overflow-y-auto">
        {queue.map((message) => (
          <li
            key={message.id}
            className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1 text-xs"
          >
            <span className={`min-w-0 flex-1 truncate ${INK}`} title={message.text}>
              {message.text}
            </span>
            {message.failure && (
              <span role="status" className="shrink-0 text-[11px] text-destructive">
                {t(`queue.failure.${message.failure}`)}
              </span>
            )}
            {message.referenceCount > 0 && (
              <span className={`shrink-0 text-[11px] ${INK_3}`}>
                {t('queue.references', { count: message.referenceCount })}
              </span>
            )}
            <button
              type="button"
              className={`${ICON_BUTTON} shrink-0`}
              aria-label={t(message.failure ? 'queue.dismissAria' : 'queue.withdrawAria', {
                text: message.text,
              })}
              title={t(message.failure ? 'queue.dismiss' : 'queue.withdraw')}
              disabled={withdrawing.has(message.id)}
              onClick={() => void withdraw(message.id)}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
