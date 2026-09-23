import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

export interface SettingRowProps {
  /** 每一行都有图标：一眼认出这行管什么，不靠读完整句话。 */
  icon: ReactNode
  label: ReactNode
  /** 一行以内的补充信息（例如配套的快捷键）。要写成一段解释就是设计问题，回去改设计。 */
  hint?: ReactNode
  control: ReactNode
  className?: string
}

/** 一行设置：图标 + 标签（可带一行补充）+ 右侧控件。设置面板与头像菜单共用。 */
export function SettingRow({ icon, label, hint, control, className }: SettingRowProps) {
  return (
    <div className={cn('flex items-center gap-3 py-2', className)}>
      <span className="shrink-0 text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{label}</div>
        {hint ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}
