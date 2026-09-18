import type { AgentToolArtifact } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import PlayBadge from '../../video/components/PlayBadge'
import {
  CARD,
  CARD_NOTE,
  CARD_TITLE,
  GHOST_LINK,
  THUMBNAIL,
  THUMBNAIL_STATIC,
} from '../agentStyles'
import { type AgentArtifactPreview, artifactPreview } from '../lib/artifactPreview'
import { agentCanvasSink } from '../lib/canvasSink'
import {
  agentToolFailureAction,
  agentToolFailureActionLabel,
  agentToolFailureText,
  runAgentToolFailureAction,
} from '../lib/toolFailure'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'
import AgentJobProgress, { AgentJobCancel, useAgentToolProgress } from './AgentJobProgress'
import AgentPromptDialog from './AgentPromptDialog'

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

function useArtifactPreviews(message: AgentToolMessage): readonly AgentArtifactPreview[] {
  const [previews, setPreviews] = useState<readonly AgentArtifactPreview[]>([])
  const artifacts = previewable(message)
  // 交付状态变了就重问一遍；卡重新挂载（折叠面板、切页签）也重问，所以画布上删掉的图能被发现。
  const key = `${message.delivery}:${artifacts.map((one) => one.artifactId).join(' ')}`

  useEffect(() => {
    let alive = true
    if (!artifacts.length) {
      setPreviews([])
      return
    }
    void Promise.all(artifacts.map(artifactPreview)).then((next) => {
      if (alive) setPreviews(next)
    })
    return () => {
      alive = false
    }
    // artifacts 每次渲染都是新数组，用它的 id 与交付状态合成的 key 当依赖。
  }, [key])

  return previews
}

function Thumbnail({ preview }: { preview: AgentArtifactPreview }) {
  const { artifact, source, onCanvas } = preview
  if (!source) return null
  const badge = artifact.media === 'video' && (
    <span className="absolute inset-0 grid scale-50 place-items-center">
      <PlayBadge />
    </span>
  )
  const image = <img src={source} alt="" className="h-full w-full object-cover" />
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
      onClick={() => agentCanvasSink()?.focus([artifact.artifactId])}
    >
      {image}
      {badge}
    </button>
  )
}

/** 失败卡按错误码给的那一个出路；没有码或这类失败没有出路时不渲染。 */
function FailureAction({ message }: { message: AgentToolMessage }) {
  useTranslation('agent')
  const code = message.errorCode
  const action = agentToolFailureAction(code)
  if (!code || !action) return null
  return (
    <button
      type="button"
      className={`self-start ${GHOST_LINK}`}
      onClick={() =>
        runAgentToolFailureAction(action, {
          code,
          title: message.title,
          send: (text) => void useAgentStore.getState().send(text),
        })
      }
    >
      {agentToolFailureActionLabel(action)}
    </button>
  )
}

export default function AgentToolCard({ message }: { message: AgentToolMessage }) {
  const { t } = useTranslation(['agent', 'common'])
  const [promptOpen, setPromptOpen] = useState(false)
  const previews = useArtifactPreviews(message)
  const offCanvas = previews.some((preview) => !preview.onCanvas)
  const progress = useAgentToolProgress(message)
  const note = useStatusNote(message, offCanvas, progress !== null)
  return (
    <div className={CARD}>
      {!message.prompt && previews.some((preview) => preview.onCanvas) ? (
        <button
          type="button"
          title={t('tool.locateTitle')}
          className={`${CARD_TITLE} text-left`}
          onClick={() =>
            agentCanvasSink()?.focus(
              previews
                .filter((preview) => preview.onCanvas)
                .map((preview) => preview.artifact.artifactId),
            )
          }
        >
          {message.title}
        </button>
      ) : (
        <p className={CARD_TITLE}>{message.title}</p>
      )}
      {message.prompt && (
        <button
          type="button"
          className={`self-start ${GHOST_LINK}`}
          onClick={() => setPromptOpen(true)}
        >
          {t('tool.viewPrompt')}
        </button>
      )}
      {promptOpen && message.prompt && (
        <AgentPromptDialog prompt={message.prompt} onClose={() => setPromptOpen(false)} />
      )}
      {progress && <AgentJobProgress progress={progress} />}
      {note && <p className={CARD_NOTE}>{note}</p>}
      <AgentJobCancel message={message} />
      {message.status === 'failed' && <FailureAction message={message} />}
      {previews.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {previews.map((preview) => (
            <Thumbnail key={preview.artifact.artifactId} preview={preview} />
          ))}
        </div>
      )}
      {offCanvas && (
        <button
          type="button"
          className={`self-start ${GHOST_LINK}`}
          onClick={() => void useAgentStore.getState().placeOnCanvas(message.id)}
        >
          {t('tool.place')}
        </button>
      )}
    </div>
  )
}
