import { useState } from 'react'
import { Checkbox } from '../../../components/patterns/Checkbox'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { agentPlanCreditTotal } from '../lib/draftCredits'
import { agentDraftOutputCount } from '../lib/promptDraft'
import {
  agentToolFailureAction,
  agentToolFailureActionLabel,
  agentToolFailureText,
  runAgentToolFailureAction,
} from '../lib/toolFailure'
import { type AgentPromptConfirmResult, useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'

type AgentPromptConfirmFailure = Extract<AgentPromptConfirmResult, { ok: false }>

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
  // 停下的那一张与它的原因：被拒（积分不足、没登录）时就地标在那一行，并给出路。
  const [stopped, setStopped] = useState<{
    id: string
    failure: AgentPromptConfirmFailure
  } | null>(null)
  const selected = messages.filter((message) => checked[message.id] !== false)
  const count = selected.reduce((sum, message) => sum + agentDraftOutputCount(message), 0)
  const credits = agentPlanCreditTotal(selected)
  // 余额属于账户；这个 hook 也让余额变化（充值、别处扣费）时卡片跟着重算。
  const available = usePrivateSubmissionGuard({
    model: messages[0]?.snapshot?.target?.model ?? '',
    quantity: 1,
  }).availableCredits
  // 估价与余额都读得到时才判；读不到就交给服务端把关，不凭空挡住用户。
  const short = credits !== undefined && available !== undefined && credits > available
  const recharge = agentToolFailureAction('insufficient_credits')

  const confirm = () => {
    if (!selected.length || submitting || short) return
    setSubmitting(true)
    setError(null)
    setStopped(null)
    void (async () => {
      let confirmed = 0
      for (const message of selected) {
        const prompt = (drafts[message.id] ?? message.prompt ?? '').trim()
        if (!prompt) {
          setError(t('confirm.empty'))
          setSubmitting(false)
          return
        }
        const result = await useAgentStore
          .getState()
          .confirmPrompt(message.id, prompt)
          .catch((): AgentPromptConfirmResult => ({ ok: false, reason: 'failed' }))
        if (!result.ok) {
          const reason =
            result.reason === 'gone'
              ? t('confirm.gone')
              : result.reason === 'notConfirmable'
                ? t('confirm.notConfirmable')
                : ((result.reason === 'refused' ? agentToolFailureText(result.code) : null) ??
                  t('confirm.failed'))
          setStopped({ id: message.id, failure: result })
          setError(
            confirmed > 0
              ? t('plan.stoppedAfter', { count: confirmed, title: message.title, reason })
              : reason,
          )
          setSubmitting(false)
          return
        }
        // 文案说的是「已提交 N 张」：一张稿可能要 n 张图，按产出数计，不按稿数。
        confirmed += agentDraftOutputCount(message)
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
        <span>
          {credits === undefined
            ? t('plan.summary', { count })
            : t('plan.summaryCredits', { count, credits })}
        </span>
      </header>
      <ul className="studio-agent-plan-rows">
        {messages.map((message) => {
          const prompt = drafts[message.id] ?? message.prompt ?? ''
          const open = openId === message.id
          const refused =
            stopped?.id === message.id && stopped.failure.reason === 'refused'
              ? stopped.failure.code
              : undefined
          const action = agentToolFailureAction(refused)
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
              {refused && (
                <p
                  data-plan-refused={refused}
                  className="flex flex-wrap items-center gap-x-2 pl-8 text-xs text-destructive"
                >
                  <span>{agentToolFailureText(refused) ?? t('confirm.failed')}</span>
                  {action && (
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      onClick={() =>
                        runAgentToolFailureAction(action, {
                          code: refused,
                          title: message.title,
                          send: (text) => void useAgentStore.getState().send(text),
                        })
                      }
                    >
                      {agentToolFailureActionLabel(action, refused)}
                    </Button>
                  )}
                </p>
              )}
            </li>
          )
        })}
      </ul>
      {short && !submitting && (
        <p
          role="status"
          data-plan-short
          className="flex flex-wrap items-center gap-x-2 text-xs text-destructive"
        >
          <span>{t('plan.insufficient', { credits, available })}</span>
          {recharge && (
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() =>
                runAgentToolFailureAction(recharge, {
                  code: 'insufficient_credits',
                  title: t('plan.title'),
                  send: (text) => void useAgentStore.getState().send(text),
                })
              }
            >
              {agentToolFailureActionLabel(recharge)}
            </Button>
          )}
        </p>
      )}
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
          <Button
            type="button"
            size="sm"
            disabled={submitting || count === 0 || short}
            onClick={confirm}
          >
            {submitting ? t('confirm.submitting') : t('plan.generate', { count })}
          </Button>
        </div>
      </footer>
    </div>
  )
}
