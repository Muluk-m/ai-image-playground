import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { useTranslation } from '../i18n'
import { DEFAULT_DROPDOWN_MAX_HEIGHT, getDropdownMaxHeight } from '../lib/dropdown'
import { ChevronDownIcon, DragHandleIcon, EditIcon, PlusIcon, TrashIcon } from './icons'

interface Option {
  label: string
  value: string | number
  icon?: ReactNode
  description?: string
  title?: string
  variant?: 'action' | 'danger'
  draggable?: boolean
  actions?: Array<{
    label: string
    variant?: 'danger'
    onClick: () => void
  }>
}

interface SelectProps {
  value: string | number
  onChange: (value: any) => void
  onReorder?: (
    sourceValue: string | number,
    targetValue: string | number,
    position: 'before' | 'after' | null,
  ) => void
  options: readonly Option[]
  disabled?: boolean
  className?: string
  /** 自定义 trigger 容器 class，默认 `relative w-full`；chip 模式用 `absolute inset-0` 让 chip 整块可点。 */
  wrapperClassName?: string
  /** 隐藏选中值文本（chip 模式由外层 chip 自己渲染 value，只保留 chevron 触发）。 */
  hideSelectedLabel?: boolean
  /** 字段名（「质量」「格式」），读屏用；同一行里多个 auto 靠它区分 */
  label?: string
}

