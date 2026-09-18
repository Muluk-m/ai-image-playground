import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../lib/clipboard'
import { useStore } from '../../../store'
import { REPLY, REPLY_ACTION } from '../agentStyles'
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
    <button
      type="button"
      aria-label={copied ? t('reply.copied') : t('reply.copyAria')}
      title={t('reply.copyAria')}
      className={`${REPLY_ACTION} ${copied ? 'opacity-100' : ''}`}
      onClick={() => {
        void copyTextToClipboard(text).then(
          () => setCopied(true),
          (error) =>
            useStore
              .getState()
              .showToast(getClipboardFailureMessage(t('reply.copyFailed'), error), 'error'),
        )
      }}
    >
      {copied ? (
        <>
          <Check className="h-3 w-3" aria-hidden="true" />
          {t('reply.copied')}
        </>
      ) : (
        <Copy className="h-3 w-3" aria-hidden="true" />
      )}
    </button>
  )
}

/** 助手回复整段展示、按 Markdown 渲染；对话面板不折叠回复，折叠只会让人多点一下。 */
export default function AgentReply({ text, streaming }: Props) {
  return (
    <div className="group flex max-w-full flex-col items-start gap-0.5">
      <div className={`${REPLY} break-words`} data-streaming={streaming || undefined}>
        <AgentMarkdown text={text} />
      </div>
      {/* 流式中原文还在变，说完才给复制。 */}
      {!streaming && text && <CopyReplyButton text={text} />}
    </div>
  )
}
