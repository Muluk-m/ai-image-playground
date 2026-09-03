import { type KeyboardEvent, type ReactNode, useCallback, useState } from 'react'
import ComposerPopover from './ComposerPopover'

export interface SuggestionMenuOption<T> {
  key: string
  label: string
  thumbnailUrl?: string
  /** 选中时交还给调用方的候选身份，弹层自己不解释它 */
  value: T
}

interface SuggestionMenuProps<T> {
  options: SuggestionMenuOption<T>[]
  heading: ReactNode
  activeIndex: number
  /** 相对输入框左边缘的像素偏移，让弹层跟随光标 */
  offsetLeft: number
  onActiveIndexChange: (index: number) => void
  onSelect: (value: T) => void
}

export default function SuggestionMenu<T>({
  options,
  heading,
  activeIndex,
  offsetLeft,
  onActiveIndexChange,
  onSelect,
}: SuggestionMenuProps<T>) {
  return (
    <ComposerPopover heading={heading} offsetLeft={offsetLeft}>
      <div className="max-h-56 overflow-y-auto custom-scrollbar" role="listbox">
        {options.map((option, index) => (
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
                ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
            }`}
          >
            {option.thumbnailUrl && (
              <span className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-gray-200/70 dark:border-white/[0.08]">
                <img src={option.thumbnailUrl} className="h-full w-full object-cover" alt="" />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
          </button>
        ))}
      </div>
    </ComposerPopover>
  )
}

/** `handleKeyDown` 返回是否已消费按键；未消费的（含 Shift+Enter）仍要走调用方自己的输入框逻辑。 */
export function useSuggestionMenu<T>({
  options,
  onSelect,
  onClose,
}: {
  options: SuggestionMenuOption<T>[]
  onSelect: (value: T) => void
  onClose: () => void
}) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
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
        setActiveIndex(0)
        onClose()
        return true
      }
      return false
    },
    [activeIndex, count, onClose, options, select, visible],
  )

  return { visible, activeIndex, setActiveIndex, open, dismiss, select, handleKeyDown }
}
