import { createFileRoute, Link } from '@tanstack/react-router'
import { Download } from 'lucide-react'
import { useState } from 'react'

import {
  FilterBar,
  type FilterChip,
  type FilterDefinition,
  type FilterPreset,
  presetWindow,
} from '@/components/FilterBar'
import { FuzzyTime } from '@/components/FuzzyTime'
import { LightboxDialog } from '@/components/LightboxDialog'
import { ListPagination } from '@/components/ListPagination'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { ShortId } from '@/components/ShortId'
import { StatusBadge } from '@/components/StatusBadge'
import { TaskDetailSheet } from '@/components/TaskDetailSheet'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { duration, shortId } from '@/lib/format'
import { useGenerationTasks, useGenerationTasksClock } from '@/lib/queries'
import { adminApiUrl } from '@/lib/runtime-config'
import { clearTaskView, parseGenerationTasksSearch } from '@/lib/search-params'
import { cn } from '@/lib/utils'
import {
  type GenerationTaskFilters,
  gptRouteLabel,
  TASK_SOURCE_LABELS,
  todayWindow,
} from '../../contracts'

export const Route = createFileRoute('/_authed/tasks/')({
  validateSearch: parseGenerationTasksSearch,
  component: GenerationTasksPage,
  errorComponent: ({ error }) => (
    <Page crumbs={[{ label: '概览', to: '/overview' }, { label: '生成任务' }]}>
      <ErrorState label="任务筛选无效" error={error} />
      <Button variant="outline" asChild>
        <Link to="/tasks" search={{}}>
          查看今天全部任务
        </Link>
      </Button>
    </Page>
  ),
})

const ERROR_OPTIONS = [
  { value: 'upstream_timeout', label: '上游超时' },
  { value: 'upstream_error', label: '上游错误' },
  { value: 'upstream_result_unknown', label: '结果未确认' },
  { value: 'content_policy', label: '内容审核拒绝' },
  { value: 'model_unavailable', label: '模型不可用' },
  { value: 'rate_limited', label: '上游限流' },
  { value: 'unknown', label: '未分类' },
]
const DEFINITIONS: FilterDefinition[] = [
  {
    key: 'status',
    label: '状态',
    kind: 'single',
    options: [
      { value: 'failed', label: '失败' },
      { value: 'completed', label: '成功' },
      { value: 'in_progress', label: '执行中' },
      { value: 'queued', label: '排队' },
      { value: 'reconciling', label: '待核查' },
      { value: 'cancelled', label: '已取消' },
    ],
  },
  {
    key: 'source',
    label: '来源',
    kind: 'single',
    options: [
      { value: 'chat', label: 'Chat' },
      { value: 'cli', label: 'CLI' },
      { value: 'manual', label: '手动' },
    ],
  },
  { key: 'models', label: '模型', kind: 'multi', placeholder: '模型 ID，逗号分隔' },
  { key: 'providers', label: '供应商', kind: 'multi', placeholder: '供应商 ID，逗号分隔' },
  { key: 'errorTypes', label: '错误类型', kind: 'multi', options: ERROR_OPTIONS },
  { key: 'minDurationSec', label: '耗时大于（秒）', kind: 'number', placeholder: '例如 60' },
]
const time = (at: number) =>
  new Date(at).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

function GenerationTasksPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const clock = useGenerationTasksClock(search.from === undefined && search.to === undefined)
  const preset = search.preset ?? (search.from === undefined ? 'today' : 'custom')
  const taskWindow =
    search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : preset === '7d'
        ? presetWindow('7d', clock)
        : preset === '30d'
          ? presetWindow('30d', clock)
          : todayWindow(clock)
  const {
    task: _task,
    fullscreen: _fullscreen,
    imgIdx: _imgIdx,
    imgKind: _imgKind,
    preset: _preset,
    ...filters
  } = search
  const queryFilters: GenerationTaskFilters = {
    ...filters,
    ...taskWindow,
    page: search.page ?? 1,
    pageSize: search.pageSize ?? 50,
  }
  const query = useGenerationTasks(queryFilters)
  const tasks = query.data?.tasks ?? []
  const closeTask = () => {
    void navigate({ search: clearTaskView })
  }
  function update(patch: Partial<typeof search>) {
    void navigate({
      search: (previous) => ({
        ...(previous ?? {}),
        ...patch,
        page: typeof patch.page === 'number' ? patch.page : 1,
      }),
      replace: true,
    })
  }
  const values: Record<string, string> = {
    status: search.status ?? '',
    source: search.source ?? '',
    models: search.models?.join(',') ?? search.model ?? '',
    providers: search.providers?.join(',') ?? '',
    errorTypes: search.errorTypes?.join(',') ?? '',
    minDurationSec: search.minDurationSec ? String(search.minDurationSec) : '',
  }
  const chips: FilterChip[] = []
  if (search.status) chips.push({ key: 'status', label: '状态', value: search.status })
  if (search.source) chips.push({ key: 'source', label: '来源', value: search.source })
  if (values.models) chips.push({ key: 'models', label: '模型', value: values.models })
  if (values.providers) chips.push({ key: 'providers', label: '供应商', value: values.providers })
  if (values.errorTypes) chips.push({ key: 'errorTypes', label: '错误', value: values.errorTypes })
  if (search.minDurationSec)
    chips.push({ key: 'minDurationSec', label: '耗时', value: `> ${search.minDurationSec}s` })
  if (search.userId) chips.push({ key: 'userId', label: '用户', value: search.userId })
  if (search.deviceId) chips.push({ key: 'deviceId', label: '设备', value: search.deviceId })
  return (
    <>
      <Page
        crumbs={[{ label: '概览', to: '/overview' }, { label: '生成任务' }]}
        description="北京时间 · 每 30 秒自动刷新"
        actions={
          <Button
            size="sm"
            variant="outline"
            disabled={exporting}
            onClick={() => {
              setExportError('')
              setExporting(true)
              void exportCsv(queryFilters)
                .catch(() => setExportError('导出失败'))
                .finally(() => setExporting(false))
            }}
          >
            <Download />
            {exporting ? '导出中…' : '导出 CSV'}
          </Button>
        }
      >
        <FilterBar
          savedViewKey="tasks"
          preset={preset}
          from={taskWindow.from}
          to={taskWindow.to}
          onPreset={(next, range) => {
            if (next === 'all') return
            if (next === 'custom' && !range) {
              update({ preset: 'custom', from: taskWindow.from, to: taskWindow.to })
              return
            }
            update({
              preset: next,
              from: next === 'custom' ? range?.from : next === 'today' ? undefined : range?.from,
              to: next === 'custom' ? range?.to : next === 'today' ? undefined : range?.to,
            })
          }}
          search={search.q ?? ''}
          searchPlaceholder="搜索任务 ID、提示词或用户名"
          onSearch={(q) => {
            const jump = /^tsk_[A-Za-z0-9_-]+$/.test(q) || /^[0-9a-f-]{16,}$/i.test(q)
            update({ q: q || undefined, ...(jump ? { task: q } : {}) })
          }}
          chips={chips}
          definitions={DEFINITIONS}
          values={values}
          onChange={(key, value) => {
            if (key === 'models')
              update({ models: value.split(',').filter(Boolean), model: undefined })
            else if (key === 'providers' || key === 'errorTypes')
              update({ [key]: value.split(',').filter(Boolean) })
            else if (key === 'minDurationSec')
              update({ minDurationSec: Number(value) || undefined })
            else update({ [key]: value })
          }}
          onRemove={(key) =>
            update({
              [key]: undefined,
              ...(key === 'models' ? { model: undefined } : {}),
            })
          }
          onClear={() => void navigate({ search: {}, replace: true })}
        />
        {exportError ? (
          <p role="alert" className="text-xs text-danger">
            {exportError}
          </p>
        ) : null}
        {query.data ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            {tasks.length ? (
              <>
                <div className="grid gap-2 md:hidden">
                  {tasks.map((task) => {
                    const selected = search.task === task.id
                    return (
                      <article
                        key={task.id}
                        className={cn(
                          'rounded-lg border p-3 transition-colors hover:bg-muted/40',
                          selected && 'border-brand bg-brand/10',
                        )}
                      >
                        <button
                          type="button"
                          className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => void navigate({ search: { ...search, task: task.id } })}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="flex min-w-0 items-center gap-2">
                              <StatusBadge status={task.status} />
                              <span className="truncate text-sm font-medium">
                                {task.username ??
                                  (task.user_id ? shortId(task.user_id, 10) : '匿名设备')}
                              </span>
                            </span>
                            <FuzzyTime ts={task.submitted_at} />
                          </div>
                          <p className="mt-2 line-clamp-2 text-sm">
                            {task.prompt || '查看任务详情'}
                          </p>
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
                            <span className="font-mono">
                              {duration(task.started_at, task.completed_at)}
                            </span>
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
                <div className="hidden overflow-x-auto md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>提交时间</TableHead>
                        <TableHead>任务</TableHead>
                        <TableHead>用户</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>需求 / 模型</TableHead>
                        <TableHead>来源 / 供应商</TableHead>
                        <TableHead className="text-right">耗时</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tasks.map((task) => {
                        const selected = search.task === task.id
                        return (
                          <TableRow
                            key={task.id}
                            className={cn(selected && 'bg-brand/25')}
                            data-state={selected ? 'selected' : undefined}
                          >
                            <TableCell className="whitespace-nowrap font-mono text-xs">
                              {time(task.submitted_at)}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  className="min-h-9 rounded px-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  onClick={() =>
                                    void navigate({ search: { ...search, task: task.id } })
                                  }
                                >
                                  <ShortId value={task.id} len={10} copy={false} />
                                </button>
                                <ShortId value={task.id} compact />
                              </div>
                            </TableCell>
                            <TableCell className="max-w-40 truncate text-xs">
                              {task.username ? (
                                task.username
                              ) : task.user_id ? (
                                <ShortId value={task.user_id} len={10} />
                              ) : task.device_id ? (
                                <span className="inline-flex items-center gap-1">
                                  设备 <ShortId value={task.device_id} len={8} />
                                </span>
                              ) : (
                                '—'
                              )}
                            </TableCell>
                            <TableCell>
                              <StatusBadge status={task.status} />
                              {task.error_type ? (
                                <p className="mt-1 font-mono text-[11px] text-danger">
                                  {task.error_type}
                                </p>
                              ) : null}
                            </TableCell>
                            <TableCell className="max-w-72">
                              <button
                                type="button"
                                className="line-clamp-2 text-left text-xs hover:underline"
                                onClick={() =>
                                  void navigate({ search: { ...search, task: task.id } })
                                }
                              >
                                {task.prompt || '查看任务'}
                              </button>
                              <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                                {task.model}
                              </p>
                            </TableCell>
                            <TableCell className="text-xs">
                              <span className="block">{TASK_SOURCE_LABELS[task.source]}</span>
                              <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                                {task.provider}
                                {gptRouteLabel(task.gpt_route)
                                  ? ` · ${gptRouteLabel(task.gpt_route)}`
                                  : ''}
                                {task.gpt_route === 'direct' && task.gpt_key_fingerprint
                                  ? ` · ${task.gpt_key_fingerprint}`
                                  : ''}
                              </span>
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {duration(task.started_at, task.completed_at)}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              </>
            ) : (
              <div className="p-6">
                <EmptyState label="这段时间没有匹配的生成任务" />
              </div>
            )}
            <ListPagination
              page={query.data.page ?? queryFilters.page ?? 1}
              pageSize={queryFilters.pageSize === 100 ? 100 : 50}
              total={query.data.total ?? tasks.length}
              onPage={(page) => update({ page })}
              onPageSize={(pageSize) => update({ pageSize, page: 1 })}
            />
          </div>
        ) : query.isError ? (
          <ErrorState label="任务加载失败" error={query.error} />
        ) : (
          <PendingState label="正在读取生成任务" />
        )}
      </Page>
      <TaskDetailSheet
        taskId={search.task}
        onOpenChange={(open) => {
          if (!open) closeTask()
        }}
      />
      <LightboxDialog
        taskId={search.task}
        imgIdx={search.imgIdx}
        imgKind={search.imgKind}
        fullscreen={search.fullscreen}
      />
    </>
  )
}

async function exportCsv(filters: GenerationTaskFilters) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || key === 'page' || key === 'pageSize') continue
    params.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }
  const response = await fetch(adminApiUrl(`/api/tasks/export?${params}`), {
    credentials: 'include',
  })
  if (!response.ok) throw new Error('export failed')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'generation-tasks.csv'
  anchor.click()
  URL.revokeObjectURL(url)
}
