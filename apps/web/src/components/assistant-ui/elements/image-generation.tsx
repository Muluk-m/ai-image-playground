// Adapted from assistant-ui Elements (MIT): elements-image-generation.json.
import { ImageIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '../../../lib/utils'

export function ImageGeneration({
  generating,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & { generating: boolean }) {
  return (
    <div
      data-slot="image-generation"
      data-generating={generating || undefined}
      className={cn(
        'agent-media-generation relative aspect-[8/5] w-full overflow-hidden rounded-xl bg-foreground/[0.035]',
        className,
      )}
      {...props}
    >
      <div aria-hidden className="absolute inset-0 grid place-items-center">
        {/* design-allow opacity-text: 占位图标的淡化色，不是文字 */}
        <ImageIcon className="size-9 text-muted-foreground/60" strokeWidth={1} />
      </div>
    </div>
  )
}
