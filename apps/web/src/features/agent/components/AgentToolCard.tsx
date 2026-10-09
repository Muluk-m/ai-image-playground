import type { AgentToolArtifact } from '@image-playground/shared'
import {
  ArrowUpRight,
  Download,
  Ellipsis,
  FileText,
  Images,
  Maximize2,
  RotateCw,
  Square,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ImageGallery } from '../../../components/assistant-ui/elements/image-gallery'
import { ImageGeneration } from '../../../components/assistant-ui/elements/image-generation'
import { MessageActions } from '../../../components/assistant-ui/elements/message-actions'
import { StoppedRun } from '../../../components/assistant-ui/elements/stopped-run'
import { ToolCall } from '../../../components/assistant-ui/elements/tool-call'
import { ToolError } from '../../../components/assistant-ui/elements/tool-error'
import { ToolStatus } from '../../../components/assistant-ui/elements/tool-status'
import { Button } from '../../../components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { useTranslation } from '../../../i18n'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import type { ProductionPane } from '../../production/lib/productionContext'
import PlayBadge from '../../video/components/PlayBadge'
import {
  CARD,
  CARD_NOTE,
  CARD_TITLE,
  GHOST_LINK,
  THUMBNAIL,
  THUMBNAIL_STATIC,
} from '../agentStyles'
import { fetchedCanvasId } from '../lib/artifactDelivery'
import {
  type AgentArtifactPreview,
  type AgentFetchedPreview,
  artifactPreview,
  fetchedImagePreview,
  INLINE_RESULT_THUMBNAIL_SCALE,
} from '../lib/artifactPreview'
import { previewArtifactBitmap } from '../lib/artifactSource'
import { agentCanvasSink } from '../lib/canvasSink'
import { agentRerunBlock, agentRetryRemaining, agentRetrySlotTasks } from '../lib/retry'
import {
  agentToolFailureAction,
  agentToolFailureActionLabel,
  agentToolFailureText,
  runAgentToolFailureAction,
} from '../lib/toolFailure'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'
import AgentBatchPlanCard from './AgentBatchPlanCard'
import AgentCopyDiagnostic from './AgentCopyDiagnostic'
import AgentIconButton from './AgentIconButton'
import AgentJobProgress, { AgentJobCancel, useAgentToolProgress } from './AgentJobProgress'
import AgentPromptDialog from './AgentPromptDialog'
import AgentPromptDraft from './AgentPromptDraft'
import AgentVideoToolCard from './AgentVideoToolCard'

const NO_ARTIFACTS: readonly AgentToolArtifact[] = []

function useStatusNote(
  message: AgentToolMessage,
  offCanvas: boolean,
  hasProgress: boolean,
): string | null {
  const { t } = useTranslation(['agent', 'common'])
  // 生成的阶段与已用时间由进度条说，这里不再重复；不出图的调用只说在准备。
  if (message.status === 'running') return hasProgress ? null : t('tool.preparing')
  // 后台任务：调用已经交还对话，结果要等任务自己跑完。
  if (message.status === 'submitted') return t('tool.background')
  // 重试队列里排着：前一条重试结束后才提交，还没扣费。
  if (message.status === 'queued') return t('retry.queued')
  // 排着时就撤回的重试：从没提交过，也就没有要退的钱。
  if (
    message.status === 'failed' &&
    message.errorCode === 'cancelled' &&
    message.retryOf &&
    !message.job
  )
    return t('retry.withdrawn')
  // 用户取消的后台任务：预扣的按原桶退回，卡上说清楚钱回来了。
  if (message.status === 'failed' && message.errorCode === 'cancelled' && message.job)
    return isClientCapabilityEnabled('billing:credits')
      ? t('job.cancelledRefunded')
      : t('job.cancelled')
  // 有错误码就只认码（ADR 0006）；旧记录没有码，照旧显示当时存下的那句话。
  if (message.status === 'failed')
    return agentToolFailureText(message.errorCode) ?? message.message ?? t('tool.notFinished')
  if (message.delivery === 'pending') return t('tool.delivering')
  // 失败要说清为什么没写入；其余只说画布上现在有没有它（切过画布、或用户删掉了）。
  if (message.delivery === 'failed') return t('tool.deliveryFailed')
  return offCanvas ? t('tool.offCanvas') : null
}

