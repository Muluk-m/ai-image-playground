/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */

import type { ComponentProps } from 'react'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { paper } from './surfaces'

export interface SuggestionsProps extends Omit<ComponentProps<'div'>, 'children'> {
  descriptions?: Readonly<Record<string, string>>
  suggestions: readonly string[]
  selectedSuggestion: string | null
  cycle?: number
  onSuggestion: (suggestion: string) => void
  variant?: 'pills' | 'list'
}

export function Suggestions({
  suggestions,
  descriptions,
  selectedSuggestion,
  cycle = 0,
  onSuggestion,
  variant = 'pills',
  className,
  ...props
}: SuggestionsProps) {
  const list = variant === 'list'

  return (
    <div
      data-slot="suggestions"
      key={cycle}
      className={cn(
        list
          ? 'flex w-full max-w-sm flex-col gap-2'
          : 'flex max-w-md flex-wrap justify-start gap-2',
        className,
      )}
      {...props}
    >
      {suggestions.map((suggestion, index) => (
        <Button
          variant="ghost"
          data-prompt={descriptions?.[suggestion]}
          key={suggestion}
          type="button"
          aria-pressed={selectedSuggestion === suggestion}
          onClick={() => onSuggestion(suggestion)}
          className={cn(
            paper,
            'fade-in slide-in-from-bottom-2 animate-in fill-mode-both h-auto whitespace-normal flex cursor-pointer items-center text-[13px] transition-transform duration-300 hover:-translate-y-px active:scale-[0.96] motion-reduce:animate-none',
            list ? 'w-full rounded-2xl px-4 py-2.5 text-start' : 'rounded-full px-4 py-2',
            selectedSuggestion === suggestion && 'bg-primary/10 text-primary',
          )}
          style={{ animationDelay: `${index * 70}ms` }}
        >
          <span>
            <span className="block font-medium">{suggestion}</span>
            {descriptions?.[suggestion] && (
              <span className="mt-1 line-clamp-2 block text-xs font-normal leading-relaxed text-muted-foreground">
                {descriptions[suggestion]}
              </span>
            )}
          </span>
        </Button>
      ))}
    </div>
  )
}
