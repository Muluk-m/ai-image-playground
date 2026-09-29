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
 * 一轮进行中、还没有文字在流的时候，对话末尾亮一行状态：敲了回车立刻有回应，
 * 模型在想、工具在跑也看得见。文字一开始流就让位，别跟正文抢。
 *
 * 样子照 assistant-ui 的 ThinkingIndicator：脉冲的状态点、流光扫过的标签、等宽的耗时。
 */
export default function AgentActivity() {
  const { t } = useTranslation('agent')
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
    <ThinkingIndicator
      role="status"
      aria-live="polite"
      data-phase={phase}
      label={t(LABEL_KEY[phase])}
      elapsed={elapsed !== null && elapsed >= 1000 ? formatElapsed(elapsed) : undefined}
    />
  )
}
