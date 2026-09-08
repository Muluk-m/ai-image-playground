import { ACTIVE_CHIP, CHIP, IDLE_CHIP, PARAM_ROW_KEY } from './chipStyles'

/** 一行互斥 chip 的参数控件。左栏与派生弹窗共用。 */
export default function ChipRow<T extends string | number>({
  label,
  options,
  value,
  render,
  onChange,
  disabled,
  optionDisabled,
  note,
}: {
  label: string
  options: readonly T[]
  value: T
  render: (option: T) => string
  onChange: (option: T) => void
  disabled?: boolean
  /** 整行可用、但个别档位与另一行的选择配不上时置灰它。 */
  optionDisabled?: (option: T) => boolean
  note?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={PARAM_ROW_KEY}>{label}</span>
      {note && <span className="text-xs text-gray-600 dark:text-gray-300">{note}</span>}
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const off = disabled === true || optionDisabled?.(option) === true
          return (
            <button
              key={option}
              type="button"
              disabled={off}
              aria-pressed={!off && option === value}
              onClick={() => onChange(option)}
              className={`${CHIP} ${!off && option === value ? ACTIVE_CHIP : IDLE_CHIP}`}
            >
              {render(option)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
