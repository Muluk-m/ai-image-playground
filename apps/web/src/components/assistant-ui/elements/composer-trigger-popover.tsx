// Adapted from assistant-ui ComposerTriggerPopover (MIT), assistant-ui@9121416.
// Store/editor own trigger matching and keyboard navigation; this is the shared presentation.
import { useLayoutEffect, useRef } from 'react'
import { cn } from '../../../lib/utils'
import ComposerPopover from '../../ComposerPopover'
import type { SuggestionMenuGroup } from '../../SuggestionMenu'
import { Button } from '../../ui/button'

export function ComposerTriggerPopover<T>({
  groups,
  activeIndex,
  offsetLeft,
  onActiveIndexChange,
  onSelect,
}: {
  groups: SuggestionMenuGroup<T>[]
  activeIndex: number
  offsetLeft: number
  onActiveIndexChange: (index: number) => void
  onSelect: (value: T) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !active) return
    const viewport = list.getBoundingClientRect()
    const item = active.getBoundingClientRect()
    const top = viewport.top + list.clientTop
    const bottom = top + list.clientHeight
    if (item.top < top) list.scrollTop += item.top - top
    else if (item.bottom > bottom) list.scrollTop += item.bottom - bottom
  }, [activeIndex, groups])
  let nextIndex = 0
  return (
    <ComposerPopover offsetLeft={offsetLeft}>
      <div
        data-slot="composer-trigger-popover"
        ref={listRef}
        className="max-h-64 overflow-y-auto custom-scrollbar"
        role="listbox"
      >
        {groups.map((group) => (
          <div key={group.key} data-slot="composer-trigger-popover-items">
            <div className="px-3 pb-1 pt-1 text-label-sm text-muted-foreground">
              {group.heading}
            </div>
            {group.options.length === 0 && group.emptyNote && (
              <div className="px-3 py-2 text-xs text-muted-foreground">{group.emptyNote}</div>
            )}
            {group.options.map((option) => {
              const index = nextIndex++
              return (
                <Button
                  key={option.key}
                  type="button"
                  variant="ghost"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-highlighted={index === activeIndex || undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(option.value)}
                  onMouseEnter={() => onActiveIndexChange(index)}
                  className={cn(
                    'h-auto w-full justify-start gap-2.5 rounded-lg px-3 py-2 text-left',
                    index === activeIndex && 'bg-accent text-accent-foreground',
                  )}
                >
                  {option.thumbnail ? (
                    <span className="size-9 shrink-0 overflow-hidden rounded-lg border border-border/70">
                      {option.thumbnail}
                    </span>
                  ) : (
                    option.icon && (
                      <span className="flex size-7 shrink-0 items-center justify-center text-primary">
                        {option.icon}
                      </span>
                    )
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{option.label}</span>
                    {option.description && (
                      <span className="line-clamp-2 whitespace-normal text-xs font-normal leading-tight text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </Button>
              )
            })}
          </div>
        ))}
      </div>
    </ComposerPopover>
  )
}
