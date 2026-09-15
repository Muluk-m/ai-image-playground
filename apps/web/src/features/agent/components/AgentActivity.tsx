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
 */
export default function AgentActivity() {
  const phase = useAgentStore((state) => agentActivityPhase(state))
  if (!phase) return null
  return (
    <output
      aria-live="polite"
      className={`flex items-center gap-1.5 text-[11px] ${INK_3}`}
      data-phase={phase}
    >
      <span className="flex items-center gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="h-1 w-1 animate-bounce rounded-full bg-current"
            style={{ animationDelay: `${dot * 150}ms` }}
          />
        ))}
      </span>
      {LABEL[phase]}
    </output>
  )
}
