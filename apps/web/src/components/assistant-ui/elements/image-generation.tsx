// Adapted from assistant-ui Elements (MIT), retrieved 2026-09-24.
// https://r.assistant-ui.com/elements-image-generation.json
import { ImageIcon } from 'lucide-react'
import type { ComponentProps } from 'react'

export function ImageGeneration({
  generating,
  className = '',
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  generating: boolean
}) {
  return (
    <div
      data-slot="image-generation"
      data-generating={generating || undefined}
      className={`studio-agent-generation-placeholder ${className}`}
      {...props}
    >
      <div className="studio-agent-generation-glow" />
      <span className="studio-agent-generation-symbol">
        <ImageIcon size={26} strokeWidth={1.25} />
      </span>
      <div className="studio-agent-generation-track">
        <span />
      </div>
    </div>
  )
}
