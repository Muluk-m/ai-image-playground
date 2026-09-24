// Adapted from assistant-ui Elements (MIT), retrieved 2026-09-24.
// https://r.assistant-ui.com/elements-image-generation.json
import type { ComponentProps } from 'react'

const DOTS = Array.from({ length: 64 }, (_, index) => index)

/** The standalone element is driven by the existing agent job, without a second chat runtime. */
export function ImageGeneration({
  prompt,
  generating,
  className = '',
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  prompt: string
  generating: boolean
}) {
  return (
    <div
      data-slot="image-generation"
      data-generating={generating || undefined}
      className={`flex w-40 max-w-full flex-col gap-2 ${className}`}
      {...props}
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div
          aria-hidden="true"
          className="absolute inset-0 grid grid-cols-8 place-items-center p-5"
        >
          {DOTS.map((dot) => {
            const row = Math.floor(dot / 8)
            const col = dot % 8
            return (
              <span
                key={dot}
                className={`h-1 w-1 rounded-full bg-primary/60 transition-opacity duration-500 ${generating ? 'animate-pulse motion-reduce:animate-none' : 'opacity-0'}`}
                style={{ animationDelay: `${(row + col) * 90}ms` }}
              />
            )
          })}
        </div>
        <div
          aria-hidden="true"
          className={`absolute inset-0 transition-[opacity,filter] duration-1000 ease-out motion-reduce:transition-none ${generating ? 'opacity-0 blur-xl' : 'opacity-100 blur-0'}`}
          style={{
            background:
              'radial-gradient(120% 90% at 20% 100%, oklch(0.45 0.09 265) 0%, transparent 55%), radial-gradient(110% 80% at 85% 90%, oklch(0.62 0.1 300 / 0.8) 0%, transparent 60%), radial-gradient(130% 100% at 60% 0%, oklch(0.88 0.06 60) 0%, oklch(0.74 0.09 25 / 0.9) 45%, transparent 75%), linear-gradient(to top, oklch(0.35 0.06 275), oklch(0.82 0.07 50))',
          }}
        />
      </div>
      <p
        className={`min-w-0 truncate text-[11px] text-muted-foreground ${generating ? 'agent-shimmer relative' : ''}`}
        title={prompt}
      >
        {prompt}
      </p>
    </div>
  )
}
