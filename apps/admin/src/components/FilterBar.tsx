import { Plus, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DateTimePicker } from '@/components/DateTimePicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { readSavedViews, removeSavedView, writeSavedView } from '@/lib/saved-views'
import { cn } from '@/lib/utils'
import { todayWindow } from '../../contracts'

export type FilterPreset = 'all' | 'today' | '7d' | '30d' | 'custom'

export interface FilterChip {
  key: string
  label: string
  value: string
}

export interface FilterDefinition {
  key: string
  label: string
  kind: 'single' | 'multi' | 'number' | 'text'
  options?: ReadonlyArray<{ value: string; label: string }>
  placeholder?: string
}

export function presetWindow(preset: 'today' | '7d' | '30d', now = Date.now()) {
  if (preset === 'today') return todayWindow(now)
  const days = preset === '7d' ? 7 : 30
  return { from: now - days * 86_400_000, to: now }
}

export function beijingInput(at: number): string {
  return new Date(at + 8 * 3600_000).toISOString().slice(0, 16)
}

export function parseBeijingInput(value: string, end = false): number {
  return Date.parse(`${value}:${end ? '59.999' : '00'}+08:00`)
}

const PRESET_LABEL: Record<FilterPreset, string> = {
  all: '全部',
  today: '今天',
  '7d': '7 天',
  '30d': '30 天',
  custom: '自定义',
}

