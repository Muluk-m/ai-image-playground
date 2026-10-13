import type { SVGProps } from 'react'
import { cn } from '../../../lib/utils'
import { GLYPHS } from './glyphs.gen'

/** Keep the pinned overlay's SVG-props contract while sharing the semantic glyph. */
export function SettingsIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0 [&_*]:[vector-effect:non-scaling-stroke]', className)}
      {...props}
      dangerouslySetInnerHTML={{ __html: GLYPHS.settings.line }}
    />
  )
}
