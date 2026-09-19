import { useId, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { CARD_NOTE, DRAFT_FIELD, GHOST_LINK } from '../agentStyles'
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
 * 草稿框的高度：整段提示词尽量一眼读完，长到十六行才交给滚动条。面板只有 340px 宽，
 * 一行装得下约四十四个半角宽度——中日韩字符是半角的两倍，按宽度而不是字数估算折行。
 */
function draftRows(text: string): number {
  const lines = text.split('\n').reduce((rows, line) => {
    let width = 0
    for (const char of line) width += (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1
    return rows + Math.max(1, Math.ceil(width / 44))
  }, 0)
  return Math.min(16, Math.max(4, lines))
}

/**
 * 生成工具拟好、还没提交的那份提示词：整段摊在卡上直接可改，点「确认生成」才提交生成任务。
 * 模型自己补的细节（颜色、材质、光线……）因此在花钱之前就露在用户眼前，能当场改掉。
 */
export default function AgentPromptDraft({ message }: { message: AgentToolMessage }) {
  const { t } = useTranslation('agent')
  const prompt = useAgentStore((state) => state.promptDrafts[message.id] ?? message.prompt ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<AgentPromptConfirmFailure | null>(null)
  const noteId = useId()
  const ready = prompt.trim().length > 0
  const count = agentDraftOutputCount(message)
  const model = message.snapshot?.target?.model
  // 被拒时那一个出路（去充值、去登录、让助手换个做法）；其余失败原样再点一次即可。
  const refused = failure?.reason === 'refused' ? failure.code : undefined
  const action = agentToolFailureAction(refused)

  const confirm = () => {
    if (!ready || submitting) return
    setSubmitting(true)
    setFailure(null)
    void useAgentStore
      .getState()
      .confirmPrompt(message.id, prompt)
      .then((result) => {
        // 成交后这张卡就地换成提交后的样子，这个组件随之卸下；没成就留在原处，改过的字还在。
        if (!result.ok) setFailure(result)
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
    <>
      <p id={noteId} className={CARD_NOTE}>
        {t('confirm.pending')}
      </p>
      <textarea
        aria-label={t('confirm.fieldAria')}
        aria-describedby={noteId}
        aria-invalid={ready ? undefined : true}
        value={prompt}
        rows={draftRows(prompt)}
        disabled={submitting}
        className={DRAFT_FIELD}
        onChange={(event) =>
          useAgentStore.getState().setPromptDraft(message.id, event.target.value)
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={CARD_NOTE}>
          {!ready
            ? t('confirm.empty')
            : `${
                message.toolName === 'generateVideo'
                  ? t('confirm.outputsVideo', { count })
                  : t('confirm.outputsImage', { count })
              }${model ? ` · ${t('confirm.model', { name: model })}` : ''}`}
        </span>
        <Button type="button" size="sm" disabled={!ready || submitting} onClick={confirm}>
          {submitting ? t('confirm.submitting') : t('confirm.submit')}
        </Button>
      </div>
      <p className={CARD_NOTE}>{t('confirm.charge')}</p>
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
          {agentToolFailureActionLabel(action)}
        </button>
      )}
    </>
  )
}
