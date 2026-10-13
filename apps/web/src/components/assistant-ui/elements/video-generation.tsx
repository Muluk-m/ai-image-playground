import type { ComponentProps } from 'react'
import { Icon } from '../../ui/icon'

/** Video companion to the local assistant-ui image generation surface. */
export function VideoGeneration({ className = '', ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="video-generation"
      className={`agent-media-generation relative grid aspect-video w-full place-items-center overflow-hidden rounded-xl bg-foreground/[0.035] ${className}`}
      {...props}
    >
      <Icon name="video" size="lg" className="text-muted-foreground" />
    </div>
  )
}
