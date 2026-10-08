import { createFileRoute, Link } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { LightboxDialog } from '@/components/LightboxDialog'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { StatusBadge } from '@/components/StatusBadge'
import { TaskDetailSheet } from '@/components/TaskDetailSheet'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { duration, shortId } from '@/lib/format'
import { useGenerationTasks } from '@/lib/queries'
import { clearTaskView, parseGenerationTasksSearch } from '@/lib/search-params'
import { todayWindow } from '../../contracts'

export const Route = createFileRoute('/_authed/tasks/')({
  validateSearch: parseGenerationTasksSearch,
  component: GenerationTasksPage,
})
const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'completed', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'in_progress', label: '执行中' },
  { value: 'queued', label: '排队' },
  { value: 'reconciling', label: '待核查' },
  { value: 'cancelled', label: '已取消' },
]
const time = (at: number) =>
  new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

function GenerationTasksPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [defaultWindow, setDefaultWindow] = useState(todayWindow)
  const {
    task: _task,
    fullscreen: _fullscreen,
    imgIdx: _imgIdx,
    imgKind: _imgKind,
    ...filters
  } = search
  const window =
    search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : defaultWindow
  const query = useGenerationTasks({ ...filters, ...window })
  const tasks = query.data?.pages.flatMap((page) => page.tasks) ?? []
  const owner = search.userId
    ? (tasks[0]?.username ?? search.userId)
    : search.deviceId
      ? `匿名设备 ${shortId(search.deviceId)}`
      : search.unassigned
        ? '未关联用户或设备'
        : null
  const closeTask = () => {
    void navigate({ search: clearTaskView })
  }
  return (
    <>
      <Page
        crumbs={[{ label: '概览', to: '/overview' }, { label: '生成任务' }]}
        description={`${time(window.from)} — ${time(window.to)} · 北京时间${owner ? ` · ${owner}` : ''}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDefaultWindow(todayWindow())
                void navigate({ search: {} })
              }}
            >
              今天全部任务
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={query.isFetching}
              onClick={() => {
                if (search.from !== undefined && search.to !== undefined) void query.refetch()
                else setDefaultWindow(todayWindow())
              }}
            >
              <RefreshCw className={query.isFetching ? 'animate-spin' : undefined} />
              刷新
            </Button>
          </div>
        }
      >
        <SegmentedControl
          label="任务状态筛选"
          options={FILTERS}
          value={search.status ?? 'all'}
          onChange={(status) => {
            void navigate({
              search: {
                ...filters,
                status:
                  status === 'all' ? undefined : (status as NonNullable<typeof search.status>),
              },
              replace: true,
            })
          }}
        />
        {query.data ? (
          <>
            {query.isError ? (
              <p role="status" className="text-sm text-danger">
                任务刷新失败，下面是之前的记录。
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              已加载 {tasks.length} 条 · 从新到旧 · 点击任务查看完整明细
            </p>
            {tasks.length ? (
              <Card className="overflow-x-auto">
                <Table className="min-w-[800px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>提交时间</TableHead>
                      <TableHead>用户</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>需求 / 模型</TableHead>
                      <TableHead>耗时</TableHead>
                      <TableHead>任务</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.map((task) => (
                      <TableRow key={task.id}>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {time(task.submitted_at)}
                        </TableCell>
                        <TableCell className="max-w-48 break-words text-xs">
                          {task.username ||
                            (task.user_id
                              ? `用户 ${shortId(task.user_id)}`
                              : task.device_id
                                ? `匿名设备 ${shortId(task.device_id)}`
                                : '未关联用户或设备')}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={task.status} />
                          {task.error_type ? (
                            <p className="mt-1 text-xs text-danger">{task.error_type}</p>
                          ) : null}
                        </TableCell>
                        <TableCell className="max-w-96">
                          <button
                            type="button"
                            className="line-clamp-2 text-left text-xs hover:underline"
                            onClick={() => void navigate({ search: { ...search, task: task.id } })}
                          >
                            {task.prompt || '查看任务'}
                          </button>
                          <p className="mt-1 text-xs text-muted-foreground">{task.model}</p>
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {duration(task.started_at, task.completed_at)}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void navigate({ search: { ...search, task: task.id } })}
                          >
                            查看
                          </Button>
                          <Link
                            to="/logs"
                            search={{
                              taskId: task.id,
                              from: Math.max(
                                0,
                                task.submitted_at - 60_000,
                                (task.completed_at ?? Date.now()) + 60_000 - 7 * 86400_000,
                              ),
                              to: Math.min(Date.now(), (task.completed_at ?? Date.now()) + 60_000),
                            }}
                            className="ml-2 whitespace-nowrap text-xs text-success hover:underline"
                          >
                            日志 →
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            ) : (
              <EmptyState label="这段时间没有匹配的生成任务" />
            )}
            {query.hasNextPage ? (
              <Button
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? '加载中…' : '加载更多任务'}
              </Button>
            ) : null}
          </>
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
