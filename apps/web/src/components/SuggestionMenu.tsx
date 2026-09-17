import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import ComposerPopover from './ComposerPopover'

export interface SuggestionMenuOption<T> {
  key: string
  label: string
  /** 第二行的补充说明；缺席即这一条只有一行。 */
  description?: string
  thumbnail?: ReactNode
  /** 选中时交还给调用方的候选身份，弹层自己不解释它 */
  value: T
}

export interface SuggestionMenuGroup<T> {
  key: string
  heading: ReactNode
  options: SuggestionMenuOption<T>[]
  /** 空组时代替候选列出的一行说明；不可选中，键盘导航不经过它。 */
  emptyNote?: ReactNode
}

function countOptionsBefore<T>(groups: SuggestionMenuGroup<T>[], groupIndex: number) {
  return groups.slice(0, groupIndex).reduce((total, group) => total + group.options.length, 0)
}

interface SuggestionMenuProps<T> {
  groups: SuggestionMenuGroup<T>[]
  /** 跨分组连续计数，与 `useSuggestionMenu` 展平后的顺序一致 */
  activeIndex: number
  /** 相对输入框左边缘的像素偏移，让弹层跟随光标 */
  offsetLeft: number
  onActiveIndexChange: (index: number) => void
  onSelect: (value: T) => void
}

export default function SuggestionMenu<T>({
  groups,
  activeIndex,
  offsetLeft,
  onActiveIndexChange,
  onSelect,
}: SuggestionMenuProps<T>) {
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !active) return
    const viewport = list.getBoundingClientRect()
    const item = active.getBoundingClientRect()
    const top = viewport.top + list.clientTop
    const bottom = top + list.clientHeight
    // Scroll only the menu, leaving the canvas and input focus in place.
    if (item.top < top) list.scrollTop += item.top - top
    else if (item.bottom > bottom) list.scrollTop += item.bottom - bottom
  }, [activeIndex, groups])

  return (
    <ComposerPopover offsetLeft={offsetLeft}>
      <div ref={listRef} className="max-h-56 overflow-y-auto custom-scrollbar" role="listbox">
        {groups.map((group, groupIndex) => (
          <div key={group.key}>
            <div className="px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground">
              {group.heading}
            </div>
            {group.options.length === 0 && group.emptyNote && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{group.emptyNote}</div>
            )}
            {group.options.map((option, optionIndex) => {
              const index = countOptionsBefore(groups, groupIndex) + optionIndex
              return (
                <button
                  key={option.key}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onSelect(option.value)
                  }}
                  onMouseEnter={() => onActiveIndexChange(index)}
                  className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs transition-colors ${
                    index === activeIndex
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-card'
                  }`}
                >
                  {option.thumbnail && (
                    <span className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-border/70">
                      {option.thumbnail}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{option.label}</span>
                    {option.description && (
                      <span className="truncate text-[11px] font-normal text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </ComposerPopover>
  )
}

/** `handleKeyDown` 返回是否已消费按键；未消费的（含 Shift+Enter）仍要走调用方自己的输入框逻辑。 */
export function useSuggestionMenu<T>({
  groups,
  onSelect,
  onClose,
}: {
  groups: SuggestionMenuGroup<T>[]
  onSelect: (value: T) => void
  onClose: () => void
}) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const options = groups.flatMap((group) => group.options)
  const count = options.length
  const visible = !dismissed && count > 0

  const open = useCallback(() => {
    setActiveIndex(0)
    setDismissed(false)
  }, [])

  const dismiss = useCallback(() => {
    setActiveIndex(0)
    setDismissed(true)
  }, [])

  const select = useCallback(
    (value: T) => {
      dismiss()
      onSelect(value)
    },
    [dismiss, onSelect],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!visible) return false

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((index) => (index + 1) % count)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((index) => (index - 1 + count) % count)
        return true
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        select(options[activeIndex]?.value ?? options[0].value)
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        dismiss()
        onClose()
        return true
      }
      return false
    },
    [activeIndex, count, dismiss, onClose, options, select, visible],
  )

  return { visible, activeIndex, setActiveIndex, open, dismiss, select, handleKeyDown }
}
