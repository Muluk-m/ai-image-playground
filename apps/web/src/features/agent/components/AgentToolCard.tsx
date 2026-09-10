import type { AgentToolImage } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { CARD, CARD_NOTE, CARD_TITLE, THUMBNAIL } from '../agentStyles'
import { agentCanvasSink } from '../lib/canvasSink'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'

const STAGE_LABEL = { submitted: '已排队', running: '生成中' } as const

function statusNote(message: AgentToolMessage): string | null {
  if (message.status === 'running') return message.stage ? STAGE_LABEL[message.stage] : '准备中'
  if (message.status === 'failed') return message.message ?? '没有完成'
  return null
}

function Thumbnail({ image }: { image: AgentToolImage }) {
  const locateImage = useAgentStore((state) => state.locateImage)
  const [source, setSource] = useState<string | null>(null)

  // 位图的单源是画布：对象被用户删掉之后就没有缩略图了，卡上只留标题。
  useEffect(() => {
    let alive = true
    void agentCanvasSink()
      ?.thumbnail(image.imageId)
      .then((data) => {
        if (alive) setSource(data)
      })
    return () => {
      alive = false
    }
  }, [image.imageId])

  if (!source) return null
  return (
    <button type="button" className={THUMBNAIL} onClick={() => locateImage(image.imageId)}>
      <img src={source} alt="" className="h-full w-full object-cover" />
    </button>
  )
}

export default function AgentToolCard({ message }: { message: AgentToolMessage }) {
  const note = statusNote(message)
  return (
    <div className={CARD}>
      <p className={CARD_TITLE}>{message.title}</p>
      {note && <p className={CARD_NOTE}>{note}</p>}
      {message.images && message.images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.images.map((image) => (
            <Thumbnail key={image.imageId} image={image} />
          ))}
        </div>
      )}
    </div>
  )
}
