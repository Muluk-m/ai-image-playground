import { useState } from 'react'
import { Checkbox } from '../../../components/patterns/Checkbox'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { agentPlanCreditTotal } from '../lib/draftCredits'
import type { AgentPromptConfirmFailure, PlanCardControl } from '../lib/planCardState'
import { agentDraftOutputCount } from '../lib/promptDraft'
import {
  agentToolFailureAction,
  agentToolFailureActionLabel,
  agentToolFailureText,
  runAgentToolFailureAction,
} from '../lib/toolFailure'
import { type AgentPromptConfirmResult, useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'

/**
 * 同一轮里待确认的生图草稿收成一张计划。取消勾选的行不提交；取消按钮不调用接口。
 */
export default function AgentGenerationPlan({
  messages,
  plan,
}: {
  messages: readonly AgentToolMessage[]
  /**
   * 勾选、确认中、停在哪张及原因，都由面板按稿 id 保管：计划随逐张提交、别处确认拆段换 key 重挂时，
   * 还在跑的确认循环照样写得进来，卡片重挂后读得回来。
   */
  plan: PlanCardControl
}) {
  const { t } = useTranslation('agent')
  const drafts = useAgentStore((state) => state.promptDrafts)
  const [openId, setOpenId] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const { skipped } = plan
  const submitting = messages.some((message) => plan.busy.has(message.id))
  // 这段计划里停下的那一张（若有）与原因。
  const stoppedAt = messages.find((message) => plan.stops.has(message.id))
  const error = stoppedAt ? plan.stops.get(stoppedAt.id) : undefined
  const selected = messages.filter((message) => !skipped.has(message.id))
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
  const failureReason = (failure: AgentPromptConfirmFailure) =>
    failure.reason === 'gone'
      ? t('confirm.gone')
      : failure.reason === 'notConfirmable'
        ? t('confirm.notConfirmable')
        : ((failure.reason === 'refused' ? agentToolFailureText(failure.code) : null) ??
          t('confirm.failed'))
  const errorText = !error
    ? null
    : error.kind === 'empty'
      ? t('confirm.empty')
      : error.confirmed > 0
        ? t('plan.stoppedAfter', {
            count: error.confirmed,
            title: error.title,
            reason: failureReason(error.failure),
          })
        : failureReason(error.failure)

  const confirm = () => {
    if (!selected.length || submitting || short) return
    const ids = selected.map((message) => message.id)
    plan.begin(ids)
    void (async () => {
      let confirmed = 0
      try {
        for (const message of selected) {
          const prompt = (drafts[message.id] ?? message.prompt ?? '').trim()
          if (!prompt) {
            plan.stop(message.id, { kind: 'empty' })
            return
          }
          const result = await useAgentStore
            .getState()
            .confirmPrompt(message.id, prompt)
            .catch((): AgentPromptConfirmResult => ({ ok: false, reason: 'failed' }))
          if (!result.ok) {
            plan.stop(message.id, {
              kind: 'failed',
              failure: result,
              confirmed,
              title: message.title,
            })
            return
          }
          plan.release([message.id])
          // 文案说的是「已提交 N 张」：一张稿可能要 n 张图，按产出数计，不按稿数。
          confirmed += agentDraftOutputCount(message)
        }
      } finally {
        plan.release(ids)
      }
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
            stoppedAt?.id === message.id &&
            error?.kind === 'failed' &&
            error.failure.reason === 'refused'
              ? error.failure.code
              : undefined
          const action = agentToolFailureAction(refused)
          return (
            <li key={message.id}>
              <div className="studio-agent-plan-row">
                <Checkbox
                  checked={!skipped.has(message.id)}
                  aria-label={message.title}
                  onChange={(value) => plan.skip(message.id, !value)}
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
      {errorText && (
        <p role="alert" className="text-xs text-destructive">
          {errorText}
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
