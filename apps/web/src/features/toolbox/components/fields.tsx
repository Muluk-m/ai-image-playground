import type { ReactNode } from 'react'

/** 参数行里的一格：标签在上、控件在下。工具页那一行只放该工具自己的参数。 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}
