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
  'flex items-center justify-center rounded-full text-muted-foreground outline-none transition-[background-color,color,transform] duration-150 hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none'
export const inkButton =
  'bg-primary text-primary-foreground transition-[opacity,transform] duration-150 hover:bg-primary/90 active:scale-[0.96] motion-reduce:transition-none'
export const mono = 'font-mono text-[11px] tracking-tight'
export const iconSwap =
  '[grid-area:1/1] transition-[opacity,transform] duration-150 motion-reduce:transition-none'
export const iconSwapIn = 'opacity-100 scale-100'
export const iconSwapOut = 'opacity-0 scale-75'
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
