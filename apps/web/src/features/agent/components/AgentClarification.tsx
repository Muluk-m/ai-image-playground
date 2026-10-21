import { type FormEvent, useState } from 'react'
import { OptionList } from '../../../components/assistant-ui/elements/option-list'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { useTranslation } from '../../../i18n'
import { CARD_CONTROL } from '../agentStyles'
import { clarificationAnswer } from '../lib/panelMessages'
import { useAgentStore } from '../store'
import type { AgentClarificationMessage } from '../types'
import AgentMaskProposalCard, { AnsweredMaskProposal } from './AgentMaskProposalCard'

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
  const answerDescription = message.options.includes(answer)
    ? t('clarification.selected')
    : `${t('clarification.otherAria')} · ${t('clarification.selected')}`
  return (
    <div className="studio-clarification-answered">
      <Button
        variant="ghost"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon name="check" />
        <span>{chosen}</span>
        <Icon name="chevronDown" className={expanded ? 'rotate-180' : ''} />
      </Button>
      {expanded && (
        <div className="studio-clarification-answered-detail">
          <p>{message.question}</p>
          <OptionList
            options={[...new Set([...message.options, answer])].map((option) => ({
              id: option,
              label: option,
              description: option === answer ? answerDescription : undefined,
            }))}
            choice={[answer]}
            aria-label={message.question}
          />
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

  if (message.maskProposal) {
    if (answered)
      return (
        <AnsweredMaskProposal
          proposal={message.maskProposal}
          confirmed={answer?.startsWith(t('maskProposal.answerConfirmed')) ?? false}
        />
      )
    return (
      <AgentMaskProposalCard
        message={message}
        proposal={message.maskProposal}
        answered={answered}
      />
    )
  }
  if (answer !== null) return <AnsweredClarification message={message} answer={answer} />
  if (answered)
    return (
      <div className="studio-clarification-answered studio-clarification-answered--unknown">
        <Icon name="check" size="sm" />
        <span>
          {t('clarification.answered')} · {message.question}
        </span>
      </div>
    )

  return (
    <section className="flex w-full max-w-md flex-col gap-3" aria-label={message.question}>
      <h3 className="flex items-start gap-2 text-sm font-medium leading-relaxed">
        <Icon name="help" size="sm" className="mt-0.5 text-muted-foreground" />
        {message.question}
      </h3>
      <OptionList
        options={message.options.map((option) => ({ id: option, label: option }))}
        pending={locked}
        aria-label={message.question}
        onConfirm={([option]) => {
          void useAgentStore.getState().send(option)
        }}
      />
      <div className="flex flex-col gap-2">
        {writing && !answered ? (
          <form className="studio-clarification-other-form" onSubmit={submitOther}>
            <Input
              autoFocus
              className={CARD_CONTROL}
              aria-label={t('clarification.otherAria')}
              value={other}
              disabled={running}
              placeholder={t('clarification.otherPlaceholder')}
              onChange={(event) => setOther(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
              }}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              type="submit"
              disabled={locked || !written}
              aria-label={t('composer.send')}
            >
              <Icon name="send" />
            </Button>
          </form>
        ) : (
          <Button
            variant="ghost"
            type="button"
            disabled={locked}
            size="sm"
            className="justify-start self-start text-muted-foreground"
            onClick={() => setWriting(true)}
          >
            <Icon name="edit" />
            <span>{t('clarification.other')}</span>
          </Button>
        )}
      </div>
    </section>
  )
}
