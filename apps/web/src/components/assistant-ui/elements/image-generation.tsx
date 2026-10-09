// Adapted from assistant-ui Elements (MIT): elements-image-generation.json.
import type { ComponentProps } from 'react'
import { cn } from '../../../lib/utils'

const DOTS = Array.from({ length: 64 }, (_, i) => i)

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
        'relative aspect-square w-full overflow-hidden rounded-xl bg-muted/30',
        className,
      )}
      {...props}
    >
      <div aria-hidden className="absolute inset-0 grid grid-cols-8 place-items-center p-7">
        {DOTS.map((dot) => (
          <span
            key={dot}
            className={cn(
              'size-1 rounded-full bg-primary/35',
              generating && 'animate-pulse motion-reduce:animate-none',
            )}
            style={{ animationDelay: `${(Math.floor(dot / 8) + (dot % 8)) * 90}ms` }}
          />
        ))}
      </div>
    </div>
  )
}
