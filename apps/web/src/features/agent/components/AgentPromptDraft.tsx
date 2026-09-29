import { ImageIcon } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { ApprovalCard } from '../../../components/assistant-ui/elements/approval-card'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { CARD_NOTE, GHOST_LINK } from '../agentStyles'
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
 * 生成工具拟好、还没提交的那份提示词：整段摊在卡上直接可改，点「确认生成」才提交生成任务。
 * 模型自己补的细节（颜色、材质、光线……）因此在花钱之前就露在用户眼前，能当场改掉。
 */
export default function AgentPromptDraft({ message }: { message: AgentToolMessage }) {
  const { t } = useTranslation('agent')
  const prompt = useAgentStore((state) => state.promptDrafts[message.id] ?? message.prompt ?? '')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [failure, setFailure] = useState<AgentPromptConfirmFailure | null>(null)
  const noteId = useId()
  const ready = prompt.trim().length > 0
  const count = agentDraftOutputCount(message)
  const model = message.snapshot?.target?.model
  // 被拒时那一个出路（去充值、去登录、让助手换个做法）；其余失败原样再点一次即可。
  const refused = failure?.reason === 'refused' ? failure.code : undefined
  const action = agentToolFailureAction(refused)

  const confirm = () => {
    if (!ready || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setFailure(null)
    void useAgentStore
      .getState()
      .confirmPrompt(message.id, prompt)
      .then((result) => {
        // 成交后这张卡就地换成提交后的样子，这个组件随之卸下；没成就留在原处，改过的字还在。
        if (!result.ok) setFailure(result)
      })
      .catch(() => setFailure({ ok: false, reason: 'failed' }))
      .finally(() => {
        submittingRef.current = false
        setSubmitting(false)
      })
  }

  const failureText = () => {
    if (!failure) return null
    if (failure.reason === 'gone') return t('confirm.gone')
    if (failure.reason === 'notConfirmable') return t('confirm.notConfirmable')
    return agentToolFailureText(refused) ?? t('confirm.failed')
  }

  return (
    <ApprovalCard
      state={submitting ? 'running' : 'request'}
      title={t('confirm.submit')}
      subtitle={message.title}
      icon={<ImageIcon className="size-4" />}
      onAllowOnce={confirm}
      allowOnceLabel={t('confirm.submit')}
      statusLabel={t('confirm.submitting')}
      disabled={!ready || submitting}
    >
      <p id={noteId} className="text-xs leading-relaxed text-muted-foreground">
        {t('confirm.pending')}
      </p>
      <Textarea
        aria-label={t('confirm.fieldAria')}
        aria-describedby={noteId}
        aria-invalid={ready ? undefined : true}
        value={prompt}
        rows={7}
        disabled={submitting}
        className="max-h-64 min-h-32 w-full resize-y rounded-xl border border-input/60 bg-background/60 p-3 text-[13px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        onChange={(event) =>
          useAgentStore.getState().setPromptDraft(message.id, event.target.value)
        }
      />
      <div className="flex items-center gap-2">
        <span className={CARD_NOTE}>
          {!ready
            ? t('confirm.empty')
            : `${
                message.toolName === 'generateVideo'
                  ? t('confirm.outputsVideo', { count })
                  : t('confirm.outputsImage', { count })
              }${model ? ` · ${t('confirm.model', { name: model })}` : ''}`}
        </span>
      </div>
      {failure && (
        <p role="alert" className={CARD_NOTE}>
          {failureText()}
        </p>
      )}
      {refused && action && (
        <button
          type="button"
          className={`self-start ${GHOST_LINK}`}
          onClick={() =>
            runAgentToolFailureAction(action, {
              code: refused,
              title: message.title,
              send: (text) => void useAgentStore.getState().send(text),
            })
          }
        >
          {agentToolFailureActionLabel(action, refused)}
        </button>
      )}
    </ApprovalCard>
  )
}
