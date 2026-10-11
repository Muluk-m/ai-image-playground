import { cn } from '@/lib/utils'

import { GLYPHS } from './glyphs.gen'

/** 语义名 → 图形。名字与图形来源在 scripts/build-icon-glyphs.mjs 里改，生成后不手改。 */
export const ICONS = GLYPHS
export type IconName = keyof typeof GLYPHS

/** 四档尺寸，用法见 docs/design-system/icons.md；放进 Button 时尺寸由按钮的 size 接管。 */
export const ICON_SIZE_PX = { xs: 14, sm: 16, md: 20, lg: 24 } as const
export type IconSize = keyof typeof ICON_SIZE_PX

export interface IconProps {
  name: IconName
  size?: IconSize
  className?: string
  /** 图标单独表达含义时给读屏的名字；装饰性图标不传。 */
  label?: string
  /** 选中态（已收藏、当前导航项）换成双色款；没有双色款的图形保持描线。 */
  filled?: boolean
}

export function Icon({ name, size = 'sm', className, label, filled = false }: IconProps) {
  const glyph: { line: string; solid?: string } = GLYPHS[name]
  const px = ICON_SIZE_PX[size]
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={px}
      height={px}
      fill="none"
      // 线宽按屏幕像素算：Button 等会用 CSS 改图标尺寸，跟着缩放的线宽会变粗变细。
      className={cn('shrink-0 [&_*]:[vector-effect:non-scaling-stroke]', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      // 图形是仓库里生成的静态 SVG 片段，不含外部输入。
      dangerouslySetInnerHTML={{ __html: filled && glyph.solid ? glyph.solid : glyph.line }}
    />
  )
}
