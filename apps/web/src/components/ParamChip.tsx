import type React from 'react'

interface ParamChipProps {
  icon: React.ReactNode
  label: string
  value?: string
  /** 缺省时由 children 自处理点击（内嵌 Select / input 走这条路）。 */
  onClick?: () => void
  disabled?: boolean
  className?: string
  children?: React.ReactNode
}

export default function ParamChip({
  icon,
  label,
  value,
  onClick,
  disabled,
  className,
  children,
}: ParamChipProps) {
  const Wrapper = onClick ? 'button' : 'div'
  const hasValue = value !== undefined && value !== ''
  const tooltipText = hasValue ? `${label}: ${value}` : label
  return (
    <Wrapper
      {...(onClick ? { type: 'button' as const, onClick, disabled } : {})}
      title={tooltipText}
      className={`relative inline-flex h-10 items-center gap-2 rounded-xl border border-input bg-background px-3 text-left text-xs font-medium transition-colors duration-150 hover:border-ring/40 hover:bg-accent ${
        disabled ? 'cursor-not-allowed opacity-50' : ''
      } ${className ?? ''}`}
    >
      <span className="flex shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 truncate text-foreground">{label}</span>
      {hasValue && <span className="min-w-0 truncate text-muted-foreground">{value}</span>}
      {children}
    </Wrapper>
  )
}
