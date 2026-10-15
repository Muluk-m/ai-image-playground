import { useState } from 'react'
import { Checkbox } from '../../../components/patterns/Checkbox'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { agentDraftOutputCount } from '../lib/promptDraft'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'

/**
 * 同一轮里待确认的生图草稿收成一张计划。取消勾选的行不提交；取消按钮不调用接口。
 */
export default function AgentGenerationPlan({
  messages,
}: {
  messages: readonly AgentToolMessage[]
}) {
  const { t } = useTranslation('agent')
  const drafts = useAgentStore((state) => state.promptDrafts)
  const [checked, setChecked] = useState<Readonly<Record<string, boolean>>>(() =>
    Object.fromEntries(messages.map((message) => [message.id, true])),
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = messages.filter((message) => checked[message.id] !== false)
  const count = selected.reduce((sum, message) => sum + agentDraftOutputCount(message), 0)

  const confirm = () => {
    if (!selected.length || submitting) return
    setSubmitting(true)
    setError(null)
    void (async () => {
      for (const message of selected) {
        const prompt = (drafts[message.id] ?? message.prompt ?? '').trim()
        if (!prompt) {
          setError(t('confirm.empty'))
          setSubmitting(false)
          return
        }
        const result = await useAgentStore.getState().confirmPrompt(message.id, prompt)
        if (!result.ok) {
          setError(
            result.reason === 'gone'
              ? t('confirm.gone')
              : result.reason === 'notConfirmable'
                ? t('confirm.notConfirmable')
                : t('confirm.failed'),
          )
          setSubmitting(false)
          return
        }
      }
      setSubmitting(false)
    })()
  }

  if (dismissed) {
    return (
      <div className="studio-agent-plan" role="group" aria-label={t('plan.title')}>
        <p className="text-sm text-muted-foreground">{t('plan.dismissed')}</p>
        <Button type="button" variant="ghost" size="sm" onClick={() => setDismissed(false)}>
          {t('plan.restore')}
        </Button>
      </div>
    )
  }

  return (
    <div className="studio-agent-plan" role="group" aria-label={t('plan.title')}>
      <header className="studio-agent-plan-head">
        <Icon name="image" />
        <h3>{t('plan.title')}</h3>
        <span>{t('plan.summary', { count })}</span>
      </header>
      <ul className="studio-agent-plan-rows">
        {messages.map((message) => {
          const prompt = drafts[message.id] ?? message.prompt ?? ''
          const open = openId === message.id
          return (
            <li key={message.id}>
              <div className="studio-agent-plan-row">
                <Checkbox
                  checked={checked[message.id] !== false}
                  aria-label={message.title}
                  onChange={(value) =>
                    setChecked((current) => ({ ...current, [message.id]: value }))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-w-0 flex-1 justify-start px-2 py-1.5 text-left font-normal"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : message.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-foreground">{message.title}</span>
                    {!open && prompt && (
                      <span className="block truncate text-xs text-muted-foreground">{prompt}</span>
                    )}
                  </span>
                </Button>
              </div>
              {open && (
                <Textarea
                  aria-label={t('plan.promptAria')}
                  value={prompt}
                  rows={3}
                  disabled={submitting}
                  className="mt-1 max-h-36"
                  onChange={(event) =>
                    useAgentStore.getState().setPromptDraft(message.id, event.target.value)
                  }
                />
              )}
            </li>
          )
        })}
      </ul>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <footer className="studio-agent-plan-foot">
        <p>{t('plan.hint')}</p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={() => setDismissed(true)}
          >
            {t('plan.cancel')}
          </Button>
          <Button type="button" size="sm" disabled={submitting || count === 0} onClick={confirm}>
            {submitting ? t('confirm.submitting') : t('plan.generate', { count })}
          </Button>
        </div>
      </footer>
    </div>
  )
}
