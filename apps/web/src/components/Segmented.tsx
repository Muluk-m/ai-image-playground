import { ACTIVE_SEGMENT, IDLE_SEGMENT, SEGMENT } from './panelStyles'

interface SegmentedProps<T extends string> {
  label: string
  options: readonly T[]
  labels: Record<T, string>
  value: T
  onChange: (option: T) => void
  disabled?: boolean
}

export default function Segmented<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
  disabled = false,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-900"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          disabled={disabled}
          aria-pressed={value === option}
          className={`${SEGMENT} ${value === option ? ACTIVE_SEGMENT : IDLE_SEGMENT}`}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  )
}
