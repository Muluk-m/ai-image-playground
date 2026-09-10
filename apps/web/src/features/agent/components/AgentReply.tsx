import { useLayoutEffect, useRef, useState } from 'react'
import { GHOST_LINK, REPLY } from '../agentStyles'
import { useAgentStore } from '../store'

interface Props {
  messageId: string
  text: string
}

/** 默认折叠三行；只有真的超过三行才给出展开入口。 */
export default function AgentReply({ messageId, text }: Props) {
  const expanded = useAgentStore((state) => state.expanded[messageId] ?? false)
  const toggleExpanded = useAgentStore((state) => state.toggleExpanded)
  const bodyRef = useRef<HTMLParagraphElement>(null)
  const [clipped, setClipped] = useState(false)

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || expanded) return
    setClipped(body.scrollHeight > body.clientHeight + 1)
    // 文字是流进来的，量一次不够：每次增量后折叠判定都会变。
  }, [expanded, text])

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
