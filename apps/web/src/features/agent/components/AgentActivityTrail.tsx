import { useEffect, useState } from 'react'
import { formatElapsed, useElapsed } from '../../../hooks/useElapsed'
import { useTranslation } from '../../../i18n'
import AgentSkillIcon from '../lib/agentSkillIcons'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'

/** 窗口只留两条：行高 + 行距 = 一格，两格就是整个高度。 */
const ROW = 20
const GAP = 4
const VISIBLE = 2
const WINDOW = ROW * VISIBLE + GAP * (VISIBLE - 1)
/** 收起动画走完再卸载，时长与下面的 transition 对齐。 */
const COLLAPSE_MS = 420

/**
 * 一行过程。读技能这一步要按结果说话：**没读到的那次不能显示成读到了**——
 * 判据是结果里机器可读的 `skill.found`，不去匹配工具返回的那段文案。还没跑完时没有这一位，
 * 先照起跑标题显示。行首图标与 `/` 菜单同一张白名单映射表，一条技能两处长得一样。
 */
function Step({ step, active }: { step: AgentToolMessage; active: boolean }) {
  const { t } = useTranslation('agent')
  const startedAt = useAgentStore((state) => state.toolStartedAt[step.id])
  const elapsed = useElapsed(active ? (startedAt ?? null) : null)
  const skill = step.toolName === 'loadSkill' ? step.skill : undefined
  const text = skill && !skill.found ? t('tool.skillNotFound', { name: skill.label }) : step.title
  return (
    <div
      {...(step.toolName === 'loadSkill' ? { 'data-tool': 'loadSkill' } : {})}
      className={`flex items-center gap-2 text-[11.5px] ${active ? 'text-foreground/80' : 'text-muted-foreground/60'}`}
      style={{ height: ROW }}
    >
      {step.toolName === 'loadSkill' ? (
        <AgentSkillIcon name={skill?.icon} className="h-3 w-3 shrink-0" />
      ) : (
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'animate-pulse bg-primary motion-reduce:animate-none' : 'bg-muted-foreground/50'}`}
        />
      )}
      <span className={`min-w-0 truncate ${active ? 'agent-shimmer relative' : ''}`}>{text}</span>
      {active && elapsed !== null && elapsed >= 1000 && (
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  )
}

/**
 * 连续几步「过程」在对话里的样子：固定两行高的窗口，做过的往上滚并变暗，顶部渐隐。
 *
 * 为什么不是一步一张卡：读画布、看图这类调用什么也没留下，一张卡就是一行标题加一圈边框，
 * 三四步下来把结论挤出屏幕。为什么高度固定：对话流里任何会长高的东西都会把正文往下推，
 * 用户正读着的那一行会跑掉。
 *
 * 模型开始给结论（后面出现了别的消息）就整块收掉——过程是过程，说完让位。
 */
export default function AgentActivityTrail({
  steps,
  spent,
}: {
  steps: readonly AgentToolMessage[]
  spent: boolean
}) {
  // 历史里早就翻篇的那些一上来就不渲染，不放收起动画；这一轮当场翻篇的才收。
  // `collapsed` 必须能回到 false：翻篇态不是单调的，同一条活动轨在下一次渲染里
  // 完全可能又变回「还在跑」（批处理里先看到后续消息、再看到工具起跑）。只往一个方向锁，
  // 那一整段过程就再也不出现了。
  const [collapsed, setCollapsed] = useState(spent)
  useEffect(() => {
    if (!spent) {
      setCollapsed(false)
      return
    }
    const timer = setTimeout(() => setCollapsed(true), COLLAPSE_MS)
    return () => clearTimeout(timer)
  }, [spent])

  if (collapsed || steps.length === 0) return null
  // 最后一步还没结束才算「正在做」；都做完了就全是历史，等着收起。
  const last = steps[steps.length - 1]!
  const running = !spent && (last.status === 'running' || last.status === 'submitted')
  const offset = Math.max(0, steps.length - VISIBLE) * (ROW + GAP)

  return (
    <output
      aria-live="polite"
      aria-label={last.title}
      className="overflow-hidden transition-[height,opacity] duration-[420ms] ease-out motion-reduce:transition-none"
      style={{
        height: spent ? 0 : WINDOW,
        opacity: spent ? 0 : 1,
        // 滚上去的那几行从顶部淡出，看得出上面还有内容又不抢注意力。
        maskImage: `linear-gradient(transparent 0, #000 ${ROW * 0.7}px)`,
        WebkitMaskImage: `linear-gradient(transparent 0, #000 ${ROW * 0.7}px)`,
      }}
    >
      <div
        className="flex flex-col transition-transform duration-300 ease-out motion-reduce:transition-none"
        style={{ gap: GAP, transform: `translateY(${-offset}px)` }}
      >
        {steps.map((step, index) => (
          <Step key={step.id} step={step} active={running && index === steps.length - 1} />
        ))}
      </div>
    </output>
  )
}
