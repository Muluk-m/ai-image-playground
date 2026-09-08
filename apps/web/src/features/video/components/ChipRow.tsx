import { ACTIVE_CHIP, CHIP, IDLE_CHIP, PARAM_ROW_KEY } from './chipStyles'

/** 一行互斥 chip 的参数控件。左栏与派生弹窗共用。 */
export default function ChipRow<T extends string | number>({
  label,
  options,
  value,
  render,
  onChange,
  disabled,
  note,
}: {
  label: string
  options: readonly T[]
  value: T
  render: (option: T) => string
  onChange: (option: T) => void
  disabled?: boolean
  note?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={PARAM_ROW_KEY}>{label}</span>
      {note && <span className="text-xs text-gray-600 dark:text-gray-300">{note}</span>}
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={disabled}
            aria-pressed={!disabled && option === value}
            onClick={() => onChange(option)}
            className={`${CHIP} ${!disabled && option === value ? ACTIVE_CHIP : IDLE_CHIP}`}
          >
            {render(option)}
          </button>
        ))}
      </div>
    </div>
  )
}
