import type { AgentToolArtifact } from '@image-playground/shared'
import { Download, FileText, Images, LoaderCircle, Maximize2, VideoIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { StoppedRun } from '../../../components/assistant-ui/elements/stopped-run'
import { VideoGeneration } from '../../../components/assistant-ui/elements/video-generation'
import { VideoPlayer } from '../../../components/assistant-ui/elements/video-player'
import { Button, buttonVariants } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { downloadBlob } from '../../../lib/downloadImages'
import { cn } from '../../../lib/utils'
import { captureVideoFrame } from '../../video/lib/playback'
import { cachedVideoOutputFrame, rememberVideoOutputFrame } from '../lib/artifactSource'
import { agentCanvasSink } from '../lib/canvasSink'
import { agentRerunBlock, agentRetryAvailable } from '../lib/retry'
import {
  agentToolFailureAction,
  agentToolFailureActionLabel,
  agentToolFailureText,
  runAgentToolFailureAction,
} from '../lib/toolFailure'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'
import AgentCopyDiagnostic from './AgentCopyDiagnostic'
import AgentJobProgress, { AgentJobCancel, useAgentToolProgress } from './AgentJobProgress'
import AgentPromptDialog from './AgentPromptDialog'
import AgentPromptDraft from './AgentPromptDraft'
import { AgentVideoDetails, AgentVideoEstimate } from './AgentVideoDetails'

function VideoDownload({
  artifact,
  onFailed,
}: {
  artifact: AgentToolArtifact
  onFailed: (failed: boolean) => void
}) {
  const { t } = useTranslation('agent')
  const busy = useRef(false)
  const [downloading, setDownloading] = useState(false)
  const download = async () => {
    if (busy.current) return
    busy.current = true
    setDownloading(true)
    onFailed(false)
    try {
      const response = await authenticatedBffFetch(
        queueOutputUrl(artifact.taskId, artifact.outputIndex),
      )
      if (!response.ok) throw new Error('video_unavailable')
      const blob = await response.blob()
      if (!blob.size || !blob.type.startsWith('video/')) throw new Error('invalid_video')
      const extension =
        blob.type === 'video/webm' ? 'webm' : blob.type === 'video/quicktime' ? 'mov' : 'mp4'
      downloadBlob(blob, `muvloom-${artifact.artifactId}.${extension}`)
    } catch {
      onFailed(true)
    } finally {
      busy.current = false
      setDownloading(false)
    }
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
      aria-label={downloading ? t('video.downloading') : t('tool.downloadResult')}
      title={downloading ? t('video.downloading') : t('tool.downloadResult')}
      disabled={downloading}
      onClick={() => void download()}
    >
      {downloading ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="size-4" aria-hidden="true" />
      )}
    </Button>
  )
}

function VideoResult({
  artifact,
  title,
  aspectRatio,
}: {
  artifact: AgentToolArtifact
  title: string
  aspectRatio?: string
}) {
  const { t } = useTranslation('agent')
  const [poster, setPoster] = useState<string>()
  // 复用已有首帧；没有封面时由可见播放器解码，不另开隐藏播放器抢带宽。
  useEffect(() => {
    let alive = true
    setPoster(undefined)
    void cachedVideoOutputFrame(artifact)?.then((value) => {
      if (alive && value) setPoster(value)
    })
    return () => {
      alive = false
    }
  }, [artifact.artifactId, artifact.taskId, artifact.outputIndex])
  return (
    <VideoPlayer
      src={queueOutputUrl(artifact.taskId, artifact.outputIndex)}
      poster={poster}
      label={title}
      errorLabel={t('video.playbackFailed')}
      retryLabel={t('video.reload')}
      loadingLabel={t('video.loading')}
      onFrameReady={(video) => {
        const frame = captureVideoFrame(video)
        if (frame) {
          setPoster(frame)
          rememberVideoOutputFrame(artifact, frame)
        }
      }}
      aspectRatio={aspectRatio?.replace(':', ' / ')}
      fill
    />
  )
}

/**
 * 卡片和画面一样宽：长边封顶后按比例算，竖屏约 270px，横屏不超过 28rem，方形不超过 22rem。
 * 不在画面旁边摆信息，竖屏也就不会留出整块空白。
 */
export function videoCardWidth(aspectRatio: string | undefined) {
  const [width, height] = (aspectRatio ?? '16:9').split(':').map(Number)
  const valid = width > 0 && height > 0
  const ratio = valid ? `${width} / ${height}` : '16 / 9'
  const cap = valid && width === height ? '22rem' : '28rem'
  return `min(100%, ${cap}, calc(min(30rem, 56vh) * ${ratio}))`
}

