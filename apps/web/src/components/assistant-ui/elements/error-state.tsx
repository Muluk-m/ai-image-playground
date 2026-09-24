// Adapted from assistant-ui Elements (MIT), retrieved 2026-09-24.
// https://r.assistant-ui.com/elements-error-state.json
import { CircleAlert } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

export function ErrorState({
  title,
  detail,
  actions,
  className = '',
  ...props
}: Omit<ComponentProps<'div'>, 'children' | 'role' | 'title'> & {
  title: string
  detail?: string
  actions?: ReactNode
}) {
  return (
    <div
      data-slot="error-state"
      role="alert"
      className={`flex w-full items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive ${className}`}
      {...props}
    >
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {detail && <p className="mt-0.5 break-words leading-relaxed">{detail}</p>}
        {actions && (
          <div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">{actions}</div>
        )}
      </div>
    </div>
  )
}
