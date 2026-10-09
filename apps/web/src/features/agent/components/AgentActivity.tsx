import { useEffect, useState } from 'react'
import { ThinkingIndicator } from '../../../components/assistant-ui/elements/thinking-indicator'
import { formatElapsed, useElapsed } from '../../../hooks/useElapsed'
import { useTranslation } from '../../../i18n'
import { type AgentActivityPhase, agentActivityPhase } from '../lib/panelMessages'
import { useAgentStore } from '../store'

const LABEL_KEY = {
  sending: 'activity.sending',
  stopping: 'activity.stopping',
  thinking: 'activity.thinking',
  executing: 'activity.executing',
} as const satisfies Record<AgentActivityPhase, string>

/**
 * 一轮进行中、没有文字在流的时候，对话末尾亮一行状态：敲了回车立刻有回应，
 * 模型在想、工具在跑也看得见。文字在流时让位，别跟正文抢；一段说完停下来，状态行就回来。
 *
 * 样子照 assistant-ui 的 ThinkingIndicator：脉冲的状态点、流光扫过的标签、等宽的耗时。
 */
/** 流式文字停多久算「说完了这一段」。比 token 间隔长得多，又短到用户不会觉得卡住。 */
const TEXT_IDLE_MS = 1200

export default function AgentActivity() {
  const { t } = useTranslation('agent')
  // 正在流的那段文字有多长；不在流文字时为 null。长度一变就重新计时。
  const streamingLength = useAgentStore((state) => {
    const last = state.messages[state.messages.length - 1]
    return last?.kind === 'text' && last.role === 'assistant' && last.streaming
      ? last.text.length
      : null
  })
  const [textIdle, setTextIdle] = useState(false)
  useEffect(() => {
    setTextIdle(false)
    if (streamingLength === null) return
    const timer = setTimeout(() => setTextIdle(true), TEXT_IDLE_MS)
    return () => clearTimeout(timer)
  }, [streamingLength])
  const phase = useAgentStore((state) => agentActivityPhase(state, { textIdle }))
  const active = phase !== null
  const [startedAt, setStartedAt] = useState<number | null>(null)
  // 只在「有 → 无」「无 → 有」之间重新起表；相位之间切换时耗时连着算。
  useEffect(() => {
    setStartedAt(active ? Date.now() : null)
  }, [active])
  const elapsed = useElapsed(startedAt)

  if (!phase) return null
  return (
    <ThinkingIndicator
      role="status"
      aria-live="polite"
      data-phase={phase}
      label={t(LABEL_KEY[phase])}
      elapsed={elapsed !== null && elapsed >= 1000 ? formatElapsed(elapsed) : undefined}
    />
  )
}
