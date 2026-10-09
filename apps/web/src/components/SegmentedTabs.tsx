import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

export interface SegmentedTab<T extends string> {
  value: T
  label: ReactNode
}

/** 页内切换：28px 胶囊页签，选中态 accent 底。多个页面共用同一种长相。 */
export default function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: ReadonlyArray<SegmentedTab<T>>
  value: T
  onChange: (value: T) => void
  /** 这组页签切换的是什么，给读屏用 */
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      {tabs.map((tab) => {
        const active = tab.value === value
        return (
          <button
            key={tab.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(tab.value)}
            className={cn(
              'h-7 shrink-0 whitespace-nowrap rounded-full px-3 text-body-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
