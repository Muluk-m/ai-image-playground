import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../i18n'
import { Button } from './ui/button'
import { Icon } from './ui/icon'
import { Input } from './ui/input'

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
  const { t } = useTranslation('composer')
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
      <Input
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
        className={`pr-10 ${className ?? ''}`}
      />
      {options.length > 0 && (
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onMouseDown={(e) => {
            // 用 mousedown 抢在 input 的 onBlur 之前，避免点击箭头时 commit
            e.preventDefault()
            if (!disabled) setIsOpen((v) => !v)
          }}
          disabled={disabled}
          aria-label={t('model.expandOptions')}
          className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          <Icon
            name="chevronDown"
            className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </Button>
      )}
      {showDropdown && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 max-h-60 overflow-y-auto rounded-xl border border-border/80 bg-card shadow-popover">
          {options.map((option) => {
            const isSelected = option === value
            return (
              <Button
                variant="ghost"
                size="default"
                key={option}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(option)
                }}
                className={`h-auto min-h-9 w-full justify-start whitespace-normal break-all px-3 py-2 text-left font-mono ${
                  isSelected
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground hover:bg-card hover:bg-accent'
                }`}
              >
                <span className="min-w-0 flex-1">{option}</span>
              </Button>
            )
          })}
        </div>
      )}
    </div>
  )
}
