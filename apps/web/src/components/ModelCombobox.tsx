import { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon } from './icons'

interface ModelComboboxProps {
  value: string
  onChange: (val: string) => void
  onCommit?: (val: string) => void
  options: string[]
  placeholder?: string
  className?: string
  disabled?: boolean
}

/**
 * 文本输入 + 候选下拉的组合控件。
 * - 直接输入：允许用户填写任意自定义模型 ID
 * - 点击右侧箭头/向下方向键：弹出候选列表，点击候选项填入输入框并触发 commit
 * - 失焦时触发 onCommit
 */
export default function ModelCombobox({
  value,
  onChange,
  onCommit,
  options,
  placeholder,
  className,
  disabled,
}: ModelComboboxProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const pick = (option: string) => {
    onChange(option)
    onCommit?.(option)
    setIsOpen(false)
  }

  const showDropdown = isOpen && options.length > 0 && !disabled

  return (
    <div ref={containerRef} className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          if (options.length > 0 && !disabled) setIsOpen(true)
        }}
        onClick={() => {
          if (options.length > 0 && !disabled) setIsOpen(true)
        }}
        onBlur={(e) => onCommit?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && options.length > 0) {
            e.preventDefault()
            setIsOpen(true)
          } else if (e.key === 'Escape') {
            setIsOpen(false)
          }
        }}
        type="text"
        disabled={disabled}
        placeholder={placeholder}
        className={`w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 pr-10 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50 ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className ?? ''}`}
      />
      {options.length > 0 && (
        <button
          type="button"
          onMouseDown={(e) => {
            // 用 mousedown 抢在 input 的 onBlur 之前，避免点击箭头时 commit
            e.preventDefault()
            if (!disabled) setIsOpen((v) => !v)
          }}
          disabled={disabled}
          aria-label="展开模型候选"
          className="absolute right-2 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
        >
          <ChevronDownIcon
            className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>
      )}
      {showDropdown && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 max-h-60 overflow-y-auto rounded-xl border border-gray-200/80 bg-white shadow-lg dark:border-white/[0.08] dark:bg-zinc-900">
          {options.map((option) => {
            const isSelected = option === value
            return (
              <button
                key={option}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(option)
                }}
                className={`flex w-full items-center px-3 py-2 text-left text-sm font-mono transition ${
                  isSelected
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
                    : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-white/[0.04]'
                }`}
              >
                {option}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
