import { cn } from '../../lib/utils'

/**
 * 新功能提示绿点：挂在父级入口（下拉选择器、参数胶囊、导航项）右上角，
 * 提示展开列表里有未体验的新功能。不自带业务状态，显示与消隐由调用方决定。
 */
export default function FeatureDot({
  label,
  className,
}: {
  /** 仅当该圆点需要单独对读屏播报时传入；通常作为视觉提示留空（aria-hidden）。 */
  label?: string
  className?: string
}) {
  return (
    <span
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot="feature-dot"
      className={cn(
        'pointer-events-none absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card',
        className,
      )}
    />
  )
}
