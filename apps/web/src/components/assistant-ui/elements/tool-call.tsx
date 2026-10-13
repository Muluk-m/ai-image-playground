import { Button } from '../../ui/button'
import { Icon } from '../../ui/icon'
/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */

import { type ComponentProps, useId, useState } from 'react'
import { cn } from '../../../lib/utils'
import { AgentSpark, ShimmerLabel, stepRow } from './surfaces'

/** 一行过程步骤：星号 + 标题，点开是左侧一道细线下的说明。没有说明时什么也不展开。 */
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
        variant="ghost"
        size="xs"
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={stepRow}
      >
        <AgentSpark active={running} />
        <ShimmerLabel
          active={running}
          className={cn('min-w-0 truncate', !running && 'text-muted-foreground')}
        >
          {running ? activeLabel : label}
        </ShimmerLabel>
        {!running && (
          <Icon
            name="chevronRight"
            className={cn(
              ' opacity-0 transition motion-reduce:transition-none group-hover:opacity-60 group-focus-visible:opacity-60',
              open && 'rotate-90 opacity-60',
            )}
          />
        )}
      </Button>
      <div
        id={id}
        hidden={!open}
        className="ml-1.5 mt-0.5 border-l border-border py-0.5 pl-4 text-xs text-muted-foreground has-[>div:empty]:hidden"
      >
        {children}
      </div>
    </div>
  )
}
