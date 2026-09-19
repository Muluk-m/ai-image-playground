import { type FormEvent, useState } from 'react'
import { useTranslation } from '../../../i18n'
import {
  CARD,
  CARD_NOTE,
  CARD_TITLE,
  CHOICE,
  CHOICE_FIELD,
  CHOICE_SUBMIT,
  INK_3,
} from '../agentStyles'
import { clarificationAnswer } from '../lib/panelMessages'
import { useAgentStore } from '../store'
import type { AgentClarificationMessage } from '../types'

/** 作过答的澄清：折成一行「已选」，点开还能看回原问题与选项（只读）。 */
function AnsweredClarification({
  message,
  answer,
}: {
  message: AgentClarificationMessage
  answer: string
}) {
  const { t } = useTranslation('agent')
  const [expanded, setExpanded] = useState(false)
  const chosen = t('clarification.chosen', { answer })
  return (
    <div className={CARD}>
      <button
        type="button"
        aria-expanded={expanded}
        title={chosen}
        className={`flex w-full items-center gap-1.5 text-left text-xs ${INK_3} transition-colors hover:text-foreground`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="min-w-0 flex-1 truncate">{chosen}</span>
        <svg
          viewBox="0 0 16 16"
          className={`h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {expanded && (
        <>
          <p className={CARD_TITLE}>{message.question}</p>
          <div className="flex flex-col gap-1">
            {message.options.map((option) => (
              <button
                key={option}
                type="button"
                disabled
                aria-pressed={option === answer}
                className={`${CHOICE} ${option === answer ? 'border-primary' : ''}`}
              >
                {option}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default function AgentClarification({
  message,
  answered,
}: {
  message: AgentClarificationMessage
  answered: boolean
}) {
  const { t } = useTranslation('agent')
  const running = useAgentStore((state) => state.turn === 'running')
  // 回填的答案就是它之后那条用户消息，刷新读回的历史里同样有它。
  const answer = useAgentStore((state) =>
    answered ? clarificationAnswer(state.messages, message.id) : null,
  )
  const [writing, setWriting] = useState(false)
  const [other, setOther] = useState('')
  const locked = answered || running
  const written = other.trim()

  const submitOther = (event: FormEvent) => {
    event.preventDefault()
    if (locked || !written) return
    void useAgentStore.getState().send(written)
  }

  if (answer !== null) return <AnsweredClarification message={message} answer={answer} />

  return (
    <div className={CARD}>
      <p className={CARD_TITLE}>{message.question}</p>
      <div className="flex flex-col gap-1">
        {message.options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={locked}
            className={CHOICE}
            onClick={() => void useAgentStore.getState().send(option)}
          >
            {option}
          </button>
        ))}
        {/* 模型给的方案都不对时的出口：在卡片里直接写，不用挪到底下的输入框。 */}
        {writing && !answered ? (
          <form className="flex items-center gap-1" onSubmit={submitOther}>
            <input
              // 用户刚点了「其他」，下一步就是打字。
              autoFocus
              aria-label={t('clarification.otherAria')}
              value={other}
              disabled={running}
              placeholder={t('clarification.otherPlaceholder')}
              className={CHOICE_FIELD}
              onChange={(event) => setOther(event.target.value)}
              // 输入法选词的回车不是提交。
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
              }}
            />
            <button type="submit" disabled={locked || !written} className={CHOICE_SUBMIT}>
              {t('composer.send')}
            </button>
          </form>
        ) : (
          <button
            type="button"
            disabled={locked}
            className={`${CHOICE} text-muted-foreground`}
            onClick={() => setWriting(true)}
          >
            {t('clarification.other')}
          </button>
        )}
      </div>
      {answered && <p className={CARD_NOTE}>{t('clarification.answered')}</p>}
    </div>
  )
}
