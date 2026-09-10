import type { AgentToolImage } from '@image-playground/shared'
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
  return null
}

function Thumbnail({ image, conflicted }: { image: AgentToolImage; conflicted: boolean }) {
  const [source, setSource] = useState<string | null>(null)

  useEffect(() => {
    // 冲突时画布上还没有这个对象，问也是白问；手动放入后这里再跑一遍。
    if (conflicted) return
    let alive = true
    void agentCanvasSink()
      ?.thumbnail(image.imageId)
      .then((data) => {
        if (alive) setSource(data)
      })
    return () => {
      alive = false
    }
  }, [image.imageId, conflicted])

  if (!source) return null
  return (
    <button
      type="button"
      className={THUMBNAIL}
      onClick={() => agentCanvasSink()?.focus(image.imageId)}
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
      {message.images && message.images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.images.map((image) => (
            <Thumbnail key={image.imageId} image={image} conflicted={conflicted} />
          ))}
        </div>
      )}
      {conflicted && (
        <>
          <p className={CARD_NOTE}>{CANVAS_CONFLICT_NOTE}</p>
          <button
            type="button"
            className={`self-start ${GHOST_LINK}`}
            onClick={() => void useAgentStore.getState().placeOnCanvas(message.id)}
          >
            放入画布
          </button>
        </>
      )}
    </div>
  )
}
