import type { AgentSkillSummary } from '@image-playground/shared'
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TooltipIconButton } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import { ImagePreview } from '../../../components/Lightbox'
import MediaImage from '../../../components/MediaImage'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { scopedStorageName } from '../../../lib/authScope'
import { visibleBidiControls } from '../../../lib/bidiControls'
import { createMaskPreviewDataUrl } from '../../../lib/canvasImage'
import { mediaIdentity } from '../../../lib/cloudMedia'
import {
  localAttachmentFailure,
  localAttachmentIdentity,
} from '../../../lib/localAttachmentSources'
import { USER_BUBBLE } from '../agentStyles'
import { fetchMessageReference } from '../lib/agentClient'
import { getLeadingAgentSkill } from '../lib/agentSkillMentions'
import { fillAgentComposer } from '../lib/composerFill'
import {
  agentImageMentionLabel,
  editableImageMentionText,
  imageMentionSpans,
} from '../lib/imageMentions'
import {
  fitReferenceRow,
  REFERENCE_ROW_FALLBACK,
  referenceChipChrome,
  referenceFoldChrome,
} from '../lib/referenceStrip'
import { useAgentStore } from '../store'
import type { AgentTextMessage } from '../types'
import AgentSkillBadge from './AgentSkillBadge'

let referenceMeasure: CanvasRenderingContext2D | null | undefined

function referenceTextWidth(text: string, font: string): number {
  if (referenceMeasure === undefined) {
    referenceMeasure = document.createElement('canvas').getContext('2d')
  }
  if (!referenceMeasure) return text.length * 13
  referenceMeasure.font = font
  return referenceMeasure.measureText(text).width
}

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
          <Button
            type="button"
            variant="ghost"
            className="ml-4 h-auto min-h-11 px-0 py-0 text-base font-normal text-foreground underline hover:bg-transparent hover:text-foreground"
            onClick={onClose}
          >
            {t('common:action.close')}
          </Button>
        </div>
      </Overlay>
    )
  // 取原图通常一两百毫秒：加载态只留一个转圈，不再弹出随即被原图顶掉的文字卡片。
  return (
    <Overlay onClose={onClose} tier="raised">
      <div role="status" aria-label={t('reference.loading')}>
        <Icon name="loading" className="size-8 animate-spin text-primary" />
      </div>
    </Overlay>
  )
}

function ReferenceThumbnail({
  reference,
  messageId,
  index,
  pending,
}: {
  reference: NonNullable<AgentTextMessage['references']>[number]
  messageId: string
  index: number
  pending: boolean
}) {
  const { t } = useTranslation('agent')
  const conversationId = useAgentStore((state) => state.conversationId)
  const scope = scopedStorageName('media')
  const sourceHandle = 'dataUrl' in reference ? reference.dataUrl : undefined
  const deferred =
    sourceHandle &&
    (mediaIdentity(sourceHandle) ||
      localAttachmentIdentity(sourceHandle) ||
      localAttachmentFailure(sourceHandle))
  // Older live messages can retain a released local handle. Once accepted, the message endpoint
  // owns both thumbnails and annotated originals; internal handles are never browser image URLs.
  const local = deferred && !pending ? undefined : sourceHandle
  // 服务端按下标发这张图，两种快照都认：内联那一路存在对象存储里，按 id 那一路仍是云媒体原件。
  const remote =
    'image' in reference
      ? reference.image.object
      : 'mediaId' in reference
        ? reference.mediaId
        : deferred && !pending
          ? sourceHandle
          : undefined
  const mask =
    'maskDataUrl' in reference
      ? reference.maskDataUrl
      : 'mask' in reference
        ? reference.mask?.object
        : 'mediaId' in reference
          ? reference.maskMediaId
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
  const label = agentImageMentionLabel(index)
  const failed =
    (!local && preview?.identity === identity && !preview.source) ||
    Boolean(local && mask && markedPreview?.identity === identity && !markedPreview.source)
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="mention-tag agent-image-mention h-auto w-auto cursor-zoom-in px-0 font-normal hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
        title={
          failed
            ? `${label} · ${t('creations.previewUnavailable')}`
            : t('reference.view', { label })
        }
        aria-label={t('reference.view', { label })}
        disabled={Boolean(
          (pending && deferred) || (local && mask && markedPreview?.identity !== identity),
        )}
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
          <Icon name="image" className="size-6 shrink-0 p-1" />
        )}
        <span className="max-w-36 truncate">{label}</span>
      </Button>
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

