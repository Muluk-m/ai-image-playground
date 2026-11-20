import { createFileRoute, Link } from '@tanstack/react-router'
import { Download, Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { LightboxDialog } from '@/components/LightboxDialog'
import { ListPagination } from '@/components/ListPagination'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { TaskDetailSheet } from '@/components/TaskDetailSheet'
import { Button } from '@/components/ui/button'
import {
  readTasksTablePrefs,
  type TableDensity,
  type TaskColumnId,
  type TasksTablePrefs,
  taskPresetWindow,
  writeTasksTablePrefs,
} from '@/features/tasks/constants'
import { TasksFilterPanel } from '@/features/tasks/TasksFilterPanel'
import { TasksLogTable } from '@/features/tasks/TasksLogTable'
import { useGenerationTasks, useGenerationTasksClock } from '@/lib/queries'
import { adminApiUrl } from '@/lib/runtime-config'
import {
  clearTaskView,
  type GenerationTasksSearch,
  parseGenerationTasksSearch,
  type TaskDatePreset,
} from '@/lib/search-params'
import type { GenerationTaskFilters, SortDirection, TaskSortField } from '../../contracts'

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

function GenerationTasksPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [liveEnabled, setLiveEnabled] = useState(true)
  const [prefs, setPrefs] = useState<TasksTablePrefs>(() => readTasksTablePrefs())
  const didMountPrefs = useRef(false)
  useEffect(() => {
    if (!didMountPrefs.current) {
      didMountPrefs.current = true
      return
    }
    writeTasksTablePrefs(prefs)
  }, [prefs])

  const isRolling = search.from === undefined && search.to === undefined
  const preset: TaskDatePreset = search.preset ?? (isRolling ? 'today' : 'custom')
  const rollingPreset: Exclude<TaskDatePreset, 'custom'> | undefined =
    isRolling && preset !== 'custom' ? preset : undefined
  const clock = useGenerationTasksClock(isRolling && liveEnabled)
  const taskWindow =
    search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : taskPresetWindow(rollingPreset ?? 'today', clock)

  const {
    task: _task,
    fullscreen: _fullscreen,
    imgIdx: _imgIdx,
    imgKind: _imgKind,
    preset: _preset,
    ...filters
  } = search
  const sortField: TaskSortField = search.sort ?? 'submitted_at'
  const sortDir: SortDirection = search.dir ?? (sortField === 'status' ? 'asc' : 'desc')

  const queryFilters: GenerationTaskFilters = {
    ...filters,
    ...taskWindow,
    page: search.page ?? 1,
    pageSize: search.pageSize ?? 50,
  }
  const query = useGenerationTasks(queryFilters, rollingPreset)
  const tasks = query.data?.tasks ?? []
  const total = query.data?.total ?? tasks.length

  function updatePrefs(patch: Partial<TasksTablePrefs>) {
    setPrefs((previous) => ({ ...previous, ...patch }))
  }

  function update(patch: Partial<GenerationTasksSearch>) {
    void navigate({
      search: (previous) => ({
        ...(previous ?? {}),
        ...patch,
        page: typeof patch.page === 'number' ? patch.page : 1,
      }),
      replace: true,
    })
  }

  function replaceSearch(next: GenerationTasksSearch) {
    void navigate({ search: next, replace: true })
  }

  const closeTask = () => {
    void navigate({ search: clearTaskView })
  }

  const description = !isRolling
    ? '北京时间 · 固定时间范围'
    : liveEnabled
      ? '北京时间 · 每 30 秒自动刷新'
      : '北京时间 · 自动刷新已暂停'

  return (
    <>
      <Page
        crumbs={[{ label: '概览', to: '/overview' }, { label: '生成任务' }]}
        description={description}
        actions={
          <div className="flex items-center gap-2">
            {isRolling ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setLiveEnabled((prev) => !prev)}
              >
                {liveEnabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                {liveEnabled ? '暂停刷新' : '恢复刷新'}
              </Button>
            ) : null}
            <Button
              type="button"
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
              <Download className="size-3.5" />
              {exporting ? '导出中…' : `导出 CSV${query.data ? ` (${total})` : ''}`}
            </Button>
          </div>
        }
      >
        <TasksFilterPanel
          search={search}
          preset={preset}
          window={taskWindow}
          facets={query.data?.facets}
          advancedOpen={prefs.advancedOpen}
          onToggleAdvanced={() => updatePrefs({ advancedOpen: !prefs.advancedOpen })}
          onUpdate={update}
          onReplace={replaceSearch}
          onPreset={(next, range) => {
            if (next === 'custom' && !range) {
              update({ preset: 'custom', from: taskWindow.from, to: taskWindow.to })
              return
            }
            if (next === 'custom' && range) {
              update({ preset: 'custom', from: range.from, to: range.to })
              return
            }
            update({ preset: next === 'today' ? undefined : next, from: undefined, to: undefined })
          }}
        />

        {exportError ? (
          <p role="alert" className="text-xs text-danger">
            {exportError}
          </p>
        ) : null}

        {query.data ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            {tasks.length ? (
              <TasksLogTable
                tasks={tasks}
                summary={query.data.summary}
                total={total}
                selectedTaskId={search.task}
                sortField={sortField}
                sortDir={sortDir}
                pinCount={prefs.pinCount}
                hiddenCols={prefs.hiddenCols}
                density={prefs.density}
                onSortChange={(nextSort, nextDir) =>
                  update({
                    sort: nextSort === 'submitted_at' && nextDir === 'desc' ? undefined : nextSort,
                    dir: nextSort === 'submitted_at' && nextDir === 'desc' ? undefined : nextDir,
                  })
                }
                onPinCountChange={(pinCount) => updatePrefs({ pinCount })}
                onToggleColumn={(id: TaskColumnId) => {
                  const next = prefs.hiddenCols.includes(id)
                    ? prefs.hiddenCols.filter((item) => item !== id)
                    : [...prefs.hiddenCols, id]
                  updatePrefs({ hiddenCols: next })
                }}
                onResetColumns={() => updatePrefs({ hiddenCols: [] })}
                onDensityChange={(density: TableDensity) => updatePrefs({ density })}
                onOpenTask={(taskId) => void navigate({ search: { ...search, task: taskId } })}
                onQuickFilterUser={(userId) =>
                  update({
                    userId,
                    deviceId: undefined,
                    unassigned: undefined,
                    actorType: undefined,
                  })
                }
                onQuickFilterDevice={(deviceId) =>
                  update({
                    deviceId,
                    userId: undefined,
                    unassigned: undefined,
                    actorType: undefined,
                  })
                }
              />
            ) : (
              <div className="p-6">
                <EmptyState label="这段时间没有匹配的生成任务" />
              </div>
            )}
            <ListPagination
              page={query.data.page ?? queryFilters.page ?? 1}
              pageSize={queryFilters.pageSize === 100 ? 100 : 50}
              total={total}
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
    if (Array.isArray(value) && value.length === 0) continue
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
