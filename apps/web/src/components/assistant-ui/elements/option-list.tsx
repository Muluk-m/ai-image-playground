/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */
import { CheckIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { paper } from './surfaces'

export interface OptionListOption {
  id: string
  label: string
  description?: string
  disabled?: boolean
}
export interface OptionListProps extends Omit<ComponentProps<'div'>, 'children' | 'onChange'> {
  options: readonly OptionListOption[]
  onConfirm?: (ids: string[]) => void
  choice?: readonly string[]
  pending?: boolean
}
const row =
  'flex h-auto w-full items-start justify-start gap-2.5 whitespace-normal rounded-xl px-3 py-2.5 text-start font-normal transition-colors focus-visible:ring-1'
function OptionText({ option }: { option: OptionListOption }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="break-words text-[13.5px] leading-5">{option.label}</span>
      {option.description && (
        <span className="break-words text-xs leading-4 text-muted-foreground">
          {option.description}
        </span>
      )}
    </span>
  )
}
export function OptionList({
  options,
  onConfirm,
  choice,
  pending,
  className,
  ...props
}: OptionListProps) {
  return (
    <div
      role="group"
      data-slot="option-list"
      data-state={choice !== undefined ? 'receipt' : pending ? 'pending' : 'open'}
      aria-busy={pending || undefined}
      className={cn(paper, 'flex w-full max-w-md flex-col gap-1 rounded-2xl p-2', className)}
      {...props}
    >
      {options.map((option) =>
        choice !== undefined || !onConfirm ? (
          <div
            key={option.id}
            data-selected={choice?.includes(option.id) || undefined}
            className={cn(
              row,
              choice?.includes(option.id)
                ? 'bg-primary/10 text-foreground ring-1 ring-inset ring-primary/20'
                : 'text-muted-foreground',
            )}
          >
            {choice?.includes(option.id) && (
              <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            )}
            <OptionText option={option} />
          </div>
        ) : (
          <Button
            key={option.id}
            type="button"
            variant="ghost"
            disabled={option.disabled || pending}
            onClick={() => onConfirm([option.id])}
            className={row}
          >
            <OptionText option={option} />
          </Button>
        ),
      )}
    </div>
  )
}
