import type { AgentToolArtifact } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { useTranslation } from '../../../i18n'
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
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'

const NO_ARTIFACTS: readonly AgentToolArtifact[] = []

function useStatusNote(message: AgentToolMessage, offCanvas: boolean): string | null {
  const { t } = useTranslation(['agent', 'common'])
  if (message.status === 'running') {
    if (message.stage === 'submitted') return t('tool.stageSubmitted')
    if (message.stage === 'running') return t('common:state.generating')
    return t('tool.preparing')
  }
  if (message.status === 'failed') return message.message ?? t('tool.notFinished')
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

export default function AgentToolCard({ message }: { message: AgentToolMessage }) {
  const { t } = useTranslation(['agent', 'common'])
  const previews = useArtifactPreviews(message)
  const offCanvas = previews.some((preview) => !preview.onCanvas)
  const onCanvas = previews
    .filter((preview) => preview.onCanvas)
    .map((one) => one.artifact.artifactId)
  const note = useStatusNote(message, offCanvas)
  return (
    <div className={CARD}>
      {onCanvas.length > 0 ? (
        // 点标题就到画布上把这一次的产物全选中、镜头带过去；缩略图则各定位各的。
        <button
          type="button"
          title={t('tool.locateTitle')}
          className={`${CARD_TITLE} text-left transition-colors hover:text-blue-200`}
          onClick={() => agentCanvasSink()?.focus(onCanvas)}
        >
          {message.title}
        </button>
      ) : (
        <p className={CARD_TITLE}>{message.title}</p>
      )}
      {note && <p className={CARD_NOTE}>{note}</p>}
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
