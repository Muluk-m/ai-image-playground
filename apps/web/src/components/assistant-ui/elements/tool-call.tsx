/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */
import { ChevronRightIcon, Loader } from 'lucide-react'
import { type ComponentProps, useId, useState } from 'react'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { field, ShimmerLabel } from './surfaces'

/** The upstream collapsible composition uses the existing shadcn Button disclosure here. */
export function ToolCall({
  label,
  activeLabel,
  running,
  children,
  className,
  ...props
}: ComponentProps<'div'> & {
  label: string
  activeLabel: string
  running: boolean
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div data-slot="tool-call" className={cn('w-full max-w-xl', className)} {...props}>
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="group h-auto max-w-full justify-start gap-2 rounded-lg px-2 py-1.5 text-left text-body-sm font-normal text-muted-foreground"
      >
        {/* 跑着时这颗星慢慢转、文字流光；跑完星停下变淡，箭头只在悬停或展开时出现。 */}
        <Loader
          aria-hidden
          className={cn(
            'size-3.5 shrink-0',
            running
              ? 'animate-[spin_3s_linear_infinite] text-primary motion-reduce:animate-none'
              : 'text-primary/60',
          )}
        />
        <ShimmerLabel active={running} className="min-w-0 truncate">
          {running ? activeLabel : label}
        </ShimmerLabel>
        {!running && (
          <ChevronRightIcon
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 opacity-0 transition motion-reduce:transition-none group-hover:opacity-100 group-focus-visible:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        )}
      </Button>
      <div id={id} hidden={!open} className={cn(field, 'mt-2 rounded-2xl p-3.5 text-xs')}>
        {children}
      </div>
    </div>
  )
}
