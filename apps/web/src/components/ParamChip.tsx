import type React from 'react'

interface ParamChipProps {
  icon: React.ReactNode
  /** 主行文字（参考截图 chip 的「Aspect ratio / Style」等单字段）。 */
  label: string
  /** 可选的次级文字（chip 内紧跟 label 后的当前值简写，如 "auto" / "1024²"）。 */
  value?: string
  /** chip 外壳点击转发；省略时由 children 自己处理点击（如内嵌 Select / input）。 */
  onClick?: () => void
  disabled?: boolean
  className?: string
  /** chip 内容区。Select / input / button 透传，期望 children 自带 hover 透明背景。 */
  children?: React.ReactNode
}

/**
 * 默认单行 chip：[icon] [label] [value?] [children?]。高度固定 h-9 与
 * 其他 chip / Generate 按钮对齐。
 *
 * 颜色复用现有 dark/light token，与原 InputBar 风格一致。
 */
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
      className={`group/chip relative inline-flex h-10 items-center gap-2 rounded-xl border border-gray-300/80 bg-white/70 px-3 text-left text-xs font-medium transition-colors duration-150 hover:border-gray-400/80 hover:bg-white dark:border-white/[0.12] dark:bg-white/[0.04] dark:hover:border-white/[0.20] dark:hover:bg-white/[0.07] ${
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

