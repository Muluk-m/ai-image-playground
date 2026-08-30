import { CalendarIcon } from 'lucide-react'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** 本地时间字面量，与原生 datetime-local 的取值形状一致：`YYYY-MM-DDTHH:mm`。 */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

interface Parts {
  date: string
  hour: string
  minute: string
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

const HOURS = Array.from({ length: 24 }, (_, hour) => pad(hour))
const MINUTES = Array.from({ length: 60 }, (_, minute) => pad(minute))

function split(value: string): Parts | null {
  const match = LOCAL_DATE_TIME.exec(value)
  if (!match) return null
  return { date: `${match[1]}-${match[2]}-${match[3]}`, hour: match[4], minute: match[5] }
}

function toDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function toDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function TimeColumn({
  label,
  options,
  value,
  onSelect,
}: {
  label: string
  options: string[]
  value: string | null
  onSelect: (option: string) => void
}) {
  const activeRef = React.useRef<HTMLButtonElement | null>(null)

  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center' })
  }, [])

  return (
    <div
      role="group"
      aria-label={label}
      className="flex max-h-64 w-14 flex-col gap-1 overflow-y-auto p-1"
    >
      {options.map((option) => {
        const active = option === value
        return (
          <Button
            key={option}
            ref={active ? activeRef : undefined}
            type="button"
            size="sm"
            variant={active ? 'default' : 'ghost'}
            aria-label={`${label} ${option}`}
            aria-pressed={active}
            className="h-7 w-full shrink-0 px-0 font-normal tabular-nums"
            onClick={() => onSelect(option)}
          >
            {option}
          </Button>
        )
      })}
    </div>
  )
}

export interface DateTimePickerProps {
  /** `YYYY-MM-DDTHH:mm`，空串表示未选择。 */
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  disabled?: boolean
  name?: string
  className?: string
  placeholder?: string
  'aria-label'?: string
}

/**
 * 日期与时间选择器。取值形状与原生 datetime-local 相同，但整套面板由 shadcn 组件渲染，
 * 因此跟随后台主题，不会弹出浏览器自带的浅色日历。
 */
const DateTimePicker = React.forwardRef<HTMLButtonElement, DateTimePickerProps>(
  function DateTimePicker(
    { value, onChange, onBlur, disabled, name, className, placeholder = '选择日期和时间', ...rest },
    ref,
  ) {
    const parts = split(value)
    const selected = parts ? toDate(parts.date) : undefined

    const emit = (next: Parts) => onChange(`${next.date}T${next.hour}:${next.minute}`)
    const fallbackDate = () => parts?.date ?? toDateString(new Date())

    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            ref={ref}
            type="button"
            variant="outline"
            name={name}
            disabled={disabled}
            onBlur={onBlur}
            aria-label={rest['aria-label']}
            className={cn(
              'w-full justify-start gap-2 font-normal tabular-nums',
              !parts && 'text-muted-foreground',
              className,
            )}
          >
            <CalendarIcon className="opacity-70" />
            {parts
              ? `${parts.date.split('-').join('/')} ${parts.hour}:${parts.minute}`
              : placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="flex w-auto divide-x p-0">
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected}
            onSelect={(day) => {
              if (!day) return
              emit({
                date: toDateString(day),
                hour: parts?.hour ?? '00',
                minute: parts?.minute ?? '00',
              })
            }}
          />
          <TimeColumn
            label="时"
            options={HOURS}
            value={parts?.hour ?? null}
            onSelect={(hour) => emit({ date: fallbackDate(), hour, minute: parts?.minute ?? '00' })}
          />
          <TimeColumn
            label="分"
            options={MINUTES}
            value={parts?.minute ?? null}
            onSelect={(minute) => emit({ date: fallbackDate(), hour: parts?.hour ?? '00', minute })}
          />
        </PopoverContent>
      </Popover>
    )
  },
)

export { DateTimePicker }