export default function AgentVideoToolCard({
  message,
  onViewCanvas,
  onPreviewResult,
}: {
  message: AgentToolMessage
  onViewCanvas?: (objectIds?: readonly string[]) => void
  onPreviewResult?: (messageId: string, objectId?: string) => void
}) {
  const { t } = useTranslation('agent')
  const progress = useAgentToolProgress(message)
  const [promptOpen, setPromptOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const retryLock = useRef(false)
  const [retryFailed, setRetryFailed] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [placing, setPlacing] = useState(false)
  const placementLock = useRef(false)
  const [placementFailed, setPlacementFailed] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const messages = useAgentStore((state) => state.messages)
  const artifacts = message.artifacts?.filter((one) => one.media === 'video') ?? []
  const canvas = agentCanvasSink()
  const canvasContext = !!canvas && !onPreviewResult
  const canvasIds = artifacts
    .filter((artifact) => canvas?.has(artifact.artifactId))
    .map((artifact) => artifact.artifactId)
  const offCanvas = canvasContext && canvasIds.length < artifacts.length
  const delivering = placing || message.delivery === 'pending'
  const deliveryFailed = placementFailed || message.delivery === 'failed'
  const video = message.video ?? message.job?.video ?? artifacts[0]?.video
  const liveRetry = messages?.some(
    (one) =>
      one.kind === 'tool' &&
      one.retryOf?.messageId === message.id &&
      ['queued', 'submitted', 'running', 'succeeded'].includes(one.status),
  )
  const canRetry =
    message.status === 'failed' && agentRetryAvailable(message.errorCode, message) && !liveRetry
  const rerunBlock = agentRerunBlock(message)
  const action = agentToolFailureAction(message.errorCode, rerunBlock)
  const failureText =
    message.errorCode === 'cancelled'
      ? message.job
        ? t(
            isClientCapabilityEnabled('billing:credits')
              ? 'job.cancelledRefunded'
              : 'job.cancelled',
          )
        : t('retry.withdrawn')
      : (agentToolFailureText(message.errorCode) ?? message.message ?? t('tool.notFinished'))
  const id = `agent-tool-card-${message.id}`
  if (message.status === 'awaiting_confirmation')
    return (
      <div id={id} tabIndex={-1}>
        <AgentPromptDraft message={message} />
      </div>
    )
  const retry = async () => {
    if (retryLock.current) return
    retryLock.current = true
    setRetrying(true)
    setRetryFailed(false)
    try {
      if (!(await useAgentStore.getState().retry(message.id))) setRetryFailed(true)
    } catch {
      setRetryFailed(true)
    } finally {
      retryLock.current = false
      setRetrying(false)
    }
  }
  const hasMedia = !!artifacts.length
  const waiting = !hasMedia && !!progress
  const aspectRatio = artifacts[0]?.video?.aspectRatio ?? video?.aspectRatio
  const iconButton = 'size-8 text-muted-foreground hover:text-foreground'
  return (
    <section
      id={id}
      tabIndex={-1}
      data-slot="agent-video-card"
      className={cn(
        'flex min-w-0 max-w-full flex-col rounded-2xl border border-border bg-card',
        hasMedia ? 'overflow-hidden' : 'gap-3 p-3 sm:p-4',
      )}
      // 生成中的占位和成片共用同一宽度上限，否则占位会按整列宽度撑成一大块空白。
      style={hasMedia || waiting ? { width: videoCardWidth(aspectRatio) } : undefined}
    >
      {hasMedia && (
        <div className="flex flex-col gap-px bg-border">
          {artifacts.map((artifact) => (
            <VideoResult
              key={artifact.artifactId}
              artifact={artifact}
              title={message.title}
              aspectRatio={artifact.video?.aspectRatio ?? video?.aspectRatio}
            />
          ))}
        </div>
      )}
      <div className={cn('flex min-w-0 flex-col', hasMedia ? 'gap-2 px-3 pb-2 pt-2.5' : 'gap-3')}>
        {hasMedia ? (
          <p
            className="line-clamp-2 break-words text-[13px] font-semibold leading-normal"
            title={message.title}
          >
            {message.title}
          </p>
        ) : (
          <div className="flex items-start gap-2 text-sm font-medium">
            <VideoIcon
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="min-w-0 break-words">{message.title}</p>
          </div>
        )}
        {video && <AgentVideoDetails video={video} />}
        {progress && !artifacts.length && (
          <>
            <VideoGeneration
              aria-hidden="true"
              style={aspectRatio ? { aspectRatio: aspectRatio.replace(':', ' / ') } : undefined}
            />
            <AgentJobProgress progress={progress} />
          </>
        )}
        {message.status === 'queued' && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('retry.queued')}
          </p>
        )}
        {message.status === 'succeeded' && !artifacts.length && (
          <p className="text-sm text-muted-foreground">{t('video.notSubmitted')}</p>
        )}
        {message.status === 'failed' && message.errorCode === 'cancelled' && (
          <StoppedRun reason={failureText} />
        )}
        {message.status === 'failed' && message.errorCode !== 'cancelled' && (
          <p role="alert" className="text-sm text-destructive">
            {failureText}
          </p>
        )}
        {canvasContext && !!artifacts.length && (delivering || deliveryFailed || offCanvas) && (
          <p role={deliveryFailed ? 'alert' : 'status'} className="text-xs text-muted-foreground">
            {t(
              delivering
                ? 'tool.delivering'
                : deliveryFailed
                  ? 'tool.deliveryFailed'
                  : 'tool.offCanvas',
            )}
          </p>
        )}
        {canRetry && video && <AgentVideoEstimate video={video} />}
        <div className={cn('flex flex-wrap items-center gap-2', hasMedia && '-mx-1 gap-1')}>
          {artifacts.map((artifact) => (
            <VideoDownload
              key={artifact.artifactId}
              artifact={artifact}
              onFailed={setDownloadFailed}
            />
          ))}
          {hasMedia && <span className="flex-1" />}
          {hasMedia && onPreviewResult && (
            <Button
              variant="ghost"
              size="icon"
              className={iconButton}
              title={t('tool.previewResult')}
              aria-label={t('tool.previewResult')}
              onClick={() => onPreviewResult(message.id)}
            >
              <Maximize2 className="size-4" aria-hidden="true" />
            </Button>
          )}
          {!!canvasIds.length && !onPreviewResult && (
            <Button
              variant="ghost"
              size="icon"
              className={iconButton}
              title={t('tool.openCanvas')}
              aria-label={t('tool.openCanvas')}
              onClick={() =>
                onViewCanvas ? onViewCanvas(canvasIds) : agentCanvasSink()?.focus(canvasIds)
              }
            >
              <Images className="size-4" aria-hidden="true" />
            </Button>
          )}
          {offCanvas && (
            <Button
              variant="outline"
              size="sm"
              disabled={delivering}
              onClick={() => {
                if (placementLock.current) return
                placementLock.current = true
                setPlacing(true)
                setPlacementFailed(false)
                void useAgentStore
                  .getState()
                  .placeOnCanvas(message.id)
                  .then(() => {
                    const delivered = useAgentStore
                      .getState()
                      .messages.find((one) => one.id === message.id)
                    if (delivered?.kind === 'tool' && delivered.delivery === 'placed')
                      onViewCanvas?.()
                  })
                  .catch(() => setPlacementFailed(true))
                  .finally(() => {
                    placementLock.current = false
                    setPlacing(false)
                  })
              }}
            >
              {t('tool.place')}
            </Button>
          )}
          {message.retryOf && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const original = document.getElementById(
                  `agent-tool-card-${message.retryOf!.messageId}`,
                )
                original?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
                original?.focus({ preventScroll: true })
              }}
            >
              {t('retry.viewOriginal')}
            </Button>
          )}
          {message.prompt &&
            (hasMedia ? (
              <Button
                variant="ghost"
                size="icon"
                className={iconButton}
                title={t('tool.viewPrompt')}
                aria-label={t('tool.viewPrompt')}
                onClick={() => setPromptOpen(true)}
              >
                <FileText className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setPromptOpen(true)}>
                {t('tool.viewPrompt')}
              </Button>
            ))}
          <AgentJobCancel
            message={message}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
          />
          {message.status === 'queued' && message.retryOf && (
            <Button
              variant="ghost"
              size="sm"
              disabled={withdrawing}
              onClick={() => {
                setWithdrawing(true)
                setRetryFailed(false)
                void useAgentStore
                  .getState()
                  .cancelJob(message.id)
                  .catch(() => setRetryFailed(true))
                  .finally(() => setWithdrawing(false))
              }}
            >
              {withdrawing ? t('retry.withdrawing') : t('retry.withdraw')}
            </Button>
          )}
          {canRetry && (
            <Button variant="outline" size="sm" disabled={retrying} onClick={() => void retry()}>
              {retrying ? t('video.retrying') : t('video.retry')}
            </Button>
          )}
          {message.status === 'failed' &&
            !canRetry &&
            !liveRetry &&
            action &&
            message.errorCode && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  runAgentToolFailureAction(action, {
                    code: message.errorCode!,
                    block: rerunBlock,
                    title: message.title,
                    send: (text) => void useAgentStore.getState().send(text),
                  })
                }
              >
                {agentToolFailureActionLabel(action, message.errorCode)}
              </Button>
            )}
          {message.status === 'failed' && (
            <AgentCopyDiagnostic
              diagnostic={{
                code: message.errorCode,
                message: message.message,
                taskId: message.job?.taskId,
                toolName: message.toolName,
                toolCallId: message.toolCallId,
                turnId: message.turnId,
              }}
            />
          )}
        </div>
        {downloadFailed && (
          <p role="alert" className="text-xs text-destructive">
            {t('video.downloadFailed')}
          </p>
        )}
        {retryFailed && (
          <p role="alert" className="text-xs text-destructive">
            {t('video.retryFailed')}
          </p>
        )}
        {message.wakeSkipped && (
          <p className="text-xs text-muted-foreground">
            {t(`job.wakeSkipped.${message.wakeSkipped}`)}
          </p>
        )}
        {promptOpen && message.prompt && (
          <AgentPromptDialog prompt={message.prompt} onClose={() => setPromptOpen(false)} />
        )}
      </div>
    </section>
  )
}
