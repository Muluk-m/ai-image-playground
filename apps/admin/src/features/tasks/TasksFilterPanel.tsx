import { useRouter } from '@tanstack/react-router'
import { Bookmark, Check, ChevronDown, Filter, Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { DateTimePicker } from '@/components/DateTimePicker'
import { beijingInput, parseBeijingInput } from '@/components/FilterBar'
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
import type { GenerationTasksSearch, TaskDatePreset } from '@/lib/search-params'
import { cn } from '@/lib/utils'
import {
  type GenerationTasksFacets,
  TASK_SOURCE_LABELS,
  type TaskActorType,
  type TaskGptRouteFilter,
  type TaskHttpBucket,
  type TaskSource,
  type TaskStatus,
  type TimeWindow,
} from '../../../contracts'
import {
  ACTOR_TYPE_LABEL_MAP,
  ACTOR_TYPE_OPTIONS,
  ERROR_LABEL_MAP,
  ERROR_OPTIONS,
  GPT_ROUTE_LABEL_MAP,
  GPT_ROUTE_OPTIONS,
  HTTP_BUCKET_LABEL_MAP,
  HTTP_BUCKET_OPTIONS,
  SOURCE_OPTIONS,
  STATUS_META,
  STATUS_ORDER,
  TASK_PRESET_VIEWS,
  TASK_PRESETS,
  type TaskPresetView,
} from './constants'

const ALL_VALUE = '__all__'

interface TasksFilterPanelProps {
  search: GenerationTasksSearch
  preset: TaskDatePreset
  window: TimeWindow
  facets?: GenerationTasksFacets
  advancedOpen: boolean
  onToggleAdvanced: () => void
  onUpdate: (patch: Partial<GenerationTasksSearch>) => void
  onReplace: (next: GenerationTasksSearch) => void
  onPreset: (next: TaskDatePreset, range?: TimeWindow) => void
}

export function TasksFilterPanel({
  search,
  preset,
  window: taskWindow,
  facets,
  advancedOpen,
  onToggleAdvanced,
  onUpdate,
  onReplace,
  onPreset,
}: TasksFilterPanelProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [queryDraft, setQueryDraft] = useState(search.q ?? '')
  const [minDurDraft, setMinDurDraft] = useState(
    search.minDurationSec !== undefined ? String(search.minDurationSec) : '',
  )
  const [maxDurDraft, setMaxDurDraft] = useState(
    search.maxDurationSec !== undefined ? String(search.maxDurationSec) : '',
  )
  const [durError, setDurError] = useState('')

  useEffect(() => setQueryDraft(search.q ?? ''), [search.q])
  useEffect(
    () => setMinDurDraft(search.minDurationSec !== undefined ? String(search.minDurationSec) : ''),
    [search.minDurationSec],
  )
  useEffect(
    () => setMaxDurDraft(search.maxDurationSec !== undefined ? String(search.maxDurationSec) : ''),
    [search.maxDurationSec],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      )
        return
      event.preventDefault()
      searchInputRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const activeStatuses = useMemo<TaskStatus[]>(
    () => [...new Set([...(search.status ? [search.status] : []), ...(search.statuses ?? [])])],
    [search.status, search.statuses],
  )
  const activeSources = useMemo<TaskSource[]>(
    () => [...new Set([...(search.source ? [search.source] : []), ...(search.sources ?? [])])],
    [search.source, search.sources],
  )
  const activeModels = useMemo<string[]>(
    () => [...new Set([...(search.model ? [search.model] : []), ...(search.models ?? [])])],
    [search.model, search.models],
  )
  const activeProviders = search.providers ?? []
  const activeErrorTypes = search.errorTypes ?? []
  const activeHttpBuckets = search.httpBuckets ?? []

  const modelOptions = useMemo(() => {
    const map = new Map<string, number | undefined>()
    for (const item of facets?.models ?? []) map.set(item.value, item.count)
    for (const selected of activeModels) if (!map.has(selected)) map.set(selected, undefined)
    return [...map.entries()].map(([value, count]) => ({ value, label: value, count, mono: true }))
  }, [facets?.models, activeModels])

  const providerOptions = useMemo(() => {
    const map = new Map<string, number | undefined>()
    for (const item of facets?.providers ?? []) map.set(item.value, item.count)
    for (const selected of activeProviders) if (!map.has(selected)) map.set(selected, undefined)
    return [...map.entries()].map(([value, count]) => ({ value, label: value, count, mono: true }))
  }, [facets?.providers, activeProviders])

  const errorOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of facets?.errorTypes ?? []) counts.set(item.value, item.count)
    const seen = new Set<string>()
    const list: MultiSelectOption[] = []
    for (const item of ERROR_OPTIONS) {
      seen.add(item.value)
      list.push({
        value: item.value,
        label: `${item.label} (${item.value})`,
        count: counts.get(item.value),
      })
    }
    for (const [value, count] of counts) {
      if (!seen.has(value)) list.push({ value, label: value, count, mono: true })
    }
    for (const selected of activeErrorTypes) {
      if (!seen.has(selected) && !counts.has(selected))
        list.push({ value: selected, label: selected, mono: true })
    }
    return list
  }, [facets?.errorTypes, activeErrorTypes])

  const totalForStatuses = facets
    ? STATUS_ORDER.reduce((sum, key) => sum + (facets.statusCounts[key] ?? 0), 0)
    : undefined

  const advancedCount = [
    activeModels.length > 0,
    activeProviders.length > 0,
    activeSources.length > 0,
    Boolean(search.gptRoute),
    activeErrorTypes.length > 0,
    activeHttpBuckets.length > 0,
    search.minDurationSec !== undefined || search.maxDurationSec !== undefined,
    Boolean(search.actorType),
    search.retried === '1',
    search.minQueueSec !== undefined,
  ].filter(Boolean).length

  function commitSearch(raw: string) {
    const trimmed = raw.trim()
    const jump =
      /^tsk_[A-Za-z0-9_-]+$/.test(trimmed) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
    onUpdate({ q: trimmed || undefined, ...(jump ? { task: trimmed } : {}) })
  }

  function commitDuration(nextMinRaw = minDurDraft, nextMaxRaw = maxDurDraft) {
    const parse = (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return undefined
      const num = Number(trimmed)
      return Number.isInteger(num) && num >= 1 && num <= 86_400 ? num : Number.NaN
    }
    const min = parse(nextMinRaw)
    const max = parse(nextMaxRaw)
    if (Number.isNaN(min) || Number.isNaN(max)) {
      setDurError('耗时需为 1–86400 整数秒')
      return
    }
    if (min !== undefined && max !== undefined && max < min) {
      setDurError('最大耗时不能小于最小耗时')
      return
    }
    setDurError('')
    if (min !== search.minDurationSec || max !== search.maxDurationSec) {
      onUpdate({ minDurationSec: min, maxDurationSec: max })
    }
  }

  function toggleStatus(target: TaskStatus | 'all') {
    if (target === 'all') {
      onUpdate({ status: undefined, statuses: undefined })
      return
    }
    const next = activeStatuses.includes(target)
      ? activeStatuses.filter((item) => item !== target)
      : [...activeStatuses, target]
    onUpdate({
      status: undefined,
      statuses: next.length ? next : undefined,
    })
  }

  function toggleSource(target: TaskSource) {
    const next = activeSources.includes(target)
      ? activeSources.filter((item) => item !== target)
      : [...activeSources, target]
    onUpdate({
      source: undefined,
      sources: next.length ? next : undefined,
    })
  }

  const chips: Array<{ key: string; label: string; value: string; onRemove: () => void }> = []
  if (search.q)
    chips.push({
      key: 'q',
      label: '搜索',
      value: search.q,
      onRemove: () => onUpdate({ q: undefined }),
    })
  if (activeStatuses.length)
    chips.push({
      key: 'statuses',
      label: '状态',
      value: activeStatuses.map((s) => STATUS_META[s].label).join('、'),
      onRemove: () => onUpdate({ status: undefined, statuses: undefined }),
    })
  if (activeModels.length)
    chips.push({
      key: 'models',
      label: '模型',
      value: activeModels.join(', '),
      onRemove: () => onUpdate({ model: undefined, models: undefined }),
    })
  if (activeProviders.length)
    chips.push({
      key: 'providers',
      label: '供应商',
      value: activeProviders.join(', '),
      onRemove: () => onUpdate({ providers: undefined }),
    })
  if (activeSources.length)
    chips.push({
      key: 'sources',
      label: '来源',
      value: activeSources.map((s) => TASK_SOURCE_LABELS[s]).join('、'),
      onRemove: () => onUpdate({ source: undefined, sources: undefined }),
    })
  if (search.gptRoute)
    chips.push({
      key: 'gptRoute',
      label: '通道',
      value: GPT_ROUTE_LABEL_MAP[search.gptRoute],
      onRemove: () => onUpdate({ gptRoute: undefined }),
    })
  if (activeErrorTypes.length)
    chips.push({
      key: 'errorTypes',
      label: '错误',
      value: activeErrorTypes.map((e) => ERROR_LABEL_MAP[e] ?? e).join('、'),
      onRemove: () => onUpdate({ errorTypes: undefined }),
    })
  if (activeHttpBuckets.length)
    chips.push({
      key: 'httpBuckets',
      label: 'HTTP',
      value: activeHttpBuckets.map((b) => HTTP_BUCKET_LABEL_MAP[b]).join('、'),
      onRemove: () => onUpdate({ httpBuckets: undefined }),
    })
  if (search.minDurationSec !== undefined || search.maxDurationSec !== undefined) {
    const value =
      search.minDurationSec !== undefined && search.maxDurationSec !== undefined
        ? `${search.minDurationSec}s–${search.maxDurationSec}s`
        : search.minDurationSec !== undefined
          ? `≥ ${search.minDurationSec}s`
          : `≤ ${search.maxDurationSec}s`
    chips.push({
      key: 'duration',
      label: '执行耗时',
      value,
      onRemove: () => onUpdate({ minDurationSec: undefined, maxDurationSec: undefined }),
    })
  }
  if (search.actorType)
    chips.push({
      key: 'actorType',
      label: '归属',
      value: ACTOR_TYPE_LABEL_MAP[search.actorType],
      onRemove: () => onUpdate({ actorType: undefined }),
    })
  if (search.retried === '1')
    chips.push({
      key: 'retried',
      label: '特征',
      value: '有重试 (>1次)',
      onRemove: () => onUpdate({ retried: undefined }),
    })
  if (search.minQueueSec !== undefined)
    chips.push({
      key: 'minQueueSec',
      label: '排队',
      value: `≥ ${search.minQueueSec}s`,
      onRemove: () => onUpdate({ minQueueSec: undefined }),
    })
  if (search.userId)
    chips.push({
      key: 'userId',
      label: '用户 ID',
      value: search.userId,
      onRemove: () => onUpdate({ userId: undefined }),
    })
  if (search.deviceId)
    chips.push({
      key: 'deviceId',
      label: '设备 ID',
      value: search.deviceId,
      onRemove: () => onUpdate({ deviceId: undefined }),
    })
  if (search.unassigned === '1')
    chips.push({
      key: 'unassigned',
      label: '归属',
      value: '未归属任务',
      onRemove: () => onUpdate({ unassigned: undefined }),
    })

  return (
    <section aria-label="任务筛选" className="rounded-xl border bg-card">
      {/* Row 1: Time Range + Global Search + Saved Views */}
      <div className="flex flex-wrap items-center gap-2.5 p-3">
        <div
          role="group"
          aria-label="时间范围"
          className="inline-flex h-8 items-center rounded-md border bg-muted/40 p-0.5 text-xs"
        >
          {TASK_PRESETS.map((item) => {
            const active = preset === item.value
            return (
              <button
                key={item.value}
                type="button"
                aria-pressed={active}
                className={cn(
                  'h-7 whitespace-nowrap rounded px-2.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => onPreset(item.value)}
              >
                {item.label}
              </button>
            )
          })}
        </div>

        {preset === 'custom' ? (
          <CustomRangeForm from={taskWindow.from} to={taskWindow.to} onPreset={onPreset} />
        ) : (
          <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
            {formatRangePoint(taskWindow.from)} — {formatRangePoint(taskWindow.to)}
          </span>
        )}

        <form
          className="relative min-w-[240px] flex-1"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            commitSearch(queryDraft)
          }}
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing && queryDraft) {
                event.preventDefault()
                setQueryDraft('')
                if (search.q) onUpdate({ q: undefined })
              }
            }}
            placeholder="搜索任务 ID、提示词、用户名、指纹或模型…"
            aria-label="搜索任务 ID、提示词、用户名、指纹或模型"
            className="h-8 pl-8 pr-12 text-xs"
          />
          {queryDraft ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="清除搜索"
              className="absolute right-6 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setQueryDraft('')
                if (search.q) onUpdate({ q: undefined })
              }}
            >
              <X className="size-3" />
            </Button>
          ) : null}
          <kbd
            aria-hidden="true"
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            /
          </kbd>
        </form>

        <TaskSavedViews
          onApplyPreset={(view) => {
            onReplace({
              ...view.search,
              page: 1,
              pageSize: search.pageSize,
            })
          }}
        />
      </div>

      {/* Row 2: Direct Status Multi-Select Bar + Advanced Panel Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/25 px-3 py-2">
        <div role="group" aria-label="状态快捷筛选" className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={activeStatuses.length === 0}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              activeStatuses.length === 0
                ? 'border-brand bg-brand text-brand-foreground'
                : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            onClick={() => toggleStatus('all')}
          >
            <span>全部</span>
            {totalForStatuses !== undefined ? (
              <span className="font-mono text-[11px] tabular-nums">{totalForStatuses}</span>
            ) : null}
          </button>

          {STATUS_ORDER.map((status) => {
            const meta = STATUS_META[status]
            const active = activeStatuses.includes(status)
            const count = facets?.statusCounts[status]
            return (
              <button
                key={status}
                type="button"
                aria-pressed={active}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-brand bg-brand/20 text-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                onClick={() => toggleStatus(status)}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    meta.dotClass,
                    meta.pulse && (count ?? 0) > 0 && 'animate-pulse',
                  )}
                />
                <span>{meta.label}</span>
                {count !== undefined ? (
                  <span className="font-mono text-[11px] tabular-nums">{count}</span>
                ) : null}
              </button>
            )
          })}
        </div>

        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-expanded={advancedOpen}
          onClick={onToggleAdvanced}
          className="ml-auto gap-1.5"
        >
          <Filter className="size-3" />
          <span>详细筛选</span>
          {advancedCount > 0 ? (
            <span className="rounded bg-brand px-1.5 font-mono text-[11px] font-semibold tabular-nums text-brand-foreground">
              {advancedCount}
            </span>
          ) : null}
          <ChevronDown
            className={cn('size-3 transition-transform', advancedOpen && 'rotate-180')}
          />
        </Button>
      </div>

      {/* Row 3: Structured Multi-Facet Filter Grid */}
      {advancedOpen ? (
        <div className="grid grid-cols-1 gap-2.5 border-t p-3 sm:grid-cols-2 xl:grid-cols-4">
          {/* 1. 模型 */}
          <MultiSelectField
            label="模型"
            placeholder="全部模型"
            options={modelOptions}
            selected={activeModels}
            searchable
            allowCustom
            customPlaceholder="输入模型 ID 回车添加"
            onChange={(next) =>
              onUpdate({ model: undefined, models: next.length ? next : undefined })
            }
          />

          {/* 2. 供应商 */}
          <MultiSelectField
            label="供应商"
            placeholder="全部供应商"
            options={providerOptions}
            selected={activeProviders}
            allowCustom
            customPlaceholder="输入供应商 ID 回车添加"
            onChange={(next) => onUpdate({ providers: next.length ? next : undefined })}
          />

          {/* 3. 来源 */}
          <div className="space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">来源</span>
            <div
              role="group"
              aria-label="来源筛选"
              className="grid h-8 grid-cols-3 gap-1 rounded-md border bg-muted/40 p-0.5"
            >
              {SOURCE_OPTIONS.map((opt) => {
                const active = activeSources.includes(opt.value)
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    className={cn(
                      'rounded text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => toggleSource(opt.value)}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 4. 通道 / 路由 */}
          <div className="space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">通道 / 路由</span>
            <Select
              value={search.gptRoute ?? ALL_VALUE}
              onValueChange={(value) =>
                onUpdate({
                  gptRoute: value === ALL_VALUE ? undefined : (value as TaskGptRouteFilter),
                })
              }
            >
              <SelectTrigger aria-label="通道 / 路由" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE} className="text-xs">
                  全部通道
                </SelectItem>
                {GPT_ROUTE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 5. 错误类型 */}
          <MultiSelectField
            label="错误类型"
            placeholder="全部错误类型"
            options={errorOptions}
            selected={activeErrorTypes}
            onChange={(next) => onUpdate({ errorTypes: next.length ? next : undefined })}
          />

          {/* 6. 上游 HTTP 状态 */}
          <MultiSelectField
            label="上游 HTTP 状态"
            placeholder="全部状态码"
            options={HTTP_BUCKET_OPTIONS.map((opt) => ({
              value: opt.value,
              label: opt.label,
              mono: true,
            }))}
            selected={activeHttpBuckets}
            onChange={(next) =>
              onUpdate({
                httpBuckets: next.length ? (next as TaskHttpBucket[]) : undefined,
              })
            }
          />

          {/* 7. 执行耗时区间 */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">执行耗时（秒）</span>
              <div className="flex items-center gap-1">
                {([15, 30, 60] as const).map((sec) => {
                  const active =
                    search.minDurationSec === sec && search.maxDurationSec === undefined
                  return (
                    <button
                      key={sec}
                      type="button"
                      aria-pressed={active}
                      className={cn(
                        'rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active
                          ? 'bg-brand font-medium text-brand-foreground'
                          : 'bg-muted text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => {
                        setDurError('')
                        onUpdate(
                          active
                            ? { minDurationSec: undefined, maxDurationSec: undefined }
                            : { minDurationSec: sec, maxDurationSec: undefined },
                        )
                      }}
                    >
                      ≥{sec}s
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                value={minDurDraft}
                inputMode="numeric"
                aria-label="最小执行耗时（秒）"
                placeholder="最小 s"
                className="h-8 font-mono text-xs tabular-nums"
                onChange={(event) => setMinDurDraft(event.target.value)}
                onBlur={() => commitDuration()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitDuration()
                  }
                }}
              />
              <span className="text-xs text-muted-foreground">—</span>
              <Input
                value={maxDurDraft}
                inputMode="numeric"
                aria-label="最大执行耗时（秒）"
                placeholder="最大 s"
                className="h-8 font-mono text-xs tabular-nums"
                onChange={(event) => setMaxDurDraft(event.target.value)}
                onBlur={() => commitDuration()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitDuration()
                  }
                }}
              />
            </div>
            {durError ? (
              <p role="alert" className="text-[11px] text-danger">
                {durError}
              </p>
            ) : null}
          </div>

          {/* 8. 归属与特征 */}
          <div className="space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">归属与特征</span>
            <div className="flex items-center gap-1.5">
              <Select
                value={search.actorType ?? ALL_VALUE}
                onValueChange={(value) =>
                  onUpdate({
                    actorType: value === ALL_VALUE ? undefined : (value as TaskActorType),
                    userId: undefined,
                    deviceId: undefined,
                    unassigned: undefined,
                  })
                }
              >
                <SelectTrigger aria-label="归属类型" className="h-8 min-w-0 flex-1 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VALUE} className="text-xs">
                    全部归属
                  </SelectItem>
                  {ACTOR_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="text-xs">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={search.retried === '1'}
                className={cn(
                  'h-8 shrink-0 px-2 text-xs',
                  search.retried === '1' && 'border-brand bg-brand/20 text-foreground',
                )}
                onClick={() => onUpdate({ retried: search.retried === '1' ? undefined : '1' })}
              >
                有重试
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={search.minQueueSec !== undefined}
                className={cn(
                  'h-8 shrink-0 px-2 text-xs',
                  search.minQueueSec !== undefined && 'border-brand bg-brand/20 text-foreground',
                )}
                onClick={() =>
                  onUpdate({ minQueueSec: search.minQueueSec !== undefined ? undefined : 5 })
                }
              >
                排队久
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Row 4: Active Filter Chips */}
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t bg-muted/25 px-3 py-2">
          <span className="text-xs text-muted-foreground">已生效</span>
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex h-6 items-center overflow-hidden rounded-md border bg-card text-xs"
            >
              <span className="px-2 text-muted-foreground">{chip.label}</span>
              <span className="max-w-52 truncate border-x px-2 font-mono font-medium">
                {chip.value}
              </span>
              <button
                type="button"
                className="inline-flex h-full w-6 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`移除${chip.label}`}
                onClick={chip.onRemove}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto text-danger hover:text-danger"
            onClick={() => onReplace({ pageSize: search.pageSize })}
          >
            重置全部
          </Button>
        </div>
      ) : null}
    </section>
  )
}

interface MultiSelectOption {
  value: string
  label: string
  count?: number
  mono?: boolean
}

function MultiSelectField({
  label,
  placeholder,
  options,
  selected,
  searchable = false,
  allowCustom = false,
  customPlaceholder,
  onChange,
}: {
  label: string
  placeholder: string
  options: readonly MultiSelectOption[]
  selected: readonly string[]
  searchable?: boolean
  allowCustom?: boolean
  customPlaceholder?: string
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [customDraft, setCustomDraft] = useState('')

  const visible = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (opt) => opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q),
    )
  }, [options, filterText])

  const summaryText = useMemo(() => {
    if (!selected.length) return placeholder
    if (selected.length === 1) {
      const match = options.find((opt) => opt.value === selected[0])
      return match ? match.label : selected[0]!
    }
    return `已选 ${selected.length} 项`
  }, [selected, options, placeholder])

  function toggle(value: string) {
    if (selected.includes(value)) onChange(selected.filter((item) => item !== value))
    else onChange([...selected, value])
  }

  function addCustom() {
    const parts = customDraft
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (!parts.length) return
    onChange([...new Set([...selected, ...parts])])
    setCustomDraft('')
  }

  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={label}
            className={cn(
              'h-8 w-full justify-between px-2.5 text-xs font-normal',
              !selected.length && 'text-muted-foreground',
            )}
          >
            <span className="truncate">{summaryText}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 space-y-2 p-2.5" align="start">
          {searchable ? (
            <Input
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder={`过滤${label}…`}
              aria-label={`过滤${label}`}
              className="h-7 text-xs"
            />
          ) : null}

          <div className="max-h-52 space-y-0.5 overflow-y-auto">
            {visible.length ? (
              visible.map((opt) => {
                const checked = selected.includes(opt.value)
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => toggle(opt.value)}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                          checked
                            ? 'border-brand bg-brand text-brand-foreground'
                            : 'border-input bg-background',
                        )}
                      >
                        {checked ? <Check className="size-2.5" /> : null}
                      </span>
                      <span className={cn('truncate', opt.mono && 'font-mono')}>{opt.label}</span>
                    </span>
                    {opt.count !== undefined ? (
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {opt.count}
                      </span>
                    ) : null}
                  </button>
                )
              })
            ) : (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                当前时间窗无选项
              </p>
            )}
          </div>

          {allowCustom ? (
            <form
              className="flex gap-1.5 border-t pt-2"
              onSubmit={(event) => {
                event.preventDefault()
                addCustom()
              }}
            >
              <Input
                value={customDraft}
                onChange={(event) => setCustomDraft(event.target.value)}
                placeholder={customPlaceholder ?? '手动输入并添加'}
                aria-label={`自定义${label}`}
                className="h-7 flex-1 font-mono text-xs"
              />
              <Button
                type="submit"
                size="icon-xs"
                variant="outline"
                autoTooltip={false}
                aria-label={`添加${label}`}
                disabled={!customDraft.trim()}
              >
                <Plus className="size-3" />
              </Button>
            </form>
          ) : null}

          {selected.length > 0 ? (
            <div className="flex justify-end border-t pt-1.5">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 px-2 text-xs text-muted-foreground"
                onClick={() => onChange([])}
              >
                清空此项
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}

function CustomRangeForm({
  from,
  to,
  onPreset,
}: {
  from: number
  to: number
  onPreset: (preset: TaskDatePreset, range?: TimeWindow) => void
}) {
  const [start, setStart] = useState(() => beijingInput(from))
  const [end, setEnd] = useState(() => beijingInput(to))
  const [error, setError] = useState('')
  useEffect(() => {
    setStart(beijingInput(from))
    setEnd(beijingInput(to))
  }, [from, to])
  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
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
        if (nextTo > Date.now() + 60_000) {
          setError('结束时间不能在未来')
          return
        }
        setError('')
        onPreset('custom', { from: nextFrom, to: nextTo })
      }}
    >
      <DateTimePicker
        aria-label="开始时间"
        value={start}
        onChange={setStart}
        className="h-8 w-auto text-xs"
      />
      <span className="text-xs text-muted-foreground">—</span>
      <DateTimePicker
        aria-label="结束时间"
        value={end}
        onChange={setEnd}
        className="h-8 w-auto text-xs"
      />
      <Button type="submit" variant="outline" size="sm" className="h-8 text-xs">
        应用
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </form>
  )
}

