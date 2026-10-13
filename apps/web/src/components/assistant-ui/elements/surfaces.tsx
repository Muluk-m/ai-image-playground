/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */
import type { ComponentProps } from 'react'
import { cn } from '../../../lib/utils'
import { Icon } from '../../ui/icon'

export const paper = 'bg-background border border-border/60 dark:bg-popover'
export const field = 'bg-foreground/[0.04] dark:bg-foreground/[0.06]'
export const mono = 'font-mono text-label-sm tracking-tight'
export const iconSwap =
  '[grid-area:1/1] transition-[opacity,transform] duration-150 motion-reduce:transition-none'
export const iconSwapIn = 'opacity-100 scale-100'
export const iconSwapOut = 'opacity-0 scale-75'
/** 过程步骤一行的按钮样子：没有底色、不缩进，与「思考中」左对齐。 */
export const stepRow =
  'group max-w-full justify-start px-0 text-left font-normal text-muted-foreground motion-reduce:transition-none'

/** 四角星：跑着时转动呼吸，跑完停下变淡。不用加载圈，免得做完了看着像卡住。 */
export function AgentSpark({
  active = false,
  className,
}: {
  active?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="agent-spark"
      data-active={active || undefined}
      className={cn(
        'inline-flex shrink-0',
        active ? 'agent-spark text-primary' : 'text-muted-foreground',
        className,
      )}
    >
      <Icon name="agentActivity" size="xs" />
    </span>
  )
}

export function ShimmerLabel({
  active = true,
  className,
  ...props
}: ComponentProps<'span'> & { active?: boolean }) {
  return (
    <span
      {...props}
      className={cn(active && 'agent-shimmer motion-reduce:animate-none', className)}
    />
  )
}
