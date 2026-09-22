import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'overlay' | 'primary' | 'success' | 'warning' | 'info'

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  overlay: 'bg-black/55 text-white',
  primary: 'bg-primary/15 text-primary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  info: 'bg-info/15 text-info',
}

/** 卡片角落与行内的小标签：一种颜色说一件事，不带交互。 */
export default function Badge({
  tone = 'neutral',
  className = '',
  children,
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium leading-none ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  )
}