function TaskSavedViews({ onApplyPreset }: { onApplyPreset: (view: TaskPresetView) => void }) {
  const router = useRouter({ warn: false })
  const [open, setOpen] = useState(false)
  const [views, setViews] = useState(() => readSavedViews('tasks'))
  const [name, setName] = useState('')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
          <Bookmark className="size-3.5" />
          <span>视图预设</span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2.5 p-2.5">
        <div className="space-y-0.5">
          <p className="px-2 py-0.5 text-[11px] font-medium text-muted-foreground">快捷排查视图</p>
          {TASK_PRESET_VIEWS.map((view) => (
            <button
              key={view.id}
              type="button"
              className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                onApplyPreset(view)
                setOpen(false)
              }}
            >
              <span className="block text-xs font-medium text-foreground">{view.name}</span>
              <span className="block text-[11px] text-muted-foreground">{view.description}</span>
            </button>
          ))}
        </div>

        <form
          className="flex gap-1.5 border-t pt-2.5"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = name.trim()
            if (!trimmed) return
            setViews(
              writeSavedView('tasks', {
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
            placeholder="保存当前筛选为视图…"
            aria-label="视图名称"
            maxLength={40}
            className="h-8 flex-1 text-xs"
          />
          <Button type="submit" size="sm" variant="outline" className="h-8" disabled={!name.trim()}>
            保存
          </Button>
        </form>

        {views.length > 0 ? (
          <div className="space-y-0.5 border-t pt-2">
            <p className="px-2 py-0.5 text-[11px] font-medium text-muted-foreground">已保存视图</p>
            {views.map((view) => (
              <div key={view.name} className="flex items-center gap-1">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-muted"
                  onClick={() => {
                    setOpen(false)
                    if (router) {
                      router.history.push(view.href)
                    } else {
                      window.location.assign(view.href)
                    }
                  }}
                >
                  {view.name}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`删除视图 ${view.name}`}
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  onClick={() => setViews(removeSavedView('tasks', view.name))}
                >
                  <X className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function formatRangePoint(at: number): string {
  return new Date(at).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
