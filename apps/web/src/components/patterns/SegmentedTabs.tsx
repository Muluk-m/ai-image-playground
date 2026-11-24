import type { ReactNode } from 'react'
import { useSlidingIndicator } from '../../hooks/useSlidingIndicator'
import { cn } from '../../lib/utils'

export interface SegmentedTab<T extends string> {
  value: T
  label: ReactNode
}

/** 页内切换：28px 胶囊页签，选中态由滑动胶囊平顺跟随，芽绿浅底与芽绿文字。 */
export default function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  fullWidth = false,
}: {
  tabs: ReadonlyArray<SegmentedTab<T>>
  value: T
  onChange: (value: T) => void
  /** 这组页签切换的是什么，给读屏用 */
  label: string
  /** 在可用宽度内均分各选项；默认按内容宽度排列。 */
  fullWidth?: boolean
}) {
  const { containerRef, indicatorStyle, visible } = useSlidingIndicator(value)

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={label}
      className={cn('relative flex items-center gap-1', fullWidth && 'w-full')}
    >
      {visible && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 z-0 rounded-full bg-primary/15"
          style={indicatorStyle}
        />
      )}
      {tabs.map((tab) => {
        const active = tab.value === value
        return (
          <button
            key={tab.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(tab.value)}
            className={cn(
              'motion-press relative z-[1] h-7 whitespace-nowrap rounded-full px-3 text-body-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              fullWidth ? 'min-w-0 flex-1' : 'shrink-0',
              active
                ? cn('font-medium text-primary', !visible && 'bg-primary/15')
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
