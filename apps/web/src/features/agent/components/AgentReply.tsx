import { useLayoutEffect, useRef, useState } from 'react'
import { GHOST_LINK, REPLY } from '../agentStyles'
import { useAgentStore } from '../store'

interface Props {
  messageId: string
  text: string
  streaming: boolean
}

export default function AgentReply({ messageId, text, streaming }: Props) {
  const expanded = useAgentStore((state) => state.expanded[messageId] ?? false)
  const toggleExpanded = useAgentStore((state) => state.toggleExpanded)
  const bodyRef = useRef<HTMLParagraphElement>(null)
  const [clipped, setClipped] = useState(false)

  useLayoutEffect(() => {
    const body = bodyRef.current
    // 量高度会强制重排，逐字流期间每个 token 量一次太贵；文字长完再量。
    if (!body || expanded || streaming) return
    setClipped(body.scrollHeight > body.clientHeight + 1)
  }, [expanded, streaming, text])

  return (
    <div className="flex flex-col items-start gap-0.5">
      <p ref={bodyRef} className={`${REPLY} ${expanded ? '' : 'line-clamp-3'}`}>
        {text}
      </p>
      {(clipped || expanded) && (
        <button type="button" className={GHOST_LINK} onClick={() => toggleExpanded(messageId)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}