/** 交付还在途时不取图：那一份正在下载，结果卡等它落画布。 */
function previewable(message: AgentToolMessage): readonly AgentToolArtifact[] {
  if (message.status !== 'succeeded') return NO_ARTIFACTS
  if (message.delivery === undefined || message.delivery === 'pending') return NO_ARTIFACTS
  return message.artifacts ?? NO_ARTIFACTS
}

function useArtifactPreviews(
  message: AgentToolMessage,
  inline: boolean,
): readonly AgentArtifactPreview[] {
  const [previews, setPreviews] = useState<readonly AgentArtifactPreview[]>([])
  const artifacts = previewable(message)
  // 交付状态变了就重问一遍；卡重新挂载（折叠面板、切页签）也重问，所以画布上删掉的图能被发现。
  const key = `${inline}:${message.delivery}:${artifacts.map((one) => one.artifactId).join(' ')}`

  useEffect(() => {
    let alive = true
    if (!artifacts.length) {
      setPreviews([])
      return
    }
    void Promise.all(
      artifacts.map((artifact) =>
        artifactPreview(artifact, inline ? INLINE_RESULT_THUMBNAIL_SCALE : undefined),
      ),
    ).then((next) => {
      if (alive) setPreviews(next)
    })
    return () => {
      alive = false
    }
    // artifacts 每次渲染都是新数组，用它的 id 与交付状态合成的 key 当依赖。
  }, [key])

  return previews
}

function Thumbnail({
  preview,
  onViewCanvas,
  onPreview,
}: {
  preview: AgentArtifactPreview
  onViewCanvas?: (objectIds?: readonly string[]) => void
  onPreview?: (id: string) => void
}) {
  const { artifact, source, onCanvas } = preview
  if (!source) return null
  const badge = artifact.media === 'video' && (
    <span className="absolute inset-0 grid scale-50 place-items-center">
      <PlayBadge />
    </span>
  )
  const image = <img src={source} alt="" className="h-full w-full object-cover" />
  if (onPreview)
    return (
      <button type="button" className={THUMBNAIL} onClick={() => onPreview(artifact.artifactId)}>
        {image}
        {badge}
      </button>
    )
  // 不在画布上就没有可定位的对象，那张图只是看一眼，不做成按钮。
  if (!onCanvas)
    return (
      <span className={THUMBNAIL_STATIC}>
        {image}
        {badge}
      </span>
    )
  return (
    <button
      type="button"
      className={THUMBNAIL}
      onClick={() =>
        onViewCanvas
          ? onViewCanvas([artifact.artifactId])
          : agentCanvasSink()?.focus([artifact.artifactId])
      }
    >
      {image}
      {badge}
    </button>
  )
}

/** 取回来的那几张网图此刻的样子；交付还在途时先不取图，那一份正在下载。 */
function useFetchedPreviews(
  message: AgentToolMessage,
  inline: boolean,
): readonly AgentFetchedPreview[] {
  const [previews, setPreviews] = useState<readonly AgentFetchedPreview[]>([])
  const images = message.delivery === 'pending' ? undefined : message.fetchedImages
  const key = `${inline}:${message.delivery}:${(images ?? []).map((one) => one.imageId).join(' ')}`

  useEffect(() => {
    let alive = true
    if (!images?.length) {
      setPreviews([])
      return
    }
    void Promise.all(
      images.map((image, index) =>
        fetchedImagePreview(
          image,
          fetchedCanvasId(message.toolCallId, index),
          inline ? INLINE_RESULT_THUMBNAIL_SCALE : undefined,
        ),
      ),
    ).then((next) => {
      if (alive) setPreviews(next)
    })
    return () => {
      alive = false
    }
    // images 每次渲染都是新数组，用它的 id 与交付状态合成的 key 当依赖。
  }, [key])

  return previews
}

