// Adapted from assistant-ui Elements (MIT), retrieved 2026-09-24.
// https://r.assistant-ui.com/elements-error-state.json

import type { ComponentProps, ReactNode } from 'react'
import { Icon } from '../../ui/icon'

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
  // 克制的深色卡：中性底、细描边，只有图标用危险色；原因一句话，下一步放在同一张卡的操作行里。
  return (
    <div
      data-slot="error-state"
      role="alert"
      className={`flex w-full items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-foreground ${className}`}
      {...props}
    >
      <Icon name="error" size="xs" className="mt-0.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="break-words leading-snug">{title}</p>
        {detail && (
          <p className="mt-0.5 break-words text-xs leading-snug text-muted-foreground">{detail}</p>
        )}
        {actions && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 empty:hidden">
            {actions}
          </div>
        )}
      </div>
    </div>
  )
}
