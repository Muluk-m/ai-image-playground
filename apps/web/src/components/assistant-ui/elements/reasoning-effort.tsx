// Adapted from assistant-ui Elements (MIT): elements-reasoning-effort.json.
import type { ComponentProps } from 'react'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { field } from './surfaces'

export interface EffortLevel {
  key: string
  label: string
}

// Providers expose categorical effort, not a token budget. Never invent usage or limits.
export function ReasoningEffort({
  levels,
  selectedKey,
  onSelect,
  label,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'onSelect'> & {
  levels: readonly EffortLevel[]
  selectedKey: string
  label: string
  onSelect: (key: string) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="reasoning-effort"
      className={cn(field, 'flex gap-1 rounded-xl p-1', className)}
      {...props}
    >
      {levels.map((level) => (
        <Button
          key={level.key}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={level.key === selectedKey}
          onClick={() => onSelect(level.key)}
          className={cn(
            'h-8 flex-1 rounded-lg px-3 text-xs',
            level.key === selectedKey
              ? 'bg-background text-foreground shadow-sm hover:bg-background'
              : 'text-muted-foreground',
          )}
        >
          {level.label}
        </Button>
      ))}
    </div>
  )
}
