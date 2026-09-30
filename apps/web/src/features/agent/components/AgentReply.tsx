import { useEffect, useState } from 'react'
import { MessageActions } from '../../../components/assistant-ui/elements/message-actions'
import { useTranslation } from '../../../i18n'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../lib/clipboard'
import { useStore } from '../../../store'
import { REPLY } from '../agentStyles'
import AgentMarkdown from './AgentMarkdown'

interface Props {
  text: string
  streaming: boolean
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
      className="absolute right-0 top-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
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

/** 助手回复整段展示、按 Markdown 渲染；对话面板不折叠回复，折叠只会让人多点一下。 */
export default function AgentReply({ text, streaming }: Props) {
  return (
    <div
      className={`group relative min-w-0 max-w-full self-start ${!streaming && text ? 'pr-10' : ''}`}
    >
      <div
        className={`${REPLY} studio-agent-reply break-words`}
        data-streaming={streaming || undefined}
      >
        <AgentMarkdown text={text} />
      </div>
      {/* 流式中原文还在变，说完才给复制。 */}
      {!streaming && text && <CopyReplyButton text={text} />}
    </div>
  )
}
