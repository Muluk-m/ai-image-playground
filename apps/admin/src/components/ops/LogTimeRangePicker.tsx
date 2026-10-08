import { CalendarDays, Clock3 } from 'lucide-react'
import { useState } from 'react'
import type { DateRange } from 'react-day-picker'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LOG_RANGES } from '@/lib/server-log-search'

type Window = { from: number; to: number }
const presets = [
  ['15m', '15 分钟'],
  ['1h', '1 小时'],
  ['24h', '24 小时'],
  ['7d', '7 天'],
] as const
const beijing = (at: number) => new Date(at + 8 * 3600_000).toISOString()
const day = (at: number) => new Date(beijing(at).slice(0, 10) + 'T00:00:00')
const dateText = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export function LogTimeRangePicker({
  window,
  range,
  fixed,
  onPreset,
  onWindow,
}: {
  window: Window
  range: keyof typeof LOG_RANGES
  fixed: boolean
  onPreset: (range: keyof typeof LOG_RANGES) => void
  onWindow: (window: Window) => void
}) {
  const [open, setOpen] = useState(false)
  const [dates, setDates] = useState<DateRange | undefined>()
  const [fromTime, setFromTime] = useState('00:00:00')
  const [toTime, setToTime] = useState('23:59:59')
  const [error, setError] = useState('')
  const today = day(Date.now())
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="日志时间范围">
      <Clock3 className="mr-1 size-4 text-muted-foreground" aria-hidden="true" />
      <div className="flex rounded-lg bg-muted/50 p-1">
        {presets.map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant="ghost"
            aria-pressed={!fixed && range === key}
            className={
              !fixed && range === key
                ? 'bg-success/15 text-success hover:bg-success/20'
                : 'text-muted-foreground'
            }
            onClick={() => onPreset(key)}
          >
            {label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const now = Date.now()
            onWindow({ from: Date.parse(beijing(now).slice(0, 10) + 'T00:00:00+08:00'), to: now })
          }}
        >
          今天
        </Button>
      </div>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setDates({ from: day(window.from), to: day(window.to) })
            setFromTime(beijing(window.from).slice(11, 19))
            setToTime(beijing(window.to).slice(11, 19))
            setError('')
          }
          setOpen(next)
        }}
      >
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            aria-label="自定义时间范围"
            className={fixed ? 'border-success/40 bg-success/5 text-success' : ''}
          >
            <CalendarDays className="mr-2 size-4" />
            {fixed ? '已选时间范围' : '自定义'}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[min(560px,calc(100vw-2rem))] overflow-hidden p-0"
          align="start"
        >
          <div className="border-b px-4 py-3">
            <p className="text-sm font-semibold">选择时间范围</p>
            <p className="mt-1 text-xs text-muted-foreground">
              北京时间 · 最多 7 天 · 点击选择起止日期
            </p>
          </div>
          <div className="flex flex-col sm:flex-row">
            <Calendar
              mode="range"
              selected={dates}
              onSelect={setDates}
              defaultMonth={day(window.from)}
              disabled={{ after: today }}
              className="mx-auto shrink-0"
            />
            <div className="flex-1 space-y-4 border-t bg-muted/20 p-4 sm:border-l sm:border-t-0">
              <label className="block space-y-2 text-xs text-muted-foreground">
                <span>开始 · {dates?.from ? dateText(dates.from) : '选择日期'}</span>
                <Input
                  aria-label="开始时刻（北京时间）"
                  type="time"
                  step="1"
                  value={fromTime}
                  onChange={(event) => setFromTime(event.target.value)}
                />
              </label>
              <label className="block space-y-2 text-xs text-muted-foreground">
                <span>结束 · {dates?.to ? dateText(dates.to) : '选择日期'}</span>
                <Input
                  aria-label="结束时刻（北京时间）"
                  type="time"
                  step="1"
                  value={toTime}
                  onChange={(event) => setToTime(event.target.value)}
                />
              </label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDates({ from: today, to: today })
                  setFromTime('00:00:00')
                  setToTime(beijing(Date.now()).slice(11, 19))
                }}
              >
                今天 00:00 至现在
              </Button>
            </div>
          </div>
          {error ? (
            <p role="alert" className="px-4 pb-3 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const from = dates?.from && Date.parse(`${dateText(dates.from)}T${fromTime}+08:00`)
                const to = dates?.to && Date.parse(`${dateText(dates.to)}T${toTime}+08:00`)
                if (
                  !from ||
                  !to ||
                  !Number.isFinite(from) ||
                  !Number.isFinite(to) ||
                  to <= from ||
                  to - from > LOG_RANGES['7d'] ||
                  to > Date.now() + 60_000
                ) {
                  setError('请选择有效的起止时间，跨度不超过 7 天，结束时间不晚于现在。')
                  return
                }
                onWindow({ from, to })
                setOpen(false)
              }}
            >
              应用时间范围
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