function ReferenceStrip({
  messageId,
  pending,
  attached,
}: {
  messageId: string
  pending: boolean
  attached: readonly {
    reference: NonNullable<AgentTextMessage['references']>[number]
    index: number
  }[]
}) {
  const { t } = useTranslation('agent')
  const stripRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [box, setBox] = useState({ available: 0, font: '', gap: 6, root: 16 })
  // 网络字体晚到时栏宽不变，但同一段文字变宽或变窄；换完字体要重新量一次。
  const [fontsLoaded, setFontsLoaded] = useState(0)

  useEffect(() => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts
    if (!fonts) return
    let active = true
    const remeasure = () => {
      if (active) setFontsLoaded((count) => count + 1)
    }
    void fonts.ready.then(remeasure)
    fonts.addEventListener('loadingdone', remeasure)
    return () => {
      active = false
      fonts.removeEventListener('loadingdone', remeasure)
    }
  }, [])

  useLayoutEffect(() => {
    const node = stripRef.current
    const parent = node?.parentElement
    if (!parent) return
    const read = () => {
      const width = parent.clientWidth
      const available = width > 0 ? Math.floor(width * 0.86) - 8 : 0
      const sample = node.querySelector<HTMLElement>('.mention-tag')
      const font = sample ? getComputedStyle(sample).font : ''
      const gap = Number.parseFloat(getComputedStyle(node).columnGap)
      const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
      const next = {
        available,
        font,
        gap: Number.isFinite(gap) ? gap : 6,
        root: Number.isFinite(rootSize) && rootSize > 0 ? rootSize : 16,
      }
      setBox((prev) =>
        prev.available === next.available &&
        prev.font === next.font &&
        prev.gap === next.gap &&
        prev.root === next.root
          ? prev
          : next,
      )
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [attached.length])

  const fitted = useMemo(() => {
    if (!(box.available > 0)) return Math.min(REFERENCE_ROW_FALLBACK, attached.length)
    const font = box.font || '500 13px sans-serif'
    const chipWidths = attached.map(({ index }) => {
      const label = agentImageMentionLabel(index)
      return Math.min(box.root * 9, referenceTextWidth(label, font)) + referenceChipChrome(box.root)
    })
    return fitReferenceRow(
      box.available,
      chipWidths,
      (hidden) =>
        referenceTextWidth(t('reference.more', { count: hidden }), font) +
        referenceFoldChrome(box.root),
      box.gap,
      REFERENCE_ROW_FALLBACK,
    )
    // fontsLoaded 只用来在字体就绪后让这里重算。
  }, [attached, box, t, fontsLoaded])

  const folded = fitted < attached.length
  const shown = expanded ? attached : attached.slice(0, fitted)
  return (
    <div
      ref={stripRef}
      className="agent-reference-strip flex max-w-[86%] flex-wrap justify-end gap-1.5"
    >
      {shown.map(({ reference, index }) => (
        <ReferenceThumbnail
          key={index}
          reference={reference}
          messageId={messageId}
          index={index}
          pending={pending}
        />
      ))}
      {folded && (
        <Button
          type="button"
          variant="ghost"
          className="mention-tag agent-reference-fold h-auto w-auto px-0 font-normal hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t('reference.collapse')
            : fitted === 0
              ? t('reference.folded', { count: attached.length })
              : t('reference.more', { count: attached.length - fitted })}
          <Icon name="chevronDown" className={`size-3.5${expanded ? ' rotate-180' : ''}`} />
        </Button>
      )}
    </div>
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
      ('mask' in reference && reference.mask) ||
      ('mediaId' in reference && reference.maskMediaId),
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
  const references = message.references ?? []
  const editableText = editableImageMentionText(visible, references)
  let from = 0
  for (const span of imageMentionSpans(text, references)) {
    const reference = references[span.index]
    if (!reference) continue
    inlined.add(span.index)
    content.push(...visibleBidiControls(text.slice(from, span.start), `text-${from}`))
    content.push(
      <ReferenceThumbnail
        key={span.start}
        reference={reference}
        messageId={message.id}
        index={span.index}
        pending={Boolean(message.pending)}
      />,
    )
    from = span.end
  }
  content.push(...visibleBidiControls(text.slice(from), `text-${from}`))
  // 画布选区自动带上的参考图在提示词里没有胶囊，正文因此没有 `[image N]` 可挂。它们照样是
  // 这条消息发出去的东西：排在气泡上方，发出的那一刻、换成服务端 id 之后、以及重新读回
  // 历史时都是同一份列表，看到的就一样。
  const attached = (message.references ?? []).flatMap((reference, index) =>
    inlined.has(index) ? [] : [{ reference, index }],
  )
  return (
    <div className="flex flex-col items-end gap-1.5">
      {attached.length > 0 && (
        <ReferenceStrip
          messageId={message.id}
          pending={Boolean(message.pending)}
          attached={attached}
        />
      )}
      {/* dir=auto 让气泡自成一个隔离的方向上下文：内容里的方向字符不会影响外面的版式。 */}
      <p dir="auto" className={`${USER_BUBBLE} studio-agent-user-message [unicode-bidi:isolate]`}>
        {invocation && <AgentSkillBadge skill={invocation.skill} />}
        {content}
      </p>
      <TooltipIconButton
        tooltip={t('userMessage.reedit')}
        onClick={() => fillAgentComposer({ text: editableText, replace: true })}
      >
        <Icon name="edit" />
      </TooltipIconButton>
    </div>
  )
})