/** 链接上只写站点，不写整条地址：地址常常很长，卡上一行放不下，站点才是用户要认的那一项。 */
function sourceHost(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** 取回来的网图：缩略图加一个回到来源的链接——版权在对方那里，来源不能只留在模型的话里。 */
function FetchedImages({
  previews,
  onViewCanvas,
  onPreview,
}: {
  previews: readonly AgentFetchedPreview[]
  onViewCanvas?: (objectIds?: readonly string[]) => void
  onPreview?: (id: string) => void
}) {
  const { t } = useTranslation('agent')
  if (!previews.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {previews.map(({ objectId, source, onCanvas }) => {
          if (!source) return null
          const bitmap = <img src={source} alt="" className="h-full w-full object-cover" />
          if (onPreview)
            return (
              <button
                key={objectId}
                type="button"
                className={THUMBNAIL}
                onClick={() => onPreview(objectId)}
              >
                {bitmap}
              </button>
            )
          return onCanvas ? (
            <button
              key={objectId}
              type="button"
              className={THUMBNAIL}
              onClick={() =>
                onViewCanvas ? onViewCanvas([objectId]) : agentCanvasSink()?.focus([objectId])
              }
            >
              {bitmap}
            </button>
          ) : (
            <span key={objectId} className={THUMBNAIL_STATIC}>
              {bitmap}
            </span>
          )
        })}
      </div>
      {previews.map(({ image, objectId }) => (
        <a
          key={objectId}
          href={image.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          title={t('fetchedImage.sourceTitle')}
          className={`self-start ${GHOST_LINK}`}
        >
          {sourceHost(image.sourceUrl)}
        </a>
      ))}
    </div>
  )
}

/**
 * 失败卡按错误码给的那一个出路；没有码或这类失败没有出路时不渲染。
 * 本该由重试收场、这次生成却重出不了时（局部或连锁改图、模型已下线），改由智能体重新处理——
 * 否则这张卡上一个按钮都没有。
 */
function FailureAction({ message }: { message: AgentToolMessage }) {
  useTranslation('agent')
  const code = message.errorCode
  const block = agentRerunBlock(message)
  const action = agentToolFailureAction(code, block)
  if (!code || !action) return null
  return (
    <AgentIconButton
      icon={RotateCw}
      label={agentToolFailureActionLabel(action, code)}
      onClick={() =>
        runAgentToolFailureAction(action, {
          code,
          title: message.title,
          block,
          send: (text) => void useAgentStore.getState().send(text),
        })
      }
    />
  )
}

/** 任务结束后本该唤醒智能体却没有唤醒：说明它没有查看这个结果，以及为什么。 */
function WakeSkippedNote({ message }: { message: AgentToolMessage }) {
  const { t } = useTranslation('agent')
  if (!message.wakeSkipped) return null
  return (
    <p className={CARD_NOTE}>
      {message.wakeSkipped === 'insufficient_credits'
        ? t('job.wakeSkipped.insufficient_credits')
        : t('job.wakeSkipped.wake_limit')}
    </p>
  )
}

/** 结果卡在面板里的 DOM id：重试记录凭它跳回原失败卡。 */
export function agentToolCardDomId(messageId: string): string {
  return `agent-tool-card-${messageId}`
}

/** 排着的重试就地撤回：失败占位保持原来那次失败。撤回失败就在原处说一声，卡保持原样。 */
export function AgentRetryWithdraw({
  message,
  className,
}: {
  message: AgentToolMessage
  className?: string
}) {
  const { t } = useTranslation('agent')
  const [state, setState] = useState<'idle' | 'withdrawing' | 'failed'>('idle')
  if (message.status !== 'queued' || !message.retryOf) return null
  return (
    <span className="inline-flex items-center gap-2">
      <AgentIconButton
        icon={Square}
        label={state === 'withdrawing' ? t('retry.withdrawing') : t('retry.withdraw')}
        disabled={state === 'withdrawing'}
        className={className}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          setState('withdrawing')
          useAgentStore
            .getState()
            .cancelJob(message.id)
            .then(
              () => setState('idle'),
              () => setState('failed'),
            )
        }}
      />
      {state === 'failed' && <span className={CARD_NOTE}>{t('retry.withdrawFailed')}</span>}
    </span>
  )
}

/**
 * 一键补齐：这张失败卡在画布上剩下的失败占位逐个重试，第一条当场提交，其余在服务端排队。
 * 只有原卡能原样重试、画布上还剩可重试的失败占位时才出现。
 */
function RetryRemaining({ message }: { message: AgentToolMessage }) {
  const { t } = useTranslation('agent')
  const messages = useAgentStore((state) => state.messages)
  const refusals = useAgentStore((state) => state.retryRefusals)
  const [pending, setPending] = useState(false)
  if (message.status !== 'failed' || message.retryOf) return null
  const placeholders =
    agentCanvasSink()?.failedPlaceholders?.({
      messageId: message.id,
      taskIds: agentRetrySlotTasks(messages, message),
    }) ?? []
  const remaining = agentRetryRemaining(messages, message, placeholders, refusals)
  if (remaining.length === 0) return null
  return (
    <AgentIconButton
      icon={RotateCw}
      busy={pending}
      disabled={pending}
      label={t('retry.retryRemaining', { count: remaining.length })}
      onClick={() => {
        setPending(true)
        void useAgentStore
          .getState()
          .retryRemaining(message.id)
          .finally(() => setPending(false))
      }}
    />
  )
}

