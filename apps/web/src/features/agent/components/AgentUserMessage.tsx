import type { AgentSkillSummary } from '@image-playground/shared'
import { ImageIcon, LoaderCircle } from 'lucide-react'
import { memo, type ReactNode, useEffect, useMemo, useState } from 'react'
import { ImagePreview } from '../../../components/Lightbox'
import MediaImage from '../../../components/MediaImage'
import Overlay from '../../../components/Overlay'
import { useTranslation } from '../../../i18n'
import { scopedStorageName } from '../../../lib/authScope'
import { createMaskPreviewDataUrl } from '../../../lib/canvasImage'
import { getImageMentionLabel } from '../../../lib/promptImageMentions'
import { USER_BUBBLE } from '../agentStyles'
import { fetchMessageReference } from '../lib/agentClient'
import { getLeadingAgentSkill } from '../lib/agentSkillMentions'
import { referenceDisplayNames } from '../lib/references'
import { useAgentStore } from '../store'
import type { AgentTextMessage } from '../types'
import AgentSkillBadge from './AgentSkillBadge'

function ReferencePreview({
  local,
  conversationId,
  messageId,
  index,
  onClose,
}: {
  local?: string
  conversationId: string | null
  messageId: string
  index: number
  onClose: () => void
}) {
  const { t } = useTranslation(['agent', 'common'])
  const [original, setOriginal] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (local !== undefined) return
    if (!conversationId) {
      setFailed(true)
      return
    }
    const controller = new AbortController()
    let source: string | undefined
    void fetchMessageReference(conversationId, messageId, index, {
      signal: controller.signal,
      variant: 'annotated',
    }).then(
      (blob) => {
        if (controller.signal.aborted) return
        source = URL.createObjectURL(blob)
        setOriginal(source)
      },
      () => {
        if (!controller.signal.aborted) setFailed(true)
      },
    )
    return () => {
      controller.abort()
      if (source) URL.revokeObjectURL(source)
    }
  }, [local, conversationId, messageId, index])
  const source = local ?? original
  if (source) return <ImagePreview src={source} onClose={onClose} />
  if (failed)
    return (
      <Overlay onClose={onClose} tier="raised">
        <div className="rounded-xl bg-card p-6 text-foreground" role="alert">
          {t('reference.unavailable')}
          <button type="button" className="ml-4 min-h-11 underline" onClick={onClose}>
            {t('common:action.close')}
          </button>
        </div>
      </Overlay>
    )
  // 取原图通常一两百毫秒：加载态只留一个转圈，不再弹出随即被原图顶掉的文字卡片。
  return (
    <Overlay onClose={onClose} tier="raised">
      <div role="status" aria-label={t('reference.loading')}>
        <LoaderCircle className="h-8 w-8 animate-spin text-primary" aria-hidden />
      </div>
    </Overlay>
  )
}

function ReferenceThumbnail({
  reference,
  messageId,
  index,
  name,
}: {
  reference: NonNullable<AgentTextMessage['references']>[number]
  messageId: string
  index: number
  /** 同名参考图编号后的显示名；没名字的传 undefined，走序号标签。 */
  name: string | undefined
}) {
  const { t } = useTranslation('agent')
  const conversationId = useAgentStore((state) => state.conversationId)
  const scope = scopedStorageName('media')
  const local = 'dataUrl' in reference ? reference.dataUrl : undefined
  // 服务端按下标发这张图，两种快照都认：内联那一路存在对象存储里，按 id 那一路仍是云媒体原件。
  const remote =
    'image' in reference
      ? reference.image.object
      : 'mediaId' in reference
        ? reference.mediaId
        : undefined
  const mask =
    'maskDataUrl' in reference
      ? reference.maskDataUrl
      : 'mask' in reference
        ? reference.mask?.object
        : undefined
  const regionsVersion = 'regions' in reference ? JSON.stringify(reference.regions) : ''
  const identity = useMemo(
    () => ({}),
    [scope, conversationId, messageId, index, remote, local, mask, regionsVersion],
  )
  const [preview, setPreview] = useState<{ identity: typeof identity; source?: string }>()
  const [openIdentity, setOpenIdentity] = useState<typeof identity>()
  useEffect(() => {
    if (local !== undefined || !conversationId || !remote) return
    const controller = new AbortController()
    let source: string | undefined
    void fetchMessageReference(conversationId, messageId, index, {
      signal: controller.signal,
    }).then(
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
  }, [local, conversationId, messageId, index, remote, identity])
  const [markedPreview, setMarkedPreview] = useState<{
    identity: typeof identity
    source?: string
  }>()
  useEffect(() => {
    if (!local || !mask) return
    let active = true
    void createMaskPreviewDataUrl(
      local,
      mask,
      'regions' in reference ? reference.regions : undefined,
    )
      .then((source) => {
        if (active) setMarkedPreview({ identity, source })
      })
      .catch(() => {
        if (active) setMarkedPreview({ identity })
      })
    return () => {
      active = false
    }
  }, [local, mask, identity, reference])
  const localPreview = mask
    ? markedPreview?.identity === identity
      ? markedPreview.source
      : undefined
    : local
  const source = localPreview ?? (preview?.identity === identity ? preview.source : undefined)
  const label = name || getImageMentionLabel(index)
  const failed =
    (!local && preview?.identity === identity && !preview.source) ||
    Boolean(local && mask && markedPreview?.identity === identity && !markedPreview.source)
  return (
    <>
      <button
        type="button"
        className="mention-tag agent-image-mention !cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={
          failed
            ? `${label} · ${t('creations.previewUnavailable')}`
            : t('reference.view', { label })
        }
        aria-label={t('reference.view', { label })}
        disabled={Boolean(local && mask && markedPreview?.identity !== identity)}
        onClick={() => setOpenIdentity(identity)}
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
        <span className="max-w-36 truncate">{name ? `@${name}` : label}</span>
      </button>
      {openIdentity === identity && (
        <ReferencePreview
          local={localPreview}
          conversationId={conversationId}
          messageId={messageId}
          index={index}
          onClose={() => setOpenIdentity(undefined)}
        />
      )}
    </>
  )
}

