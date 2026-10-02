import type { AgentToolArtifact } from '@image-playground/shared'
import { Download, VideoIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { VideoGeneration } from '../../../components/assistant-ui/elements/video-generation'
import { VideoPlayer } from '../../../components/assistant-ui/elements/video-player'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { downloadBlob } from '../../../lib/downloadImages'
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

function VideoResult({ artifact, title }: { artifact: AgentToolArtifact; title: string }) {
  const { t } = useTranslation('agent')
  const busy = useRef(false)
  const [downloading, setDownloading] = useState(false)
  const [failed, setFailed] = useState(false)
  const source = queueOutputUrl(artifact.taskId, artifact.outputIndex)
  const download = async () => {
    if (busy.current) return
    busy.current = true
    setDownloading(true)
    setFailed(false)
    try {
      const response = await authenticatedBffFetch(source)
      if (!response.ok) throw new Error('video_unavailable')
      const blob = await response.blob()
      if (!blob.size || !blob.type.startsWith('video/')) throw new Error('invalid_video')
      const extension =
        blob.type === 'video/webm' ? 'webm' : blob.type === 'video/quicktime' ? 'mov' : 'mp4'
      downloadBlob(blob, `muvloom-${artifact.artifactId}.${extension}`)
    } catch {
      setFailed(true)
    } finally {
      busy.current = false
      setDownloading(false)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <VideoPlayer
        src={source}
        label={title}
        errorLabel={t('video.playbackFailed')}
        retryLabel={t('video.reload')}
        aspectRatio={artifact.video?.aspectRatio.replace(':', ' / ')}
      />
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        disabled={downloading}
        onClick={() => void download()}
      >
        <Download className="mr-2 size-4" aria-hidden="true" />
        {downloading ? t('video.downloading') : t('tool.downloadResult')}
      </Button>
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          {t('video.downloadFailed')}
        </p>
      )}
    </div>
  )
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
  return (
    <section
      id={id}
      tabIndex={-1}
      data-slot="agent-video-card"
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-3 sm:p-4"
    >
      <div className="flex items-start gap-2 text-sm font-medium">
        <VideoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="min-w-0 break-words">{message.title}</p>
      </div>
      {video && <AgentVideoDetails video={video} />}
      {artifacts.map((artifact) => (
        <VideoResult key={artifact.artifactId} artifact={artifact} title={message.title} />
      ))}
      {progress && !artifacts.length && (
        <>
          <VideoGeneration aria-hidden="true" />
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
      {message.status === 'failed' && (
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
      <div className="flex flex-wrap items-center gap-2">
        {!!artifacts.length && onPreviewResult && (
          <Button variant="ghost" size="sm" onClick={() => onPreviewResult(message.id)}>
            {t('tool.previewResult')}
          </Button>
        )}
        {!!canvasIds.length && !onPreviewResult && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              onViewCanvas ? onViewCanvas(canvasIds) : agentCanvasSink()?.focus(canvasIds)
            }
          >
            {t('tool.openCanvas')}
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
        {message.prompt && (
          <Button variant="ghost" size="sm" onClick={() => setPromptOpen(true)}>
            {t('tool.viewPrompt')}
          </Button>
        )}
        <AgentJobCancel message={message} />
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
        {message.status === 'failed' && !canRetry && !liveRetry && action && message.errorCode && (
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
    </section>
  )
}
