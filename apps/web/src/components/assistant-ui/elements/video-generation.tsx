import { VideoIcon } from 'lucide-react'
import type { ComponentProps } from 'react'

/** Video companion to the local assistant-ui image generation surface. */
export function VideoGeneration({ className = '', ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="video-generation"
      className={`agent-media-generation relative grid aspect-video w-full place-items-center overflow-hidden rounded-xl bg-foreground/[0.035] ${className}`}
      {...props}
    >
      <VideoIcon
        className="size-10 text-muted-foreground/60"
        strokeWidth={1.25}
        aria-hidden="true"
      />
    </div>
  )
}
