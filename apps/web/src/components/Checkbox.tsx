import React from 'react'

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: React.ReactNode
  tone?: 'primary' | 'danger'
}

export function Checkbox({
  checked,
  onChange,
  label,
  tone = 'primary',
  className,
  ...props
}: CheckboxProps) {
  const toneClasses =
    tone === 'danger'
      ? 'border-destructive/60 checked:bg-destructive checked:border-destructive focus:ring-destructive/20 dark:border-destructive/30'
      : 'border-border checked:bg-primary checked:border-primary focus:ring-ring/20'

  return (
    <label className={`flex items-center gap-2 cursor-pointer group ${className || ''}`}>
      <div className="relative flex items-center justify-center">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className={`peer appearance-none w-4 h-4 rounded-[4px] border bg-background focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-offset-background transition-all cursor-pointer ${toneClasses}`}
          {...props}
        />
        <svg
          className={`absolute w-2.5 h-2.5 pointer-events-none opacity-0 peer-checked:opacity-100 ${tone === 'danger' ? 'text-destructive-foreground' : 'text-primary-foreground'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      {label && (
        <span className="text-[13px] font-medium text-foreground group-hover:text-foreground dark:group-hover:text-white transition-colors">
          {label}
        </span>
      )}
    </label>
  )
}
