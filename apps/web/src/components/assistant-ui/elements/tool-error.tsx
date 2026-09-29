/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */
import { AlertCircleIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../../lib/utils'
import { field, paper } from './surfaces'

export function ToolError({
  name,
  message,
  actions,
  children,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  name: string
  message: string
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div
      role="alert"
      data-slot="tool-error"
      className={cn(paper, 'flex w-full max-w-xl flex-col gap-3 rounded-2xl p-3.5', className)}
      {...props}
    >
      <div className="flex items-center gap-2.5">
        <AlertCircleIcon aria-hidden className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 break-words text-[13px] font-medium">{name}</span>
      </div>
      <div
        className={cn(field, 'rounded-xl px-3 py-2 text-xs leading-relaxed text-muted-foreground')}
      >
        {message}
      </div>
      {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
      {children}
    </div>
  )
}
