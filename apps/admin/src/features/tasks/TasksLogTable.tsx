import { ArrowDown, ArrowUp, ArrowUpDown, Check, Columns3, Filter } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { ShortId } from '@/components/ShortId'
import { StatusBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { duration, shortId } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type GenerationTaskItem,
  type GenerationTasksSummary,
  gptRouteLabel,
  type SortDirection,
  TASK_SOURCE_LABELS,
  type TaskSortField,
} from '../../../contracts'
import {
  ERROR_LABEL_MAP,
  formatDurationMs,
  SORT_FIELD_OPTIONS,
  TASK_COLUMNS,
  type TableDensity,
  type TaskColumnDef,
  type TaskColumnId,
} from './constants'

interface TasksLogTableProps {
  tasks: readonly GenerationTaskItem[]
  summary?: GenerationTasksSummary
  total: number
  selectedTaskId?: string
  sortField: TaskSortField
  sortDir: SortDirection
  pinCount: 2 | 3 | 4
  hiddenCols: readonly TaskColumnId[]
  density: TableDensity
  onSortChange: (field: TaskSortField, dir: SortDirection) => void
  onPinCountChange: (count: 2 | 3 | 4) => void
  onToggleColumn: (id: TaskColumnId) => void
  onResetColumns: () => void
  onDensityChange: (density: TableDensity) => void
  onOpenTask: (taskId: string) => void
  onQuickFilterUser: (userId: string) => void
  onQuickFilterDevice: (deviceId: string) => void
}

const formatSubmittedAt = (at: number) =>
  new Date(at).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

function msDiff(start: number | null, end: number | null): number | null {
  if (start == null || end == null || end < start) return null
  return end - start
}

