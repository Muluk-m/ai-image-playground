import { type FormEvent, useState } from 'react'
import { OptionList } from '../../../components/assistant-ui/elements/option-list'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { useTranslation } from '../../../i18n'
import { cn } from '../../../lib/utils'
import { CARD_CONTROL } from '../agentStyles'
import { confirmedMaskSource } from '../lib/maskProposal'
import { clarificationAnswer, clarificationAnswerMessage } from '../lib/panelMessages'
import { useAgentStore } from '../store'
import type { AgentClarificationMessage } from '../types'
import AgentMaskProposalCard, { AnsweredMaskProposal } from './AgentMaskProposalCard'

/** 历史里选项一长就先收起未选行；四行以内保持参考图那样整张展开。 */
const FOLD_AFTER = 4

const OPTION_ROW =
  'studio-clarification-option h-auto w-full items-center justify-start gap-3 whitespace-normal rounded-lg px-3 py-2 text-start font-normal shadow-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0'

/** A、B…Z、AA。只画在行首，发出去的仍是选项原文。 */
function optionMarker(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
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
  const answerReferences = useAgentStore((state) =>
    answered && message.maskProposal
      ? clarificationAnswerMessage(state.messages, message.id)?.references
      : undefined,
  )
  const [writing, setWriting] = useState(false)
  const [other, setOther] = useState('')
  const [expanded, setExpanded] = useState(false)
  const locked = answered || running
  const written = other.trim()

  const submitOther = (event: FormEvent) => {
    event.preventDefault()
    if (locked || !written) return
    void useAgentStore.getState().send(written)
  }

  if (message.maskProposal) {
    if (answered) {
      // 确认与否先看回答里有没有带着这张图的蒙版：回答文字按当时的界面语言存，切换语言后
      // 前缀就对不上了；文字前缀只兜底蒙版读不到的旧记录。
      const mask = confirmedMaskSource(answerReferences, message.maskProposal)
      return (
        <AnsweredMaskProposal
          proposal={message.maskProposal}
          confirmed={
            mask !== null || (answer?.startsWith(t('maskProposal.answerConfirmed')) ?? false)
          }
          mask={mask}
        />
      )
    }
    return (
      <AgentMaskProposalCard
        message={message}
        proposal={message.maskProposal}
        answered={answered}
      />
    )
  }

  const rows = message.options.map((option, index) => ({
    id: option,
    label: option,
    marker: optionMarker(index),
  }))
  const withAnswer =
    answer !== null && !message.options.includes(answer)
      ? [...rows, { id: answer, label: answer, marker: optionMarker(rows.length) }]
      : rows
  const hiddenCount = answer === null ? 0 : withAnswer.filter((row) => row.id !== answer).length
  const canFold = hiddenCount > 0 && withAnswer.length > FOLD_AFTER
  const folded = canFold && !expanded
  const visible = folded ? withAnswer.filter((row) => row.id === answer) : withAnswer
  const knownAnswer = answer !== null

  return (
    <section
      className={cn(
        'studio-clarification',
        answered && !knownAnswer && 'studio-clarification-answered--unknown',
      )}
      data-answered={answered ? 'true' : 'false'}
      data-collapsed={folded ? 'true' : undefined}
      aria-label={message.question}
    >
      <div className="studio-clarification-intro">
        <header className="studio-clarification-head">
          <span className="studio-clarification-kicker">
            <Icon name="help" size="sm" />
            {t('clarification.prompt')}
          </span>
          {answered && (
            <span className="studio-clarification-status">{t('clarification.answered')}</span>
          )}
        </header>
        <h3 className="studio-clarification-question">{message.question}</h3>
      </div>
      <OptionList
        bare
        className="studio-clarification-options"
        rowClassName="studio-clarification-option"
        options={visible}
        choice={knownAnswer ? [answer] : answered ? [] : undefined}
        pending={running && !answered}
        selectedLabel={knownAnswer ? t('clarification.selected') : undefined}
        aria-label={message.question}
        onConfirm={
          knownAnswer || answered
            ? undefined
            : ([option]) => {
                void useAgentStore.getState().send(option)
              }
        }
      />
      {canFold && (
        <Button
          variant="ghost"
          type="button"
          className="studio-clarification-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t('clarification.collapse')
            : t('clarification.expand', { count: hiddenCount })}
        </Button>
      )}
      {!answered &&
        (writing ? (
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
            className={OPTION_ROW}
            onClick={() => setWriting(true)}
          >
            <span className="studio-clarification-mark" aria-hidden="true">
              <Icon name="edit" size="xs" />
            </span>
            <span className="min-w-0 flex-1 break-words text-start">
              {t('clarification.other')}
            </span>
          </Button>
        ))}
      {knownAnswer && (
        <p className="studio-clarification-submitted">{t('clarification.submitted')}</p>
      )}
    </section>
  )
}
