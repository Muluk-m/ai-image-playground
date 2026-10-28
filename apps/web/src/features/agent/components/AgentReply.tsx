import {
  stripDisallowedScripts,
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
  /** 整段会话里的用户原文。和 BFF 用同一个函数，拦住接口里直接注入的乱入文字。 */
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
export default function AgentReply({ text: stored, streaming, userText = '' }: Props) {
  // 服务端已在模型适配层把正文开头的推理拆走；这里只兜修复之前落库的旧回复，流式中不逐段重扫。
  const hiddenKeys = useReplyHiddenKeys()
  const text = useMemo(
    () => (streaming ? stored : stripInlineReasoning(stored)),
    [stored, streaming],
  )
  // 显示与复制都去掉产物 id、UUID 与批次项 key（BUG-56），并再挡一层乱入文字。
  const shown = useMemo(
    () => stripInternalRefs(stripDisallowedScripts(text, userText), hiddenKeys),
    [text, userText, hiddenKeys],
  )
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
      {!streaming && shown && (
        <div className="studio-agent-reply-actions mt-2 flex items-center">
          <CopyReplyButton text={shown} />
        </div>
      )}
    </div>
  )
}
