import type { AgentSkillSummary } from '@image-playground/shared'
import { ImageIcon } from 'lucide-react'
import { memo, type ReactNode, useEffect, useState } from 'react'
import MediaImage from '../../../components/MediaImage'
import { useTranslation } from '../../../i18n'
import { scopedStorageName } from '../../../lib/authScope'
import { getImageMentionLabel } from '../../../lib/promptImageMentions'
import { USER_BUBBLE } from '../agentStyles'
import { fetchMessageReference } from '../lib/agentClient'
import { getLeadingAgentSkill } from '../lib/agentSkillMentions'
import { useAgentStore } from '../store'
import type { AgentTextMessage } from '../types'
import AgentSkillBadge from './AgentSkillBadge'

function ReferenceThumbnail({
  reference,
  messageId,
  index,
}: {
  reference: NonNullable<AgentTextMessage['references']>[number]
  messageId: string
  index: number
}) {
  const { t } = useTranslation('agent')
  const conversationId = useAgentStore((state) => state.conversationId)
  const scope = scopedStorageName('media')
  const local = 'dataUrl' in reference ? reference.dataUrl : undefined
  const object = 'image' in reference ? reference.image.object : undefined
  const identity = `${scope}:${conversationId}:${messageId}:${index}:${object}`
  const [preview, setPreview] = useState<{ identity: string; source?: string }>()
  useEffect(() => {
    if (local !== undefined || !conversationId || !object) return
    const controller = new AbortController()
    let source: string | undefined
    void fetchMessageReference(conversationId, messageId, index, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return
        source = URL.createObjectURL(blob)
        setPreview({ identity, source })
      },
      () => {
        if (!controller.signal.aborted) setPreview({ identity })
      },
    )
    return () => {
      controller.abort()
      if (source) URL.revokeObjectURL(source)
    }
  }, [local, conversationId, messageId, index, object, identity])
  const source = local ?? (preview?.identity === identity ? preview.source : undefined)
  const label = reference.name || getImageMentionLabel(index)
  const failed = !local && preview?.identity === identity && !preview.source
  return (
    <span
      className="mention-tag agent-image-mention"
      title={failed ? `${label} · ${t('creations.previewUnavailable')}` : label}
      aria-label={label}
    >
      {source ? (
        <MediaImage
          src={source}
          alt={label}
          draggable={false}
          className="h-6 w-6 shrink-0 rounded object-cover"
        />
      ) : (
        <ImageIcon className="h-6 w-6 shrink-0 p-1" aria-hidden="true" />
      )}
      {reference.name && <span className="max-w-36 truncate">{reference.name}</span>}
    </span>
  )
}

export default memo(function AgentUserMessage({
  message,
  skills,
}: {
  message: AgentTextMessage
  skills: readonly AgentSkillSummary[]
}) {
  const invocation = getLeadingAgentSkill(message.text, skills)
  const text = invocation ? invocation.rest : message.text
  const content: ReactNode[] = []
  let from = 0
  for (const match of text.matchAll(/\[image ([1-9]\d*)\]/g)) {
    const index = Number(match[1]) - 1
    const reference = message.references?.[index]
    if (!reference) continue
    content.push(text.slice(from, match.index))
    content.push(
      <ReferenceThumbnail
        key={match.index}
        reference={reference}
        messageId={message.id}
        index={index}
      />,
    )
    from = match.index + match[0].length
  }
  content.push(text.slice(from))
  return (
    <p className={USER_BUBBLE}>
      {invocation && <AgentSkillBadge skill={invocation.skill} />}
      {content}
    </p>
  )
})