/** 重试记录的那一行：指回原失败卡。还在跑时和别的后台任务一样由「取消任务」中止，按原桶退回。 */
function RetryRecord({ message }: { message: AgentToolMessage }) {
  const { t } = useTranslation('agent')
  const origin = message.retryOf
  if (!origin) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <AgentRetryWithdraw message={message} />
      <AgentIconButton
        icon={ArrowUpRight}
        label={t('retry.viewOriginal')}
        onClick={() => {
          const card = document.getElementById(agentToolCardDomId(origin.messageId))
          card?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
          card?.focus({ preventScroll: true })
        }}
      />
    </div>
  )
}

function StandardAgentToolCard({
  message,
  onViewCanvas,
  onPreviewResult,
  compactFetched = false,
  onPreviewProduction,
}: {
  message: AgentToolMessage
  onViewCanvas?: (objectIds?: readonly string[]) => void
  onPreviewResult?: (messageId: string, objectId?: string, previewSource?: string) => void
  compactFetched?: boolean
  onPreviewProduction?: (pane?: ProductionPane) => void
}) {
  const { t } = useTranslation(['agent', 'common'])
  const [promptOpen, setPromptOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const downloadingRef = useRef(new Set<string>())
  const [downloading, setDownloading] = useState<ReadonlySet<string>>(new Set())
  const [downloadFailed, setDownloadFailed] = useState(false)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>()
  const [imageRatios, setImageRatios] = useState<Record<string, number>>({})
  const downloadTile = async (tile: { id: string; original: () => Promise<string | null> }) => {
    if (downloadingRef.current.has(tile.id)) return
    downloadingRef.current.add(tile.id)
    setDownloading(new Set(downloadingRef.current))
    setDownloadFailed(false)
    try {
      const source = await tile.original()
      if (!source) throw new Error('image_unavailable')
      const link = document.createElement('a')
      link.href = source
      link.download = `muvloom-${tile.id}.png`
      link.click()
    } catch {
      setDownloadFailed(true)
    } finally {
      downloadingRef.current.delete(tile.id)
      setDownloading(new Set(downloadingRef.current))
    }
  }
  const previews = useArtifactPreviews(message, Boolean(onPreviewResult))
  const fetched = useFetchedPreviews(message, Boolean(onPreviewResult))
  const openPreviewResult = (objectId?: string) => {
    const selectedId = objectId ?? previews[0]?.artifact.artifactId ?? fetched[0]?.objectId
    const source =
      previews.find((preview) => preview.artifact.artifactId === selectedId)?.source ??
      fetched.find((preview) => preview.objectId === selectedId)?.source
    if (source) onPreviewResult?.(message.id, selectedId, source)
    else onPreviewResult?.(message.id, objectId)
  }
  // 取回来的网图取不到预览时不算「可以放入画布」：放进去的那一步同样取不到字节。
  const offCanvas =
    previews.some((preview) => !preview.onCanvas) ||
    fetched.some((preview) => !preview.onCanvas && preview.source)
  const progress = useAgentToolProgress(message)
  const note = useStatusNote(message, onPreviewResult ? false : offCanvas, progress !== null)
  const imageGenerating =
    progress !== null &&
    (message.toolName === 'generateImage' || message.toolName === 'editImage') &&
    previews.length === 0
  const status =
    message.status === 'failed' || message.delivery === 'failed'
      ? 'failed'
      : message.status === 'queued'
        ? 'queued'
        : message.status === 'awaiting_confirmation'
          ? 'waiting'
          : message.status === 'running' || message.status === 'submitted' || progress
            ? 'running'
            : 'succeeded'
  const statusLabel =
    status === 'failed'
      ? message.delivery === 'failed' && message.status !== 'failed'
        ? t('tool.status.deliveryFailed')
        : t('tool.status.failed')
      : status === 'queued'
        ? t('tool.status.queued')
        : status === 'waiting'
          ? t('tool.status.waiting')
          : status === 'running'
            ? t('tool.status.running')
            : t('tool.status.succeeded')
  const canvasIds = previews
    .filter((preview) => preview.onCanvas)
    .map((preview) => preview.artifact.artifactId)
  const viewCanvas = () => {
    if (onViewCanvas) onViewCanvas(canvasIds)
    else agentCanvasSink()?.focus(canvasIds)
  }
  if (message.status === 'awaiting_confirmation') {
    return (
      <div id={agentToolCardDomId(message.id)} tabIndex={-1}>
        <AgentPromptDraft message={message} onPreviewProduction={onPreviewProduction} />
      </div>
    )
  }
  if (
    message.status === 'failed' &&
    message.errorCode === 'cancelled' &&
    !message.artifacts?.length &&
    !message.fetchedImages?.length
  ) {
    return (
      <StoppedRun
        id={agentToolCardDomId(message.id)}
        tabIndex={-1}
        reason={note ?? t('job.cancelled')}
        actions={
          <>
            {message.prompt && (
              <Button variant="ghost" size="sm" onClick={() => setPromptOpen(true)}>
                {t('tool.viewPrompt')}
              </Button>
            )}
            <FailureAction message={message} />
          </>
        }
      >
        <p className="text-sm font-medium leading-relaxed">{message.title}</p>
        <WakeSkippedNote message={message} />
        <RetryRecord message={message} />
        {promptOpen && message.prompt && (
          <AgentPromptDialog prompt={message.prompt} onClose={() => setPromptOpen(false)} />
        )}
      </StoppedRun>
    )
  }
  if (message.status === 'failed' && !message.artifacts?.length && !message.fetchedImages?.length) {
    return (
      <ToolError
        id={agentToolCardDomId(message.id)}
        tabIndex={-1}
        name={message.title}
        message={note ?? t('tool.notFinished')}
        actions={
          <>
            <FailureAction message={message} />
            <RetryRemaining message={message} />
            <AgentCopyDiagnostic
              diagnostic={{
                code: message.errorCode,
                message: message.message,
                turnId: message.turnId,
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                taskId: message.job?.taskId,
              }}
            />
          </>
        }
      >
        {message.prompt && (
          <AgentIconButton
            label={t('tool.viewPrompt')}
            icon={FileText}
            onClick={() => setPromptOpen(true)}
          />
        )}
        {promptOpen && message.prompt && (
          <AgentPromptDialog prompt={message.prompt} onClose={() => setPromptOpen(false)} />
        )}
        <WakeSkippedNote message={message} />
        <RetryRecord message={message} />
      </ToolError>
    )
  }
  if (
    !progress &&
    !message.artifacts?.length &&
    !message.fetchedImages?.length &&
    message.status !== 'failed'
  ) {
    return (
      <ToolCall
        id={agentToolCardDomId(message.id)}
        tabIndex={-1}
        label={
          message.skill?.found === false
            ? t('tool.skillNotFound', { name: message.skill.label })
            : message.title
        }
        activeLabel={message.title}
        running={status === 'running' || status === 'queued'}
      >
        <div className="flex flex-col gap-2">
          {/* 跑着、做完已经由星号和流光说清楚；只有排队、待确认这种要另说一句。 */}
          {(status === 'queued' || status === 'waiting') && (
            <ToolStatus label={statusLabel} status={status} />
          )}
          {note && <p className={CARD_NOTE}>{note}</p>}
          {message.sources?.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              className={GHOST_LINK}
              title={source.title}
            >
              {sourceHost(source.url)}
            </a>
          ))}
          {message.prompt && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setPromptOpen(true)}
            >
              {t('tool.viewPrompt')}
            </Button>
          )}
          <AgentJobCancel message={message} />
          <WakeSkippedNote message={message} />
          <RetryRecord message={message} />
        </div>
        {promptOpen && message.prompt && (
          <AgentPromptDialog prompt={message.prompt} onClose={() => setPromptOpen(false)} />
        )}
      </ToolCall>
    )
  }
  if (imageGenerating && progress) {
    return (
      <div
        id={agentToolCardDomId(message.id)}
        tabIndex={-1}
        className="studio-agent-generation-card"
      >
        <div className="studio-agent-generation-body">
          <div className="flex min-w-0 items-center gap-2">
            <p className="studio-agent-generation-title flex-1" title={message.title}>
              {message.title}
            </p>
            {message.prompt && (
              <AgentIconButton
                label={t('tool.viewPrompt')}
                icon={FileText}
                onClick={() => setPromptOpen(true)}
              />
            )}
            <AgentJobCancel message={message} />
          </div>
          <AgentJobProgress progress={progress} />
          <ImageGeneration generating={progress.phase !== 'delivering'} aria-hidden="true" />
          <RetryRecord message={message} />
        </div>
        {promptOpen && message.prompt && (
          <AgentPromptDialog prompt={message.prompt} onClose={() => setPromptOpen(false)} />
        )}
      </div>
    )
  }
  if (
    status === 'succeeded' &&
    (previews.length > 0 ||
      fetched.length > 0 ||
      (compactFetched && message.fetchedImages?.length)) &&
    onPreviewResult
  ) {
    const fetchedTiles = fetched.length
      ? fetched.map((preview) => ({
          id: preview.objectId,
          source: preview.source,
          media: 'image' as const,
          original: () =>
            resolveMediaSource(`aip-media:${preview.image.imageId}`, 'original', true),
        }))
      : compactFetched
        ? (message.fetchedImages ?? []).map((image, index) => ({
            id: fetchedCanvasId(message.toolCallId, index),
            source: null,
            media: 'image' as const,
            original: () => resolveMediaSource(`aip-media:${image.imageId}`, 'original', true),
          }))
        : []
    const tiles = [
      ...previews.map((preview) => ({
        id: preview.artifact.artifactId,
        source: preview.source,
        media: preview.artifact.media,
        ratio:
          preview.artifact.width && preview.artifact.height
            ? preview.artifact.width / preview.artifact.height
            : undefined,
        original: () => previewArtifactBitmap(preview.artifact),
      })),
      ...fetchedTiles,
    ]
    const renderTile = (tile: (typeof tiles)[number], index: number) => (
      <div
        className="studio-agent-inline-tile"
        key={tile.id}
        style={{
          aspectRatio: imageRatios[tile.id] ?? ('ratio' in tile ? tile.ratio : undefined),
        }}
      >
        <button
          type="button"
          className="studio-agent-inline-open"
          aria-label={t('tool.openResultNumber', { number: index + 1 })}
          onClick={() => openPreviewResult(tile.id)}
        >
          {tile.source ? (
            <img
              src={tile.source}
              alt={t('tool.resultNumber', { number: index + 1 })}
              loading="lazy"
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget
                if (naturalWidth && naturalHeight)
                  setImageRatios((ratios) => ({
                    ...ratios,
                    [tile.id]: naturalWidth / naturalHeight,
                  }))
              }}
            />
          ) : (
            <span>{t('tool.previewUnavailable')}</span>
          )}
          {tile.media === 'video' && <PlayBadge />}
        </button>
        <div className="studio-agent-inline-actions">
          <button
            type="button"
            title={t('tool.previewResult')}
            aria-label={t('tool.openResultNumber', { number: index + 1 })}
            onClick={() => openPreviewResult(tile.id)}
          >
            <Maximize2 size={16} />
          </button>
          {tile.media !== 'video' && (
            <button
              type="button"
              title={t('tool.downloadResult')}
              aria-label={t('tool.downloadResult')}
              disabled={downloading.has(tile.id)}
              onClick={() => void downloadTile(tile)}
            >
              <Download size={16} />
            </button>
          )}
          {tile.media !== 'video' && onViewCanvas && (
            <button
              type="button"
              title={t('tool.editOnCanvas')}
              aria-label={t('tool.editOnCanvas')}
              onClick={() => onViewCanvas([tile.id])}
            >
              <Images size={16} />
            </button>
          )}
        </div>
      </div>
    )
    return (
      <div
        id={agentToolCardDomId(message.id)}
        tabIndex={-1}
        className={`studio-agent-inline-result${compactFetched ? ' studio-agent-inline-result--fetched' : ''}${message.toolName === 'generateImage' || message.toolName === 'editImage' ? ' studio-agent-inline-result--generated' : ''}`}
      >
        <div className="studio-agent-inline-meta">
          <ToolStatus label={statusLabel} status={status} />
          <span title={message.title}>{message.title}</span>
        </div>
        {message.toolName === 'generateImage' || message.toolName === 'editImage' ? (
          <ImageGallery
            items={tiles}
            previousLabel={t('tool.previousResult')}
            nextLabel={t('tool.nextResult')}
            itemLabel={(index) => t('tool.resultNumber', { number: index + 1 })}
            renderItem={renderTile}
            onSelect={(tile) => setSelectedArtifactId(tile.id)}
          />
        ) : (
          <div className="studio-agent-inline-gallery" data-count={tiles.length}>
            {tiles.map(renderTile)}
          </div>
        )}
        {message.fetchedImages?.map((image) => (
          <a
            key={image.imageId}
            href={image.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            title={t('fetchedImage.sourceTitle')}
            className="studio-agent-inline-source"
          >
            {sourceHost(image.sourceUrl)}
          </a>
        ))}
        {downloadFailed && (
          <p role="alert" className={CARD_NOTE}>
            {t('tool.downloadFailed')}
          </p>
        )}
        {message.prompt &&
          !(
            previews.some((preview) => preview.artifact.media === 'image') &&
            (message.toolName === 'generateImage' || message.toolName === 'editImage')
          ) && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setPromptOpen(true)}
            >
              {t('tool.viewPrompt')}
            </Button>
          )}
        {previews.some((preview) => preview.artifact.media === 'image') &&
          (message.toolName === 'generateImage' || message.toolName === 'editImage') && (
            <MessageActions
              className="mt-3"
              editLabel={t('tool.editResult')}
              regenerateLabel={t('tool.regenerate')}
              onEdit={() =>
                openPreviewResult(
                  previews.find((preview) => preview.artifact.artifactId === selectedArtifactId)
                    ?.artifact.artifactId ?? previews[0].artifact.artifactId,
                )
              }
              onRegenerate={() =>
                void useAgentStore
                  .getState()
                  .send(
                    t('tool.regenerateRequest', { prompt: message.prompt || message.title }),
                    [],
                    undefined,
                    'image',
                  )
              }
            >
              {(message.prompt || onViewCanvas) && (
                <Popover open={moreOpen} onOpenChange={setMoreOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-8 rounded-xl"
                      aria-label={t('tool.moreActions')}
                    >
                      <Ellipsis size={17} aria-hidden="true" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-48 rounded-xl p-1.5">
                    {message.prompt && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => {
                          setPromptOpen(true)
                          setMoreOpen(false)
                        }}
                      >
                        {t('tool.viewPrompt')}
                      </Button>
                    )}
                    {onViewCanvas && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => {
                          setMoreOpen(false)
                          onViewCanvas(
                            tiles.filter((tile) => tile.media !== 'video').map((tile) => tile.id),
                          )
                        }}
                      >
                        {t('tool.editGroupOnCanvas')}
                      </Button>
                    )}
                  </PopoverContent>
                </Popover>
              )}
            </MessageActions>
          )}
        {promptOpen && message.prompt && (
          <AgentPromptDialog prompt={message.prompt} onClose={() => setPromptOpen(false)} />
        )}
        <WakeSkippedNote message={message} />
        <RetryRecord message={message} />
      </div>
    )
  }
  if (status === 'succeeded' && previews.length > 0 && fetched.length === 0 && !message.retryOf) {
    return (
      <div id={agentToolCardDomId(message.id)} tabIndex={-1} className="studio-agent-result-card">
        <div className="studio-agent-result-media" data-multiple={previews.length > 1 || undefined}>
          {previews.map((preview) =>
            onPreviewResult ? (
              <button
                key={preview.artifact.artifactId}
                type="button"
                className={THUMBNAIL}
                aria-label={t('tool.previewResult')}
                onClick={() => openPreviewResult(preview.artifact.artifactId)}
              >
                {preview.source && (
                  <img src={preview.source} alt="" className="h-full w-full object-cover" />
                )}
                {preview.artifact.media === 'video' && <PlayBadge />}
              </button>
            ) : (
              <Thumbnail
                key={preview.artifact.artifactId}
                preview={preview}
                onViewCanvas={onViewCanvas}
              />
            ),
          )}
        </div>
        <div className="studio-agent-result-body">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">{t('tool.resultTitle')}</span>
            <ToolStatus label={statusLabel} status={status} />
          </div>
          <p className="studio-agent-result-description" title={message.title}>
            {message.title}
          </p>
          {note && <p className={CARD_NOTE}>{note}</p>}
          <WakeSkippedNote message={message} />
          <div className="studio-agent-result-actions">
            {onPreviewResult ? (
              <button type="button" onClick={() => openPreviewResult()}>
                <Images className="h-3.5 w-3.5" aria-hidden="true" />
                {t('tool.previewResult')}
              </button>
            ) : canvasIds.length > 0 ? (
              <button type="button" title={t('tool.locateTitle')} onClick={viewCanvas}>
                <Images className="h-3.5 w-3.5" aria-hidden="true" />
                {t('tool.openCanvas')}
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </button>
            ) : null}
            {message.prompt && !onPreviewResult && (
              <button type="button" onClick={() => setPromptOpen(true)}>
                {t('tool.viewPrompt')}
              </button>
            )}
            {offCanvas && !onPreviewResult && (
              <button
                type="button"
                onClick={() =>
                  void useAgentStore
                    .getState()
                    .placeOnCanvas(message.id)
                    .then(() => onViewCanvas?.())
                }
              >
                {t('tool.place')}
              </button>
            )}
          </div>
        </div>
        {promptOpen && message.prompt && (
          <AgentPromptDialog prompt={message.prompt} onClose={() => setPromptOpen(false)} />
        )}
      </div>
    )
  }
  return (
    <div id={agentToolCardDomId(message.id)} tabIndex={-1} className={CARD}>
      {message.retryOf && (
        <span className="self-start rounded-md border border-border px-1.5 text-label-sm leading-4 text-muted-foreground">
          {t('retry.record')}
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        {!message.prompt && !onPreviewResult && previews.some((preview) => preview.onCanvas) ? (
          <button
            type="button"
            title={t('tool.locateTitle')}
            className={`${CARD_TITLE} min-w-0 text-left`}
            onClick={() => {
              const ids = previews
                .filter((preview) => preview.onCanvas)
                .map((preview) => preview.artifact.artifactId)
              if (onViewCanvas) onViewCanvas(ids)
              else agentCanvasSink()?.focus(ids)
            }}
          >
            {message.title}
          </button>
        ) : (
          <p className={`${CARD_TITLE} min-w-0`}>{message.title}</p>
        )}
        <ToolStatus label={statusLabel} status={status} />
      </div>
      {message.prompt && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setPromptOpen(true)}
        >
          {t('tool.viewPrompt')}
        </Button>
      )}
      {promptOpen && message.prompt && (
        <AgentPromptDialog prompt={message.prompt} onClose={() => setPromptOpen(false)} />
      )}
      {progress && <AgentJobProgress progress={progress} />}
      {note && message.status !== 'failed' && <p className={CARD_NOTE}>{note}</p>}
      <AgentJobCancel message={message} />
      <WakeSkippedNote message={message} />
      {message.status === 'failed' ? (
        <ToolError
          name={t('tool.notFinished')}
          message={note ?? t('tool.notFinished')}
          actions={
            <>
              <FailureAction message={message} />
              <RetryRemaining message={message} />
              <AgentCopyDiagnostic
                diagnostic={{
                  code: message.errorCode,
                  message: message.message,
                  turnId: message.turnId,
                  toolCallId: message.toolCallId,
                  toolName: message.toolName,
                  taskId: message.job?.taskId,
                }}
              />
            </>
          }
        />
      ) : (
        <RetryRemaining message={message} />
      )}
      <RetryRecord message={message} />
      {previews.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {previews.map((preview) => (
            <Thumbnail
              key={preview.artifact.artifactId}
              preview={preview}
              onViewCanvas={onViewCanvas}
              onPreview={onPreviewResult ? (id) => openPreviewResult(id) : undefined}
            />
          ))}
        </div>
      )}
      <FetchedImages
        previews={fetched}
        onViewCanvas={onViewCanvas}
        onPreview={onPreviewResult ? (id) => openPreviewResult(id) : undefined}
      />
      {offCanvas && !onPreviewResult && (
        <button
          type="button"
          className={`self-start ${GHOST_LINK}`}
          onClick={() =>
            void useAgentStore
              .getState()
              .placeOnCanvas(message.id)
              .then(() => onViewCanvas?.())
          }
        >
          {t('tool.place')}
        </button>
      )}
    </div>
  )
}

export default function AgentToolCard(props: Parameters<typeof StandardAgentToolCard>[0]) {
  return props.message.batchId ? (
    <AgentBatchPlanCard
      key={props.message.batchId}
      batchId={props.message.batchId}
      domId={agentToolCardDomId(props.message.id)}
    />
  ) : props.message.toolName === 'generateVideo' ? (
    <AgentVideoToolCard key={props.message.id} {...props} />
  ) : (
    <StandardAgentToolCard {...props} />
  )
}
