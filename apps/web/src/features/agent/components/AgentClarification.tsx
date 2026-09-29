import { ArrowUp, Check, ChevronDown, CircleHelp, PencilLine } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Input } from '../../../components/ui/input'
import { useTranslation } from '../../../i18n'
import { clarificationAnswer } from '../lib/panelMessages'
import { useAgentStore } from '../store'
import type { AgentClarificationMessage } from '../types'

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
    <div className="studio-clarification-answered">
      <button
        type="button"
        aria-expanded={expanded}
        title={chosen}
        onClick={() => setExpanded((value) => !value)}
      >
        <Check size={15} aria-hidden="true" />
        <span>{chosen}</span>
        <ChevronDown size={14} className={expanded ? 'rotate-180' : ''} aria-hidden="true" />
      </button>
      {expanded && (
        <div className="studio-clarification-answered-detail">
          <p>{message.question}</p>
          <div>
            {message.options.map((option) => (
              <span key={option} data-selected={option === answer}>
                {option}
              </span>
            ))}
          </div>
        </div>
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
  if (answered)
    return (
      <div className="studio-clarification-answered studio-clarification-answered--unknown">
        <Check size={15} aria-hidden="true" />
        <span>
          {t('clarification.answered')} · {message.question}
        </span>
      </div>
    )

  return (
    <section className="studio-clarification" aria-label={message.question}>
      <div className="studio-clarification-heading">
        <span className="studio-clarification-mark" aria-hidden="true">
          <CircleHelp size={18} />
        </span>
        <h3>{message.question}</h3>
      </div>
      <div className="studio-clarification-options">
        {message.options.map((option, index) => (
          <button
            key={option}
            type="button"
            disabled={locked}
            onClick={() => void useAgentStore.getState().send(option)}
          >
            <span className="studio-clarification-option-index">{index + 1}</span>
            <span>{option}</span>
          </button>
        ))}
        {writing && !answered ? (
          <form className="studio-clarification-other-form" onSubmit={submitOther}>
            <Input
              autoFocus
              aria-label={t('clarification.otherAria')}
              value={other}
              disabled={running}
              placeholder={t('clarification.otherPlaceholder')}
              onChange={(event) => setOther(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
              }}
            />
            <button type="submit" disabled={locked || !written} aria-label={t('composer.send')}>
              <ArrowUp size={17} aria-hidden="true" />
            </button>
          </form>
        ) : (
          <button
            type="button"
            disabled={locked}
            className="studio-clarification-other"
            onClick={() => setWriting(true)}
          >
            <PencilLine size={16} aria-hidden="true" />
            <span>{t('clarification.other')}</span>
          </button>
        )}
      </div>
    </section>
  )
}
