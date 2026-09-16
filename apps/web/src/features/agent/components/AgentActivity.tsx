import { useEffect, useState } from 'react'
import { formatElapsed, useElapsed } from '../../../hooks/useElapsed'
import { INK_3 } from '../agentStyles'
import { type AgentActivityPhase, agentActivityPhase, useAgentStore } from '../store'

const LABEL: Record<AgentActivityPhase, string> = {
  sending: '发送中',
  thinking: '思考中',
  executing: '执行中',
}

/**
 * 一轮进行中、还没有文字在流的时候，对话末尾亮一行状态：敲了回车立刻有回应，
 * 模型在想、工具在跑也看得见。文字一开始流就让位，别跟正文抢。
 *
 * 样子照 assistant-ui 的 ThinkingIndicator：脉冲的状态点、流光扫过的标签、等宽的耗时。
 */
export default function AgentActivity() {
  const phase = useAgentStore((state) => agentActivityPhase(state))
  const active = phase !== null
  const [startedAt, setStartedAt] = useState<number | null>(null)
  // 只在「有 → 无」「无 → 有」之间重新起表；相位之间切换时耗时连着算。
  useEffect(() => {
    setStartedAt(active ? Date.now() : null)
  }, [active])
  const elapsed = useElapsed(startedAt)

  if (!phase) return null
  return (
    <output
      aria-live="polite"
      className={`flex items-center gap-2 text-[11px] ${INK_3}`}
      data-phase={phase}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
      />
      <span key={phase} className="agent-shimmer relative inline-block leading-none">
        {LABEL[phase]}
      </span>
      {elapsed !== null && elapsed >= 1000 && (
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {formatElapsed(elapsed)}
        </span>
      )}
    </output>
  )
}