export function FilterBar({
  savedViewKey,
  presets = ['today', '7d', '30d', 'custom'],
  preset,
  from,
  to,
  onPreset,
  search,
  onSearch,
  searchPlaceholder,
  chips,
  definitions,
  values,
  onChange,
  onRemove,
  onClear,
}: {
  savedViewKey: string
  presets?: readonly FilterPreset[]
  preset?: FilterPreset
  from?: number
  to?: number
  onPreset?: (preset: FilterPreset, window?: { from: number; to: number }) => void
  search: string
  onSearch: (value: string) => void
  searchPlaceholder: string
  chips: readonly FilterChip[]
  definitions: readonly FilterDefinition[]
  values: Record<string, string>
  onChange: (key: string, value: string) => void
  onRemove: (key: string) => void
  onClear: () => void
}) {
  const [draft, setDraft] = useState(search)
  useEffect(() => setDraft(search), [search])
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 p-2.5">
        {onPreset && preset ? (
          <div className="flex h-8 items-center rounded-md border p-0.5 text-xs">
            {presets.map((item) => (
              <button
                key={item}
                type="button"
                className={cn(
                  'h-7 rounded px-2.5',
                  preset === item ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
                )}
                onClick={() => {
                  if (item === 'custom' || item === 'all') onPreset(item)
                  else onPreset(item, presetWindow(item))
                }}
              >
                {PRESET_LABEL[item]}
              </button>
            ))}
          </div>
        ) : null}
        {preset === 'custom' && onPreset ? (
          <CustomRange from={from} to={to} onPreset={onPreset} />
        ) : from !== undefined && to !== undefined ? (
          <span className="text-xs text-muted-foreground">
            {formatRange(from)} — {formatRange(to)}
          </span>
        ) : null}
        <form
          className="relative min-w-[220px] flex-1"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            onSearch(draft.trim())
          }}
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-8 pl-8 text-xs"
          />
        </form>
        <SavedViews pageKey={savedViewKey} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-2.5 py-2">
        {chips.map((chip) => (
          <span
            key={chip.key}
            className="inline-flex h-7 items-center overflow-hidden rounded-md border text-xs"
          >
            <span className="px-2 text-muted-foreground">{chip.label}</span>
            <span className="border-x px-2 font-medium">{chip.value}</span>
            <button
              type="button"
              className="inline-flex h-full w-7 items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label={`移除${chip.label}`}
              onClick={() => onRemove(chip.key)}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <AddFilter definitions={definitions} values={values} onChange={onChange} />
        {chips.length || search ? (
          <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={onClear}>
            清空
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function formatRange(at: number): string {
  return new Date(at).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function CustomRange({
  from,
  to,
  onPreset,
}: {
  from?: number
  to?: number
  onPreset: (preset: FilterPreset, window?: { from: number; to: number }) => void
}) {
  const [start, setStart] = useState(from ? beijingInput(from) : '')
  const [end, setEnd] = useState(to ? beijingInput(to) : '')
  const [error, setError] = useState('')
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const nextFrom = parseBeijingInput(start)
        const nextTo = parseBeijingInput(end, true)
        if (!Number.isFinite(nextFrom) || !Number.isFinite(nextTo) || nextTo <= nextFrom) {
          setError('时间范围无效')
          return
        }
        if (nextTo - nextFrom > 31 * 86_400_000) {
          setError('最多 31 天')
          return
        }
        setError('')
        onPreset('custom', { from: nextFrom, to: nextTo })
      }}
    >
      <DateTimePicker aria-label="开始时间" value={start} onChange={setStart} />
      <DateTimePicker aria-label="结束时间" value={end} onChange={setEnd} />
      <Button type="submit" variant="outline" size="sm">
        应用
      </Button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </form>
  )
}

function AddFilter({
  definitions,
  values,
  onChange,
}: {
  definitions: readonly FilterDefinition[]
  values: Record<string, string>
  onChange: (key: string, value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState(definitions[0]?.key ?? '')
  const definition = definitions.find((item) => item.key === key) ?? definitions[0]
  const [draft, setDraft] = useState(values[key] ?? '')
  useEffect(() => setDraft(values[key] ?? ''), [key, values])
  if (!definition) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 border-dashed px-2 text-xs">
          <Plus className="size-3" />
          添加筛选
        </Button>
      </PopoverTrigger>
      <PopoverContent className="space-y-3">
        <Select value={definition.key} onValueChange={setKey}>
          <SelectTrigger aria-label="筛选字段" className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {definitions.map((item) => (
              <SelectItem key={item.key} value={item.key} className="text-xs">
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {definition.kind === 'single' || definition.kind === 'multi' ? (
          definition.options ? (
            <Select value={draft || undefined} onValueChange={setDraft}>
              <SelectTrigger aria-label={definition.label} className="h-8 text-xs">
                <SelectValue placeholder={definition.placeholder ?? '选择'} />
              </SelectTrigger>
              <SelectContent>
                {definition.options.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="text-xs">
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={definition.placeholder ?? '逗号分隔'}
              aria-label={definition.label}
              className="h-8 text-xs"
            />
          )
        ) : (
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={definition.placeholder}
            aria-label={definition.label}
            inputMode={definition.kind === 'number' ? 'numeric' : 'text'}
            className="h-8 text-xs"
          />
        )}
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={!draft.trim()}
          onClick={() => {
            const current = values[definition.key]
            const next =
              definition.kind === 'multi' && current
                ? [...new Set([...current.split(','), ...draft.split(',')])]
                    .map((item) => item.trim())
                    .filter(Boolean)
                    .join(',')
                : draft.trim()
            onChange(definition.key, next)
            setOpen(false)
          }}
        >
          添加
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function SavedViews({ pageKey }: { pageKey: string }) {
  const [views, setViews] = useState(() => readSavedViews(pageKey))
  const [name, setName] = useState('')
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs">
          保存视图
        </Button>
      </PopoverTrigger>
      <PopoverContent className="space-y-2">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = name.trim()
            if (!trimmed) return
            setViews(
              writeSavedView(pageKey, {
                name: trimmed,
                href: `${window.location.pathname}${window.location.search}`,
              }),
            )
            setName('')
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="视图名称"
            aria-label="视图名称"
            maxLength={40}
            className="h-8 text-xs"
          />
          <Button type="submit" size="sm" variant="outline" disabled={!name.trim()}>
            保存
          </Button>
        </form>
        {views.length === 0 ? (
          <p className="text-xs text-muted-foreground">把当前筛选存成一个名字。</p>
        ) : (
          <ul className="space-y-1">
            {views.map((view) => (
              <li key={view.name} className="flex items-center gap-1">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-muted"
                  onClick={() => {
                    window.location.assign(view.href)
                  }}
                >
                  {view.name}
                </button>
                <button
                  type="button"
                  className="px-1 text-muted-foreground"
                  aria-label={`删除视图 ${view.name}`}
                  onClick={() => setViews(removeSavedView(pageKey, view.name))}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
