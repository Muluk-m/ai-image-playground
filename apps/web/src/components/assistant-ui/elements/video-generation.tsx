import { VideoIcon } from 'lucide-react'
import type { ComponentProps } from 'react'

/** Video companion to the local assistant-ui image generation surface. */
export function VideoGeneration({ className = '', ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="video-generation"
      className={`relative grid aspect-video min-h-36 place-items-center overflow-hidden rounded-xl bg-muted ${className}`}
      {...props}
    >
      <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-primary/10 via-transparent to-primary/5 motion-reduce:animate-none" />
      <VideoIcon
        className="size-10 text-muted-foreground/60"
        strokeWidth={1.25}
        aria-hidden="true"
      />
    </div>
  )
}
