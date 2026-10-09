import { type KeyboardEvent, type ReactNode, useCallback, useState } from 'react'
import { ComposerTriggerPopover } from './assistant-ui/elements/composer-trigger-popover'

export interface SuggestionMenuOption<T> {
  key: string
  label: string
  /** 第二行的补充说明；缺席即这一条只有一行。 */
  description?: string
  thumbnail?: ReactNode
  /** 行首的小图标；`thumbnail` 是图片缩略图，这个是线条图标，两者不同时出现。 */
  icon?: ReactNode
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

export default function SuggestionMenu<T>(props: {
  groups: SuggestionMenuGroup<T>[]
  activeIndex: number
  offsetLeft: number
  onActiveIndexChange: (index: number) => void
  onSelect: (value: T) => void
}) {
  return <ComposerTriggerPopover {...props} />
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
