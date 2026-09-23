import type { ReactNode } from 'react'
import { Input } from '../../../components/ui/input'

/** 参数行里的一格：标签在上、控件在下。工具页那一行只放该工具自己的参数。 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

/** 分段选择：选项少、一眼能看全的参数用它，比下拉少点一下。 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: readonly { value: T; label: ReactNode }[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex flex-wrap rounded-lg border border-border bg-muted/40 p-0.5"
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={`h-8 rounded-md px-3 text-[13px] transition-colors ${
            value === option.value
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** 带单位的正整数输入。清空或输入非法值时不回写，避免把 0 传进几何计算。 */
export function NumberField({
  value,
  onChange,
  unit,
  label,
  min = 1,
}: {
  value: number
  onChange: (value: number) => void
  unit: string
  label: string
  min?: number
}) {
  return (
    <div className="relative w-28">
      <Input
        type="number"
        min={min}
        value={value}
        aria-label={label}
        onChange={(event) => {
          const next = Math.round(Number(event.target.value))
          if (Number.isFinite(next) && next >= min) onChange(next)
        }}
        className="h-8 pr-9 text-[13px]"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
        {unit}
      </span>
    </div>
  )
}
