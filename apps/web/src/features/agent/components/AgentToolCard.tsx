import type { AgentToolArtifact } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { CARD, CARD_NOTE, CARD_TITLE, GHOST_LINK, THUMBNAIL } from '../agentStyles'
import { agentCanvasSink } from '../lib/canvasSink'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'

const STAGE_LABEL = { submitted: '已排队', running: '生成中' } as const

const CANVAS_CONFLICT_NOTE = '生成期间画布有改动，本次结果没有自动写入画布。'

function statusNote(message: AgentToolMessage): string | null {
  if (message.status === 'running') return message.stage ? STAGE_LABEL[message.stage] : '准备中'
  if (message.status === 'failed') return message.message ?? '没有完成'
  if (message.canvasConflict) return CANVAS_CONFLICT_NOTE
  return null
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
    return () => {
      alive = false
    }
  }, [artifact.artifactId])

  if (!source) return null
  return (
    <button
      type="button"
      className={THUMBNAIL}
      onClick={() => agentCanvasSink()?.focus(artifact.artifactId)}
    >
      <img src={source} alt="" className="h-full w-full object-cover" />
    </button>
  )
}

export default function AgentToolCard({ message }: { message: AgentToolMessage }) {
  const note = statusNote(message)
  const conflicted = message.canvasConflict === true
  return (
    <div className={CARD}>
      <p className={CARD_TITLE}>{message.title}</p>
      {note && <p className={CARD_NOTE}>{note}</p>}
      {/* 冲突时画布上还没有这些对象，缩略图问了也是空的；手动放入后这里重新挂载再问。 */}
      {!conflicted && message.artifacts && message.artifacts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.artifacts.map((artifact) => (
            <Thumbnail key={artifact.artifactId} artifact={artifact} />
          ))}
        </div>
      )}
      {conflicted && (
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
