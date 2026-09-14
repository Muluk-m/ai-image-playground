import type { AgentToolArtifact } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import PlayBadge from '../../video/components/PlayBadge'
import { CARD, CARD_NOTE, CARD_TITLE, GHOST_LINK, THUMBNAIL } from '../agentStyles'
import { agentCanvasSink } from '../lib/canvasSink'
import { useAgentStore } from '../store'
import type { AgentDeliveryStatus, AgentToolMessage } from '../types'

const STAGE_LABEL = { submitted: '已排队', running: '生成中' } as const

const DELIVERY_NOTE: Record<AgentDeliveryStatus, string | null> = {
  pending: '产物已生成，正在放入画布…',
  placed: null,
  conflict: '生成期间画布有改动，本次结果没有自动写入画布。',
  unavailable: '产物尚未放入当前画布，可手动放入。',
  failed: '产物已生成，但放入画布失败，可以重试。',
}

function statusNote(message: AgentToolMessage): string | null {
  if (message.status === 'running') return message.stage ? STAGE_LABEL[message.stage] : '准备中'
  if (message.status === 'failed') return message.message ?? '没有完成'
  return message.delivery ? DELIVERY_NOTE[message.delivery] : null
}

function Thumbnail({ artifact }: { artifact: AgentToolArtifact }) {
  const [source, setSource] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void agentCanvasSink()
      ?.thumbnail(artifact.artifactId)
      .then((data) => {
        if (alive) setSource(data)
      })
      .catch((error) => {
        console.warn('[agent] 产物缩略图读取失败', error)
        if (alive) setSource(null)
      })
    return () => {
      alive = false
    }
  }, [artifact.artifactId])

  if (!source) return null
  return (
    <button
      type="button"
      className={`relative ${THUMBNAIL}`}
      onClick={() => agentCanvasSink()?.focus(artifact.artifactId)}
    >
      <img src={source} alt="" className="h-full w-full object-cover" />
      {artifact.media === 'video' && (
        <span className="absolute inset-0 grid scale-50 place-items-center">
          <PlayBadge />
        </span>
      )}
    </button>
  )
}

export default function AgentToolCard({ message }: { message: AgentToolMessage }) {
  const note = statusNote(message)
  const hasArtifacts = message.status === 'succeeded' && Boolean(message.artifacts?.length)
  const canPlace =
    hasArtifacts &&
    message.delivery !== undefined &&
    message.delivery !== 'pending' &&
    message.delivery !== 'placed'
  return (
    <div className={CARD}>
      <p className={CARD_TITLE}>{message.title}</p>
      {note && <p className={CARD_NOTE}>{note}</p>}
      {message.delivery === 'placed' && message.artifacts && (
        <div className="flex flex-wrap gap-1.5">
          {message.artifacts.map((artifact) => (
            <Thumbnail key={artifact.artifactId} artifact={artifact} />
          ))}
        </div>
      )}
      {canPlace && (
        <button
          type="button"
          className={`self-start ${GHOST_LINK}`}
          onClick={() => void useAgentStore.getState().placeOnCanvas(message.id)}
        >
          放入画布
        </button>
      )}
    </div>
  )
}
