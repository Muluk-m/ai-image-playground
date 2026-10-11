import { cn } from '@/lib/utils'

import { ICONS, type IconName } from './registry'

export { ICONS, type IconName }

/** 四档尺寸，见 DESIGN.md「图标」：28px 控件配 xs，32–36px 配 sm，40px 配 md。 */
export const ICON_SIZE_PX = { xs: 14, sm: 16, md: 20, lg: 24 } as const
export type IconSize = keyof typeof ICON_SIZE_PX

/** 所有尺寸下视觉线宽都是 1.5px（absoluteStrokeWidth）。 */
const STROKE_WIDTH = 1.5

export interface IconProps {
  name: IconName
  size?: IconSize
  className?: string
  /** 图标单独表达含义时给读屏的名字；装饰性图标不传。 */
  label?: string
  /** 实心只给选中态（已收藏、已选中），其余一律描线。 */
  filled?: boolean
}

export function Icon({ name, size = 'sm', className, label, filled = false }: IconProps) {
  const Glyph = ICONS[name]
  return (
    <Glyph
      size={ICON_SIZE_PX[size]}
      strokeWidth={STROKE_WIDTH}
      absoluteStrokeWidth
      fill={filled ? 'currentColor' : 'none'}
      className={cn('shrink-0', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}
