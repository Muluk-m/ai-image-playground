/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */
import type { ComponentProps } from 'react'
import { cn } from '../../../lib/utils'

export const paper = 'bg-background border border-border/60 dark:bg-popover'
export const field = 'bg-foreground/[0.04] dark:bg-foreground/[0.06]'
export const ghostButton =
  'flex items-center justify-center rounded-full text-muted-foreground outline-none transition-[background-color,color,transform] duration-150 hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.97] focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none'
export const inkButton =
  'bg-primary text-primary-foreground transition-[opacity,transform] duration-150 hover:bg-primary/90 active:scale-[0.97] motion-reduce:transition-none'
export const mono = 'font-mono text-label-sm tracking-tight'
export const iconSwap =
  '[grid-area:1/1] transition-[opacity,transform] duration-150 motion-reduce:transition-none'
export const iconSwapIn = 'opacity-100 scale-100'
export const iconSwapOut = 'opacity-0 scale-75'
/** 过程步骤一行的按钮样子：没有底色、不缩进，与「思考中」左对齐。 */
export const stepRow =
  'group flex max-w-full items-center gap-2 rounded-md py-1 text-left text-[13px] leading-5 text-muted-foreground outline-none transition-colors hover:text-foreground/80 focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none'

/** 四角星：跑着时转动呼吸，跑完停下变淡。不用加载圈，免得做完了看着像卡住。 */
export function AgentSpark({
  active = false,
  className,
}: {
  active?: boolean
  className?: string
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      data-slot="agent-spark"
      data-active={active || undefined}
      className={cn(
        'size-3.5 shrink-0',
        active ? 'agent-spark text-primary' : 'text-muted-foreground/45',
        className,
      )}
    >
      <path
        fill="currentColor"
        d="M8 1c.45 3.55 1.45 5.55 7 7-5.55 1.45-6.55 3.45-7 7-.45-3.55-1.45-5.55-7-7 5.55-1.45 6.55-3.45 7-7z"
      />
    </svg>
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
