/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */

import type { ComponentProps } from 'react'
import { cn } from '../../../lib/utils'
import { mono, ShimmerLabel } from './surfaces'

export function ThinkingIndicator({
  label,
  elapsed,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'children' | 'label' | 'elapsed'> & {
  label: string
  elapsed?: string
}) {
  return (
    <div
      data-slot="thinking-indicator"
      className={cn('text-foreground/55 flex items-center gap-2.5 text-sm', className)}
      {...props}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
      />
      <ShimmerLabel
        key={label}
        className="fade-in slide-in-from-bottom-1 animate-in relative inline-block leading-none duration-300"
      >
        {label}
      </ShimmerLabel>
      {elapsed !== undefined && (
        <span className={cn(mono, 'text-foreground/30 tabular-nums')}>{elapsed}</span>
      )}
    </div>
  )
}