export default memo(function AgentUserMessage({
  message,
  skills,
}: {
  message: AgentTextMessage
  skills: readonly AgentSkillSummary[]
}) {
  const { t } = useTranslation('agent')
  const masked = message.references?.some(
    (reference) =>
      ('maskDataUrl' in reference && reference.maskDataUrl) ||
      ('mask' in reference && reference.mask),
  )
  // Compatibility for existing edit messages; the transport text remains untouched.
  const prefixes = [
    '请根据附图的标注区域进行局部重绘，未标注区域保持原样。',
    'Inpaint the marked area in the attached image. Keep the unmarked area unchanged.',
    '请擦除附图标注区域内的内容，并自然补全背景；未标注区域保持原样。',
    'Remove the content in the marked area and fill the background naturally. Keep the unmarked area unchanged.',
  ]
  const prefix = masked && prefixes.find((prefix) => message.text.startsWith(prefix))
  const visible = prefix
    ? message.text.slice(prefix.length).trim() ||
      t(prefixes.indexOf(prefix) < 2 ? 'tool.inpaint' : 'tool.erase')
    : message.text
  const invocation = getLeadingAgentSkill(visible, skills)
  const text = invocation ? invocation.rest : visible
  const content: ReactNode[] = []
  const inlined = new Set<number>()
  const names = referenceDisplayNames(message.references ?? [])
  let from = 0
  for (const match of text.matchAll(/\[image ([1-9]\d*)\]/g)) {
    const index = Number(match[1]) - 1
    const reference = message.references?.[index]
    if (!reference) continue
    inlined.add(index)
    content.push(text.slice(from, match.index))
    content.push(
      <ReferenceThumbnail
        key={match.index}
        reference={reference}
        messageId={message.id}
        index={index}
        name={names[index]}
      />,
    )
    from = match.index + match[0].length
  }
  content.push(text.slice(from))
  // 画布选区自动带上的参考图在提示词里没有胶囊，正文因此没有 `[image N]` 可挂。它们照样是
  // 这条消息发出去的东西：排在气泡上方，发出的那一刻、换成服务端 id 之后、以及重新读回
  // 历史时都是同一份列表，看到的就一样。
  const attached = (message.references ?? []).flatMap((reference, index) =>
    inlined.has(index) ? [] : [{ reference, index }],
  )
  return (
    <div className="flex flex-col items-end gap-1.5">
      {attached.length > 0 && (
        <div className="flex max-w-[86%] flex-wrap justify-end gap-1.5">
          {attached.map(({ reference, index }) => (
            <ReferenceThumbnail
              key={index}
              reference={reference}
              messageId={message.id}
              index={index}
              name={names[index]}
            />
          ))}
        </div>
      )}
      <p className={`${USER_BUBBLE} studio-agent-user-message`}>
        {invocation && <AgentSkillBadge skill={invocation.skill} />}
        {content}
      </p>
    </div>
  )
})