export default function Select({
  value,
  onChange,
  onReorder,
  options,
  disabled,
  className,
  wrapperClassName,
  hideSelectedLabel,
  label,
}: SelectProps) {
  const { t } = useTranslation(['composer', 'common'])
  const [isOpen, setIsOpen] = useState(false)
  const [menuMaxHeight, setMenuMaxHeight] = useState(DEFAULT_DROPDOWN_MAX_HEIGHT)
  const [placement, setPlacement] = useState<'bottom' | 'top'>('bottom')
  const [draggedValue, setDraggedValue] = useState<string | number | null>(null)
  const [dragOverValue, setDragOverValue] = useState<string | number | null>(null)
  const [dragDropPosition, setDragDropPosition] = useState<'before' | 'after' | null>(null)
  const [touchDragPreview, setTouchDragPreview] = useState<{
    label: string
    x: number
    y: number
    width: number
    height: number
    offsetX: number
    offsetY: number
  } | null>(null)
  const touchDragRef = useRef<{
    value: string | number
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  const dragScrollIntervalRef = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find((o) => o.value === value)
  const listId = useId()
  const [activeIndex, setActiveIndex] = useState(-1)
  const optionId = (index: number) => `${listId}-opt-${index}`

  const openMenu = () => {
    setActiveIndex(selectedOption ? options.indexOf(selectedOption) : 0)
    setIsOpen(true)
  }
  // 打开时成为 Esc 栈顶：Esc 只关下拉，不关外层弹窗。
  useCloseOnEscape(isOpen, () => closeMenu())

  // 焦点在列表里（编辑 / 删除按钮）时关掉下拉，按钮随之卸载；把焦点还给触发器，
  // 动作若打开了新弹窗，新弹窗会在下一帧接走焦点，这里不抢。
  const closeMenu = () => {
    const hadFocusInside = containerRef.current?.contains(document.activeElement) ?? false
    setIsOpen(false)
    if (!hadFocusInside) return
    requestAnimationFrame(() => {
      if (document.activeElement === document.body || !document.activeElement?.isConnected) {
        triggerRef.current?.focus()
      }
    })
  }

  // 键盘与 WAI-ARIA combobox 约定一致：方向键移动高亮，Enter 选中。
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((index) => (index + step + options.length) % options.length)
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      setActiveIndex(e.key === 'Home' ? 0 : options.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const option = options[activeIndex]
      if (option) onChange(option.value)
      setIsOpen(false)
    } else if (e.key === 'Tab' && !options.some((option) => option.actions?.length)) {
      // 带编辑 / 删除按钮的列表不在 Tab 时收起，让焦点能走进这些按钮。
      setIsOpen(false)
    }
  }

  useEffect(() => {
    if (!isOpen || activeIndex < 0) return
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' })
  }, [isOpen, activeIndex])

  useEffect(() => {
    return () => {
      if (dragScrollIntervalRef.current) clearInterval(dragScrollIntervalRef.current)
    }
  }, [])

  useEffect(() => {
    if (!touchDragPreview) return

    const preventTouchScroll = (event: TouchEvent) => {
      event.preventDefault()
    }
    const listenerOptions = { passive: false, capture: true } as AddEventListenerOptions
    const previousOverflow = document.body.style.overflow
    const previousOverscroll = document.body.style.overscrollBehavior

    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'none'
    window.addEventListener('touchmove', preventTouchScroll, listenerOptions)

    return () => {
      document.body.style.overflow = previousOverflow
      document.body.style.overscrollBehavior = previousOverscroll
      window.removeEventListener('touchmove', preventTouchScroll, listenerOptions)
    }
  }, [touchDragPreview])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!isOpen) return

    const updateMenuMaxHeight = () => {
      if (!triggerRef.current) return
      const trigger = triggerRef.current
      const rect = trigger.getBoundingClientRect()

      let availableBelow = window.innerHeight - rect.bottom - 8
      let availableAbove = rect.top - 8

      let parent = trigger.parentElement
      while (parent && parent !== document.body) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowY}`)) {
          const parentRect = parent.getBoundingClientRect()
          availableBelow = Math.min(availableBelow, parentRect.bottom - rect.bottom - 8)
          availableAbove = Math.min(availableAbove, rect.top - parentRect.top - 8)
        }
        parent = parent.parentElement
      }

      let newPlacement: 'bottom' | 'top' = 'bottom'
      let maxHeight = DEFAULT_DROPDOWN_MAX_HEIGHT

      if (availableBelow < 120 && availableAbove > availableBelow) {
        newPlacement = 'top'
        maxHeight = Math.min(DEFAULT_DROPDOWN_MAX_HEIGHT, Math.floor(availableAbove))
      } else {
        newPlacement = 'bottom'
        maxHeight = Math.min(DEFAULT_DROPDOWN_MAX_HEIGHT, Math.floor(availableBelow))
      }

      setPlacement(newPlacement)
      setMenuMaxHeight(Math.max(0, maxHeight))
    }

    updateMenuMaxHeight()
    window.addEventListener('resize', updateMenuMaxHeight)
    window.addEventListener('scroll', updateMenuMaxHeight, true)
    return () => {
      window.removeEventListener('resize', updateMenuMaxHeight)
      window.removeEventListener('scroll', updateMenuMaxHeight, true)
    }
  }, [isOpen])

  const handleToggle = (e: React.MouseEvent) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()
    // 动画和位置的计算在 useEffect 中进行，这里可以先假设一个默认值或保留当前状态
    if (isOpen) setIsOpen(false)
    else openMenu()
  }

  const clearTouchDrag = () => {
    touchDragRef.current = null
    setTouchDragPreview(null)
    setDraggedValue(null)
    setDragOverValue(null)
    setDragDropPosition(null)
    if (dragScrollIntervalRef.current) {
      clearInterval(dragScrollIntervalRef.current)
      dragScrollIntervalRef.current = null
    }
  }

  return (
    <div
      ref={containerRef}
      className={wrapperClassName ?? 'relative w-full'}
      onBlur={(e) => {
        // 焦点移到 Select 之外的控件才收起，Tab 进操作按钮时保持打开。relatedTarget 为空
        // 是点在不可聚焦的选项上，交给 click 处理；点页面空白由外部 mousedown 收起。
        // 点选项时焦点会落到外层可聚焦容器（如 Popover），它包着 Select，不算离开。
        const next = e.relatedTarget as Node | null
        const container = containerRef.current
        if (isOpen && next && container && !container.contains(next) && !next.contains(container)) {
          setIsOpen(false)
        }
      }}
    >
      <div
        ref={triggerRef}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-activedescendant={isOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-disabled={disabled || undefined}
        aria-label={
          hideSelectedLabel
            ? [label, selectedOption?.label ?? String(value)].filter(Boolean).join(' ')
            : label
        }
        title={selectedOption?.title ?? selectedOption?.label}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        className={`flex items-center justify-between gap-1 w-full cursor-pointer select-none rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring ${className ?? ''} ${
          disabled ? '!opacity-50 !cursor-not-allowed !bg-muted/50' : ''
        }`}
      >
        {!hideSelectedLabel && <span className="truncate">{selectedOption?.label ?? value}</span>}
        <ChevronDownIcon
          className={`w-3.5 h-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </div>

      {isOpen && (
        <div
          id={listId}
          role="listbox"
          className={`absolute z-50 w-full overflow-hidden overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground py-1 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] dark:ring-white/10 custom-scrollbar ${
            placement === 'top'
              ? 'bottom-full mb-1.5 animate-dropdown-up'
              : 'top-full mt-1.5 animate-dropdown-down'
          }`}
          style={{ maxHeight: menuMaxHeight }}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === value}
              onMouseEnter={() => setActiveIndex(index)}
              data-option-value={String(option.value)}
              title={option.title ?? option.label}
              draggable={option.draggable}
              onDragStart={(e) => {
                if (!option.draggable) return
                setDraggedValue(option.value)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', String(option.value))
              }}
              onDragOver={(e) => {
                if (!option.draggable || !draggedValue) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'

                const targetElement = e.currentTarget as HTMLElement
                const rect = targetElement.getBoundingClientRect()
                const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'

                if (dragOverValue !== option.value || dragDropPosition !== position) {
                  setDragOverValue(option.value)
                  setDragDropPosition(position)
                }

                // Auto-scroll
                const scrollContainer = targetElement.parentElement
                if (scrollContainer) {
                  const containerRect = scrollContainer.getBoundingClientRect()
                  const scrollThreshold = 30

                  if (e.clientY < containerRect.top + scrollThreshold) {
                    scrollContainer.scrollTop -= 10
                  } else if (e.clientY > containerRect.bottom - scrollThreshold) {
                    scrollContainer.scrollTop += 10
                  }
                }
              }}
              onDragEnd={() => {
                setDraggedValue(null)
                setDragOverValue(null)
                setDragDropPosition(null)
              }}
              onDrop={(e) => {
                if (!option.draggable || !onReorder) return
                e.preventDefault()
                setDraggedValue(null)
                setDragOverValue(null)
                setDragDropPosition(null)

                const sourceValue = e.dataTransfer.getData('text/plain')
                const sourceOption = options.find((o) => String(o.value) === sourceValue)
                if (sourceOption && sourceOption.value !== option.value) {
                  onReorder(sourceOption.value, option.value, dragDropPosition)
                }
              }}
              onTouchStart={(e) => {
                if (!option.draggable) return
                const target = e.target as HTMLElement
                if (!target.closest('[data-drag-handle]')) return

                const touch = e.touches[0]
                const rect = e.currentTarget.getBoundingClientRect()
                // Do not prevent default here, as it blocks scrolling
                // e.preventDefault()
                e.stopPropagation()
                touchDragRef.current = {
                  value: option.value,
                  startX: touch.clientX,
                  startY: touch.clientY,
                  moved: false,
                }
                setDraggedValue(option.value)
                setTouchDragPreview({
                  label: option.label,
                  x: touch.clientX,
                  y: touch.clientY,
                  width: rect.width,
                  height: rect.height,
                  offsetX: touch.clientX - rect.left,
                  offsetY: touch.clientY - rect.top,
                })
              }}
              onTouchMove={(e) => {
                const drag = touchDragRef.current
                if (!drag || !option.draggable) return
                const touch = e.touches[0]

                if (!drag.moved) {
                  if (
                    Math.abs(touch.clientX - drag.startX) > 5 ||
                    Math.abs(touch.clientY - drag.startY) > 5
                  ) {
                    drag.moved = true
                  } else {
                    return
                  }
                }

                e.preventDefault() // prevent scrolling
                setTouchDragPreview((current) =>
                  current ? { ...current, x: touch.clientX, y: touch.clientY } : current,
                )

                // Hide preview visually so elementFromPoint works correctly
                const previewEl = document.getElementById('touch-drag-preview')
                if (previewEl) previewEl.style.pointerEvents = 'none'

                const el = document.elementFromPoint(touch.clientX, touch.clientY)
                const targetDiv = el?.closest('[data-option-value]') as HTMLElement
                if (targetDiv) {
                  const targetValueStr = targetDiv.getAttribute('data-option-value')
                  if (targetValueStr) {
                    const targetOption = options.find((o) => String(o.value) === targetValueStr)
                    if (targetOption && targetOption.draggable) {
                      const rect = targetDiv.getBoundingClientRect()
                      const position =
                        touch.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                      if (dragOverValue !== targetOption.value || dragDropPosition !== position) {
                        setDragOverValue(targetOption.value)
                        setDragDropPosition(position)
                      }
                    }
                  }
                }

                const scrollContainer = targetDiv?.closest('.custom-scrollbar') as HTMLElement
                if (scrollContainer) {
                  const containerRect = scrollContainer.getBoundingClientRect()
                  const scrollThreshold = 30

                  if (dragScrollIntervalRef.current) {
                    clearInterval(dragScrollIntervalRef.current)
                    dragScrollIntervalRef.current = null
                  }

                  if (touch.clientY < containerRect.top + scrollThreshold) {
                    dragScrollIntervalRef.current = window.setInterval(() => {
                      scrollContainer.scrollTop -= 5
                    }, 16)
                  } else if (touch.clientY > containerRect.bottom - scrollThreshold) {
                    dragScrollIntervalRef.current = window.setInterval(() => {
                      scrollContainer.scrollTop += 5
                    }, 16)
                  }
                }
              }}
              onTouchEnd={(e) => {
                const drag = touchDragRef.current
                if (!drag || !drag.moved) {
                  clearTouchDrag()
                  return
                }

                e.preventDefault()

                if (onReorder && dragOverValue !== null && dragOverValue !== drag.value) {
                  onReorder(drag.value, dragOverValue, dragDropPosition)
                }

                clearTouchDrag()
              }}
              onTouchCancel={clearTouchDrag}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button, [data-drag-handle]')) return
                e.preventDefault()
                onChange(option.value)
                setIsOpen(false)
              }}
              className={`relative flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs transition-colors ${
                index === activeIndex && draggedValue !== option.value
                  ? 'ring-1 ring-inset ring-ring/40'
                  : ''
              } ${
                draggedValue === option.value
                  ? 'opacity-40 bg-muted'
                  : option.variant === 'action'
                    ? 'font-semibold text-primary hover:bg-primary/10'
                    : option.variant === 'danger'
                      ? 'font-semibold text-destructive hover:bg-destructive/10 dark:text-destructive dark:hover:bg-destructive/10'
                      : option.value === value
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-foreground hover:bg-card'
              }`}
            >
              {dragOverValue === option.value &&
                dragDropPosition === 'before' &&
                draggedValue !== option.value && (
                  <div className="absolute -top-[1px] left-0 right-0 h-[2px] bg-primary rounded-full z-40 shadow-sm pointer-events-none" />
                )}
              {dragOverValue === option.value &&
                dragDropPosition === 'after' &&
                draggedValue !== option.value && (
                  <div className="absolute -bottom-[1px] left-0 right-0 h-[2px] bg-primary rounded-full z-40 shadow-sm pointer-events-none" />
                )}
              <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                {option.draggable && (
                  <div
                    data-drag-handle
                    className="flex cursor-grab active:cursor-grabbing items-center justify-center text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
                    style={{ touchAction: 'none' }}
                    title={t('select.dragToReorder')}
                  >
                    <DragHandleIcon className="h-3.5 w-3.5" />
                  </div>
                )}
                {option.icon && (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
                    {option.icon}
                  </span>
                )}
                <span className="min-w-0">
                  <span className={`block ${option.icon ? 'break-words' : 'truncate'}`}>
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block truncate text-[10px] font-normal opacity-70">
                      {option.description}
                    </span>
                  )}
                </span>
              </div>
              {option.actions?.length ? (
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {option.actions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      title={action.label}
                      onPointerDown={(event) => {
                        event.stopPropagation()
                      }}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        action.onClick()
                        closeMenu()
                      }}
                      className={`rounded-md p-1.5 transition flex items-center justify-center ${
                        action.variant === 'danger'
                          ? 'text-destructive hover:bg-destructive/10 dark:text-destructive dark:hover:bg-destructive/10'
                          : 'text-muted-foreground hover:bg-muted hover:text-muted-foreground'
                      }`}
                    >
                      {action.label === t('common:action.edit') ? (
                        <EditIcon className="w-3.5 h-3.5" />
                      ) : action.label === t('common:action.delete') ? (
                        <TrashIcon className="w-3.5 h-3.5" />
                      ) : (
                        action.label
                      )}
                    </button>
                  ))}
                </span>
              ) : null}
              {option.variant === 'action' && (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <PlusIcon className="h-4 w-4" />
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {touchDragPreview &&
        createPortal(
          <div
            id="touch-drag-preview"
            className="fixed pointer-events-none z-[110] flex items-center justify-between gap-2 rounded-xl bg-card/95 px-3 py-2 text-xs text-foreground shadow-xl ring-1 ring-black/5 backdrop-blur-xl dark:ring-white/10"
            style={{
              left: touchDragPreview.x - touchDragPreview.offsetX,
              top: touchDragPreview.y - touchDragPreview.offsetY,
              width: touchDragPreview.width,
              minHeight: touchDragPreview.height,
            }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
              <DragHandleIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{touchDragPreview.label}</span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
