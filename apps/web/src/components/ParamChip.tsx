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
      className={`relative inline-flex h-10 items-center gap-2 rounded-xl border border-gray-300/80 bg-white/70 px-3 text-left text-xs font-medium transition-colors duration-150 hover:border-gray-400/80 hover:bg-white dark:border-white/[0.12] dark:bg-white/[0.04] dark:hover:border-white/[0.20] dark:hover:bg-white/[0.07] ${
        disabled ? 'cursor-not-allowed opacity-50' : ''
      } ${className ?? ''}`}
    >
      <span className="flex shrink-0 items-center justify-center text-gray-500 dark:text-gray-400">
        {icon}
      </span>
      <span className="min-w-0 truncate text-gray-700 dark:text-gray-200">{label}</span>
      {hasValue && (
        <span className="min-w-0 truncate text-gray-400 dark:text-gray-500">{value}</span>
      )}
      {children}
    </Wrapper>
  )
}
