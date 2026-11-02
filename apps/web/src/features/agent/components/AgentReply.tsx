import {
  compileReplyScripts,
  presentReplyText,
  REPLY_SCRIPT_FALLBACK_EN,
  REPLY_SCRIPT_FALLBACK_ZH,
  type ReplyScriptAllowance,
  stripInlineReasoning,
  stripInternalRefs,
} from '@image-playground/shared'
import { useEffect, useMemo, useState } from 'react'
import { MessageActions } from '../../../components/assistant-ui/elements/message-actions'
import { useTranslation } from '../../../i18n'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../lib/clipboard'
import { useStore } from '../../../store'
import { REPLY, REPLY_ACTION } from '../agentStyles'
import AgentMarkdown from './AgentMarkdown'
import { useReplyHiddenKeys } from './AgentReplyImage'

interface Props {
  text: string
  streaming: boolean
  /** 轮初算好的允许文字。流式增量只拿它，不再重扫用户原文。 */
  allowance?: ReplyScriptAllowance
  /** 用户原文。没有 allowance 时用它现算允许的文字；整段被删光时也用它决定兜底语言。 */
  userText?: string
}

/** 「已复制」停留多久再退回复制图标。 */
const COPIED_FEEDBACK_MS = 2000

/** 悬停回复时出现的复制键，复制的是 Markdown 原文，不是渲染后的文字。 */
function CopyReplyButton({ text }: { text: string }) {
  const { t } = useTranslation('agent')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <MessageActions
      className={REPLY_ACTION}
      copied={copied}
      copyLabel={copied ? t('reply.copied') : t('reply.copyAria')}
      onCopy={() => {
        void copyTextToClipboard(text).then(
          () => setCopied(true),
          (error) =>
            useStore
              .getState()
              .showToast(getClipboardFailureMessage(t('reply.copyFailed'), error), 'error'),
        )
      }}
    />
  )
}

/** 助手回复整段展示、按 Markdown 渲染；操作跟在正文下面，不浮在角落。 */
export default function AgentReply({ text: stored, streaming, allowance, userText = '' }: Props) {
  // 服务端已在模型适配层把正文开头的推理拆走；这里只兜修复之前落库的旧回复，流式中不逐段重扫。
  const hiddenKeys = useReplyHiddenKeys()
  const text = useMemo(
    () => (streaming ? stored : stripInlineReasoning(stored)),
    [stored, streaming],
  )
  const scripts = useMemo(() => allowance ?? compileReplyScripts(userText), [allowance, userText])
  // 显示与复制都去掉产物 id、UUID 与批次项 key（BUG-56），并再挡一层乱入文字。
  const shown = useMemo(
    () => stripInternalRefs(presentReplyText(text, userText, scripts), hiddenKeys),
    [text, userText, scripts, hiddenKeys],
  )
  const fallback = shown === REPLY_SCRIPT_FALLBACK_ZH || shown === REPLY_SCRIPT_FALLBACK_EN
  if (!shown && !streaming) return null
  return (
    <div className="studio-agent-reply-wrap min-w-0 max-w-full self-start">
      <div
        className={`${REPLY} studio-agent-reply break-words`}
        data-streaming={streaming || undefined}
      >
        <AgentMarkdown text={shown} />
      </div>
      {/* 流式中原文还在变，说完才给复制。 */}
      {!streaming && shown && !fallback && (
        <div className="studio-agent-reply-actions mt-2 flex items-center">
          <CopyReplyButton text={shown} />
        </div>
      )}
    </div>
  )
}
