import type React from 'react'

/** 额外的 button 属性是给 Radix `asChild` 用的：ref / aria-* / data-state 原样转交。 */
interface ParamChipProps extends Omit<React.ComponentPropsWithRef<'button'>, 'value' | 'onClick'> {
  icon: React.ReactNode
  label: string
  value?: string
  /** 缺省时由 children 自处理点击（内嵌 Select / input 走这条路）。 */
  onClick?: () => void
}

export default function ParamChip({
  icon,
  label,
  value,
  onClick,
  disabled,
  className,
  children,
  ...trigger
}: ParamChipProps) {
  const hasValue = value !== undefined && value !== ''
  const tooltipText = hasValue ? `${label}: ${value}` : label
  const chipClass = `relative inline-flex h-10 items-center gap-2 rounded-xl border border-input bg-background px-3 text-left text-xs font-medium transition-colors duration-150 hover:border-ring/40 hover:bg-accent ${
    disabled ? 'cursor-not-allowed opacity-50' : ''
  } ${className ?? ''}`
  const content = (
    <>
      <span className="flex shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 truncate text-foreground">{label}</span>
      {hasValue && <span className="min-w-0 truncate text-muted-foreground">{value}</span>}
      {children}
    </>
  )

  if (!onClick) {
    return (
      <div title={tooltipText} className={chipClass}>
        {content}
      </div>
    )
  }
  return (
    <button
      {...trigger}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={tooltipText}
      className={chipClass}
    >
      {content}
    </button>
  )
}