export function TasksLogTable({
  tasks,
  summary,
  total,
  selectedTaskId,
  sortField,
  sortDir,
  pinCount,
  hiddenCols,
  density,
  onSortChange,
  onPinCountChange,
  onToggleColumn,
  onResetColumns,
  onDensityChange,
  onOpenTask,
  onQuickFilterUser,
  onQuickFilterDevice,
}: TasksLogTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrolledX, setScrolledX] = useState(false)
  const [hasMoreRight, setHasMoreRight] = useState(false)

  const hiddenSet = useMemo(() => new Set<TaskColumnId>(hiddenCols), [hiddenCols])
  const columns = useMemo(() => {
    const visible = TASK_COLUMNS.filter((col, index) => index < pinCount || !hiddenSet.has(col.id))
    let left = 0
    return visible.map((col, index) => {
      const pinned = index < pinCount
      const isPinEdge = index === pinCount - 1
      const offset = pinned ? left : undefined
      if (pinned) left += col.width
      return { ...col, pinned, isPinEdge, left: offset }
    })
  }, [pinCount, hiddenSet])

  const syncScrollIndicators = useCallback(() => {
    const node = scrollRef.current
    if (!node) return
    setScrolledX(node.scrollLeft > 2)
    setHasMoreRight(node.scrollLeft + node.clientWidth < node.scrollWidth - 4)
  }, [])

  useEffect(() => {
    syncScrollIndicators()
    const node = scrollRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncScrollIndicators)
    observer.observe(node)
    return () => observer.disconnect()
  }, [syncScrollIndicators, columns.length, tasks.length])

  function handleHeaderSort(field: TaskSortField) {
    if (sortField === field) {
      onSortChange(field, sortDir === 'desc' ? 'asc' : 'desc')
    } else {
      onSortChange(field, field === 'status' ? 'asc' : 'desc')
    }
  }

  const completedCount = summary?.completed ?? 0
  const failedCount = summary?.failed ?? 0
  const activeCount = (summary?.in_progress ?? 0) + (summary?.queued ?? 0)
  const finishedCount = completedCount + failedCount
  const successRate =
    finishedCount > 0 ? `${((completedCount / finishedCount) * 100).toFixed(1)}%` : '—'

  const scrollableCount = Math.max(0, columns.length - pinCount)

  return (
    <TooltipProvider delayDuration={250}>
      {/* Toolbar: Filtered Summary + Sort + Freeze + Column Picker + Density */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b bg-muted/25 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
          <span>
            匹配{' '}
            <strong className="font-semibold text-foreground">
              {total.toLocaleString('zh-CN')}
            </strong>{' '}
            条
          </span>
          {summary ? (
            <>
              <span aria-hidden="true" className="text-border">
                |
              </span>
              <span>
                成功率 <strong className="font-semibold text-success">{successRate}</strong>
              </span>
              {failedCount > 0 ? (
                <span className="text-danger">
                  失败 <strong className="font-semibold">{failedCount}</strong>
                </span>
              ) : null}
              {activeCount > 0 ? (
                <span className="text-info">
                  进行中 <strong className="font-semibold">{activeCount}</strong>
                </span>
              ) : null}
              <span aria-hidden="true" className="text-border">
                |
              </span>
              <span>
                P50{' '}
                <strong className="font-semibold text-foreground">
                  {formatDurationMs(summary.p50_run_ms)}
                </strong>
              </span>
              <span>
                P95{' '}
                <strong
                  className={cn(
                    'font-semibold',
                    summary.p95_run_ms !== null && summary.p95_run_ms >= 30_000
                      ? 'text-warning'
                      : 'text-foreground',
                  )}
                >
                  {formatDurationMs(summary.p95_run_ms)}
                </strong>
              </span>
            </>
          ) : null}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Sort Field + Direction */}
          <div className="inline-flex items-center rounded-md border bg-background">
            <span className="pl-2.5 text-[11px] text-muted-foreground">排序</span>
            <Select
              value={sortField}
              onValueChange={(value) => {
                const nextField = value as TaskSortField
                onSortChange(nextField, nextField === 'status' ? 'asc' : 'desc')
              }}
            >
              <SelectTrigger
                aria-label="排序字段"
                className="h-8 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none focus:ring-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {SORT_FIELD_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 rounded-none rounded-r-md border-l px-2 text-xs"
              onClick={() => onSortChange(sortField, sortDir === 'desc' ? 'asc' : 'desc')}
            >
              {sortDir === 'asc' ? (
                <ArrowUp className="size-3.5" />
              ) : (
                <ArrowDown className="size-3.5" />
              )}
              <span>{sortDir === 'asc' ? '升序' : '降序'}</span>
            </Button>
          </div>

          {/* Freeze Left Columns */}
          <div className="hidden items-center rounded-md border bg-background md:inline-flex">
            <span className="pl-2.5 text-[11px] text-muted-foreground">左侧固定</span>
            <Select
              value={String(pinCount)}
              onValueChange={(value) => onPinCountChange(value === '2' ? 2 : value === '4' ? 4 : 3)}
            >
              <SelectTrigger
                aria-label="左侧固定列数"
                className="h-8 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none focus:ring-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="2" className="text-xs">
                  2 列（状态 · 时间）
                </SelectItem>
                <SelectItem value="3" className="text-xs">
                  3 列（状态 · 时间 · 任务）
                </SelectItem>
                <SelectItem value="4" className="text-xs">
                  4 列（+ 用户）
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Column Picker */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="hidden h-8 gap-1.5 text-xs md:inline-flex"
              >
                <Columns3 className="size-3.5" />
                <span>列设置</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 space-y-2 p-2.5">
              <div className="flex items-center justify-between px-1">
                <span className="text-[11px] font-medium text-muted-foreground">显示列</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={onResetColumns}
                >
                  重置
                </Button>
              </div>
              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {TASK_COLUMNS.map((col, index) => {
                  const pinned = index < pinCount
                  const checked = pinned || !hiddenSet.has(col.id)
                  return (
                    <button
                      key={col.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      disabled={pinned}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs',
                        pinned ? 'opacity-60' : 'hover:bg-muted',
                      )}
                      onClick={() => {
                        if (!pinned) onToggleColumn(col.id)
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={cn(
                            'flex h-3.5 w-3.5 items-center justify-center rounded-sm border',
                            checked
                              ? 'border-brand bg-brand text-brand-foreground'
                              : 'border-input bg-background',
                          )}
                        >
                          {checked ? <Check className="size-2.5" /> : null}
                        </span>
                        <span>{col.label}</span>
                      </span>
                      {pinned ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          固定
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </PopoverContent>
          </Popover>

          {/* Row Density */}
          <div
            role="group"
            aria-label="行高密度"
            className="hidden h-8 items-center rounded-md border bg-background p-0.5 text-xs md:inline-flex"
          >
            <button
              type="button"
              aria-pressed={density === 'compact'}
              className={cn(
                'h-7 rounded px-2 text-xs font-medium transition-colors',
                density === 'compact'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => onDensityChange('compact')}
            >
              紧凑
            </button>
            <button
              type="button"
              aria-pressed={density === 'standard'}
              className={cn(
                'h-7 rounded px-2 text-xs font-medium transition-colors',
                density === 'standard'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => onDensityChange('standard')}
            >
              标准
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Cards (< md) */}
      <div className="grid gap-2 p-2 md:hidden">
        {tasks.map((task) => {
          const selected = selectedTaskId === task.id
          return (
            <article
              key={task.id}
              className={cn(
                'rounded-lg border p-3 transition-colors hover:bg-muted/40',
                selected && 'border-brand tasks-row-selected',
              )}
            >
              <button
                type="button"
                className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onOpenTask(task.id)}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusBadge status={task.status} />
                    <span className="truncate text-sm font-medium">
                      {task.username ?? (task.user_id ? shortId(task.user_id, 10) : '匿名设备')}
                    </span>
                  </span>
                  <FuzzyTime ts={task.submitted_at} />
                </div>
                <p className="mt-2 line-clamp-2 text-sm">{task.prompt || '查看任务详情'}</p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{task.model}</span>
                  <span>
                    {TASK_SOURCE_LABELS[task.source]} · {task.provider}
                  </span>
                  {gptRouteLabel(task.gpt_route) ? (
                    <span className="font-mono">
                      {gptRouteLabel(task.gpt_route)}
                      {task.gpt_route === 'direct' && task.gpt_key_fingerprint
                        ? ` · ${task.gpt_key_fingerprint}`
                        : ''}
                    </span>
                  ) : null}
                  <span className="font-mono">{duration(task.started_at, task.completed_at)}</span>
                </div>
                {task.error_type ? (
                  <p className="mt-2 font-mono text-xs text-danger">{task.error_type}</p>
                ) : null}
              </button>
              <div className="mt-2">
                <ShortId value={task.id} len={10} />
              </div>
            </article>
          )
        })}
      </div>

      {/* Desktop Single-Line Sticky-Left Horizontal Scroll Table */}
      <div className="relative hidden md:block">
        <div
          ref={scrollRef}
          onScroll={syncScrollIndicators}
          className="max-h-[calc(100vh-20rem)] min-h-[360px] w-full overflow-auto"
        >
          <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                {columns.map((col) => {
                  const isSorted = col.sortField === sortField
                  const cellStyle = {
                    width: `${col.width}px`,
                    minWidth: `${col.width}px`,
                    maxWidth: `${col.width}px`,
                    ...(col.pinned ? { left: `${col.left}px` } : {}),
                  }
                  return (
                    <th
                      key={col.id}
                      scope="col"
                      style={cellStyle}
                      aria-sort={
                        isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined
                      }
                      className={cn(
                        'sticky top-0 h-10 whitespace-nowrap border-b border-border bg-secondary px-3 align-middle text-xs font-medium text-muted-foreground select-none',
                        col.align === 'right' ? 'text-right' : 'text-left',
                        col.pinned ? 'z-30' : 'z-20',
                        col.isPinEdge && 'border-r border-border',
                        col.isPinEdge && scrolledX && 'tasks-pinned-shadow',
                      )}
                    >
                      {col.sortField ? (
                        <button
                          type="button"
                          onClick={() => handleHeaderSort(col.sortField!)}
                          className={cn(
                            'inline-flex items-center gap-1 whitespace-nowrap font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            isSorted && 'text-foreground',
                          )}
                        >
                          <span>{col.label}</span>
                          {isSorted ? (
                            sortDir === 'asc' ? (
                              <ArrowUp className="size-3 text-foreground" />
                            ) : (
                              <ArrowDown className="size-3 text-foreground" />
                            )
                          ) : (
                            <ArrowUpDown className="size-3 opacity-45" />
                          )}
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const selected = selectedTaskId === task.id
                return (
                  <tr
                    key={task.id}
                    data-state={selected ? 'selected' : undefined}
                    className="group cursor-pointer"
                    onClick={(event) => {
                      const target = event.target as HTMLElement | null
                      if (target?.closest('button, a, input, [role="button"]')) return
                      onOpenTask(task.id)
                    }}
                  >
                    {columns.map((col) => {
                      const cellStyle = {
                        width: `${col.width}px`,
                        minWidth: `${col.width}px`,
                        maxWidth: `${col.width}px`,
                        ...(col.pinned ? { left: `${col.left}px` } : {}),
                      }
                      return (
                        <td
                          key={col.id}
                          style={cellStyle}
                          className={cn(
                            'whitespace-nowrap border-b border-border/60 px-3 align-middle transition-colors',
                            density === 'compact' ? 'h-10' : 'h-12',
                            col.align === 'right' ? 'text-right' : 'text-left',
                            selected ? 'tasks-row-selected' : 'bg-card group-hover:bg-muted',
                            col.pinned && 'sticky z-10',
                            col.isPinEdge && 'border-r border-border',
                            col.isPinEdge && scrolledX && 'tasks-pinned-shadow',
                          )}
                        >
                          <TaskCell
                            col={col}
                            task={task}
                            onOpenTask={onOpenTask}
                            onQuickFilterUser={onQuickFilterUser}
                            onQuickFilterDevice={onQuickFilterDevice}
                          />
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Right-edge scroll cue */}
        {hasMoreRight ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-2 right-0 top-0 z-20 w-7 bg-gradient-to-l from-card to-transparent"
          />
        ) : null}

        {/* Subtle freeze & horizontal scroll readout */}
        <div className="flex items-center justify-between border-t bg-muted/15 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>
            左侧固定 {pinCount} 列 · 右侧 {scrollableCount} 列可横向滚动
          </span>
          <span>点击任意行打开右侧详情抽屉</span>
        </div>
      </div>
    </TooltipProvider>
  )
}

function TaskCell({
  col,
  task,
  onOpenTask,
  onQuickFilterUser,
  onQuickFilterDevice,
}: {
  col: TaskColumnDef
  task: GenerationTaskItem
  onOpenTask: (taskId: string) => void
  onQuickFilterUser: (userId: string) => void
  onQuickFilterDevice: (deviceId: string) => void
}) {
  switch (col.id) {
    case 'status':
      return <StatusBadge status={task.status} />

    case 'submitted_at':
      return (
        <span className="font-mono text-xs tabular-nums text-foreground">
          {formatSubmittedAt(task.submitted_at)}
        </span>
      )

    case 'task_id':
      return (
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            className="rounded px-1.5 py-1 font-mono text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpenTask(task.id)}
          >
            <ShortId value={task.id} len={10} copy={false} />
          </button>
          <ShortId value={task.id} compact />
        </div>
      )

    case 'actor': {
      const label = task.username
        ? task.username
        : task.user_id
          ? shortId(task.user_id, 10)
          : task.device_id
            ? `设备 ${shortId(task.device_id, 8)}`
            : '—'
      const filterUserId = task.user_id
      const filterDeviceId = !task.user_id ? task.device_id : null
      return (
        <div className="flex max-w-[176px] items-center justify-between gap-1">
          <span
            className={cn(
              'truncate text-xs',
              task.user_id ? 'text-foreground' : 'font-mono text-muted-foreground',
            )}
            title={label !== '—' ? label : undefined}
          >
            {label}
          </span>
          {filterUserId ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`仅看用户 ${label} 的任务`}
              title="仅看该用户的任务"
              className="h-6 w-6 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation()
                onQuickFilterUser(filterUserId)
              }}
            >
              <Filter className="size-3" />
            </Button>
          ) : filterDeviceId ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`仅看设备 ${filterDeviceId} 的任务`}
              title="仅看该设备的任务"
              className="h-6 w-6 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation()
                onQuickFilterDevice(filterDeviceId)
              }}
            >
              <Filter className="size-3" />
            </Button>
          ) : null}
        </div>
      )
    }

    case 'prompt': {
      const text = task.prompt || '查看任务'
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="block max-w-[276px] truncate text-left text-xs text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onOpenTask(task.id)}
            >
              {text}
            </button>
          </TooltipTrigger>
          {task.prompt ? (
            <TooltipContent
              side="bottom"
              align="start"
              className="max-w-md whitespace-pre-wrap break-words"
            >
              {task.prompt}
            </TooltipContent>
          ) : null}
        </Tooltip>
      )
    }

    case 'model':
      return <span className="font-mono text-xs text-foreground">{task.model}</span>

    case 'source':
      return (
        <span className="inline-flex h-5 items-center rounded border bg-muted/60 px-2 text-[11px] font-medium text-foreground">
          {TASK_SOURCE_LABELS[task.source]}
        </span>
      )

    case 'provider':
      return <span className="font-mono text-xs text-muted-foreground">{task.provider}</span>

    case 'route': {
      const route = gptRouteLabel(task.gpt_route)
      if (!route) return <span className="text-muted-foreground">—</span>
      return (
        <span className="inline-flex items-center gap-1.5 font-mono text-xs">
          <span className="text-foreground">{route}</span>
          {task.gpt_route === 'direct' && task.gpt_key_fingerprint ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {task.gpt_key_fingerprint}
            </span>
          ) : null}
        </span>
      )
    }

    case 'run_ms': {
      const ms = msDiff(task.started_at, task.completed_at)
      return (
        <span
          className={cn(
            'font-mono text-xs tabular-nums',
            ms === null
              ? 'text-muted-foreground'
              : ms >= 60_000
                ? 'font-medium text-danger'
                : ms >= 30_000
                  ? 'font-medium text-warning'
                  : 'text-foreground',
          )}
        >
          {formatDurationMs(ms)}
        </span>
      )
    }

    case 'queue_ms': {
      const ms = msDiff(task.submitted_at, task.started_at)
      return (
        <span
          className={cn(
            'font-mono text-xs tabular-nums',
            ms !== null && ms >= 10_000 ? 'font-medium text-warning' : 'text-muted-foreground',
          )}
        >
          {formatDurationMs(ms)}
        </span>
      )
    }

    case 'total_ms': {
      const ms = msDiff(task.submitted_at, task.completed_at)
      return (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {formatDurationMs(ms)}
        </span>
      )
    }

    case 'attempts': {
      const retried = task.attempt_count > 1 || task.upstream_invocation_count > 1
      return (
        <span
          className={cn(
            'font-mono text-xs tabular-nums',
            retried ? 'font-semibold text-warning' : 'text-muted-foreground',
          )}
        >
          {task.attempt_count} / {task.upstream_invocation_count}
        </span>
      )
    }

    case 'upstream_status': {
      if (task.upstream_status == null)
        return <span className="font-mono text-xs text-muted-foreground">—</span>
      return (
        <span
          className={cn(
            'font-mono text-xs font-medium tabular-nums',
            task.upstream_status >= 500
              ? 'text-danger'
              : task.upstream_status >= 400
                ? 'text-warning'
                : 'text-success',
          )}
        >
          {task.upstream_status}
        </span>
      )
    }

    case 'error_type': {
      if (!task.error_type) return <span className="text-muted-foreground">—</span>
      return (
        <span
          className="inline-flex rounded bg-danger/15 px-1.5 py-0.5 font-mono text-[11px] text-danger"
          title={ERROR_LABEL_MAP[task.error_type] ?? task.error_type}
        >
          {task.error_type}
        </span>
      )
    }

    case 'device_id': {
      if (!task.device_id) return <span className="text-muted-foreground">—</span>
      return <ShortId value={task.device_id} len={10} />
    }
  }
}
