import type { AgentToolName, AgentWebSource } from '@image-playground/shared'
import { Globe, type LucideIcon, Search } from 'lucide-react'
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
 * 一行里最多挂几条来源。这一行的高度是固定的（见下面那段），挂多了只会把标题挤没；
 * 搜索本来就只让模型带回少数几条，挑头几条给用户一个「它读的是哪儿」的落点就够。
 */
const MAX_SOURCES = 3

/** 有自己图标的那几步。没登记的仍是那个小圆点——认不出的新工具不该冒充某个已知图标。 */
const STEP_ICON: Partial<Record<AgentToolName, LucideIcon>> = {
  webSearch: Search,
  webFetch: Globe,
}

/**
 * 一行过程。读技能这一步要按结果说话：**没读到的那次不能显示成读到了**——
 * 判据是结果里机器可读的 `skill.found`，不去匹配工具返回的那段文案。还没跑完时没有这一位，
 * 先照起跑标题显示。行首图标与 `/` 菜单同一张白名单映射表，一条技能两处长得一样。
 *
 * 联网那两步把读到的来源挂在同一行的右边：它们不另起结果卡（见 `activityTrail.ts`），
 * 这一行就是用户唯一能点回原文的地方。挂在行内而不是另起一行，是因为这个窗口的高度是
 * 固定的——任何会长高的东西都会把用户正读着的正文往下推。
 */
function Step({ step, active }: { step: AgentToolMessage; active: boolean }) {
  const { t } = useTranslation('agent')
  const startedAt = useAgentStore((state) => state.toolStartedAt[step.id])
  const elapsed = useElapsed(active ? (startedAt ?? null) : null)
  const skill = step.toolName === 'loadSkill' ? step.skill : undefined
  const text = skill && !skill.found ? t('tool.skillNotFound', { name: skill.label }) : step.title
  const Icon = step.toolName ? STEP_ICON[step.toolName] : undefined
  const sources = step.sources?.slice(0, MAX_SOURCES) ?? []
  return (
    <div
      {...(step.toolName === 'loadSkill' ? { 'data-tool': 'loadSkill' } : {})}
      className={`flex shrink-0 items-center gap-2 text-[11.5px] ${active ? 'text-foreground/85' : 'text-muted-foreground'}`}
      // 行高必须钉死成 ROW：滚动偏移按 ROW 算，行比它矮时每多一步就多推上去几像素，倒数第二行被推出窗口。
      style={{ height: ROW }}
    >
      {step.toolName === 'loadSkill' ? (
        <AgentSkillIcon name={skill?.icon} className="h-3 w-3 shrink-0" />
      ) : Icon ? (
        <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />
      ) : (
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'animate-pulse bg-primary motion-reduce:animate-none' : 'bg-muted-foreground/50'}`}
        />
      )}
      <span className={`min-w-0 truncate ${active ? 'agent-shimmer relative' : ''}`}>{text}</span>
      {sources.length > 0 && (
        <span
          aria-label={t('trail.sources')}
          className="ml-auto flex shrink-0 items-center gap-2 overflow-hidden"
        >
          {sources.map((source) => (
            <a
              className="max-w-[9rem] truncate text-[11px] underline decoration-dotted underline-offset-2 hover:text-foreground"
              href={source.url}
              key={source.url}
              rel="noreferrer noopener"
              target="_blank"
              title={source.title}
            >
              {sourceLabel(source)}
            </a>
          ))}
        </span>
      )}
      {active && elapsed !== null && elapsed >= 1000 && (
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  )
}

/**
 * 一条来源在这一行上的样子：主机名。标题多半是一整句，挂在这么窄的一行里只会被截成半句；
 * 主机名一眼认得出是哪家站点，完整标题留给 `title` 提示。解析不出来就退回原样。
 */
function sourceLabel(source: AgentWebSource): string {
  if (!URL.canParse(source.url)) return source.title || source.url
  return new URL(source.url).host.replace(/^www\./, '')
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
  const overflowing = steps.length > VISIBLE
  const offset = overflowing ? (steps.length - VISIBLE) * (ROW + GAP) : 0

  return (
    <output
      aria-live="polite"
      aria-label={last.title}
      // `shrink-0` 不能省：对话列表是纵向 flex，内容一溢出，带 overflow-hidden 的它会被压到 0 高，
      // 步骤照常排版却一个像素也画不出来——长对话里活动轨与来源链接就是这么「消失」的。
      className="shrink-0 overflow-hidden transition-[height,opacity] duration-[420ms] ease-out motion-reduce:transition-none"
      style={{
        height: spent ? 0 : WINDOW,
        opacity: spent ? 0 : 1,
        // 只有真的滚上去了才在顶部渐隐。不分青红皂白地挂着，头一两步正好落在渐隐区里，
        // 叠上「做完变暗」就什么都看不见——那块空白就是这么来的。渐隐只占行高的一小截：
        // 盖掉大半行，窗口看上去就只剩一行。
        ...(overflowing
          ? {
              maskImage: `linear-gradient(transparent 0, #000 ${ROW * 0.4}px)`,
              WebkitMaskImage: `linear-gradient(transparent 0, #000 ${ROW * 0.4}px)`,
            }
          : {}),
      }}
    >
      <div
        className="flex flex-col justify-end transition-transform duration-300 ease-out motion-reduce:transition-none"
        // 像聊天一样贴底排：第一步出现在窗口下沿，后来的把它往上顶。
        style={{ gap: GAP, minHeight: WINDOW, transform: `translateY(${-offset}px)` }}
      >
        {steps.map((step, index) => (
          <Step key={step.id} step={step} active={running && index === steps.length - 1} />
        ))}
      </div>
    </output>
  )
}
