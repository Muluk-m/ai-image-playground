import { Link, useNavigate } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { FuzzyTime } from '@/components/FuzzyTime'
import { EmptyState, ErrorState, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { StatusBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDurationMs } from '@/features/tasks/constants'
import { duration } from '@/lib/format'
import { useUserTasks } from '@/lib/queries'
import type { TaskListItem } from '@/lib/types'
import { TASK_SOURCE_LABELS } from '../../contracts'

const TASK_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'completed', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'in_progress', label: '执行中' },
  { value: 'reconciling', label: '待核查' },
  { value: 'queued', label: '排队中' },
  { value: 'cancelled', label: '已取消' },
] as const

function ExecutionSummary({ tasks }: { tasks: TaskListItem[] }) {
  const succeeded = tasks.filter((task) => task.status === 'completed').length
  const failed = tasks.filter((task) => task.status === 'failed').length
  const running = tasks.filter((task) => task.status === 'in_progress').length
  const terminal = succeeded + failed
  const durations = tasks
    .flatMap((task) =>
      task.started_at !== null && task.completed_at !== null && task.completed_at >= task.started_at
        ? [task.completed_at - task.started_at]
        : [],
    )
    .sort((left, right) => left - right)
  const lower = durations[Math.floor((durations.length - 1) / 2)]
  const upper = durations[Math.floor(durations.length / 2)]
  const median = lower === undefined || upper === undefined ? null : (lower + upper) / 2
  const rate = terminal ? `${Math.round((succeeded / terminal) * 1000) / 10}%` : '—'

  return (
    <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-2 rounded-md bg-muted/50 px-3 py-2.5 text-xs">
      <div>
        <dt className="sr-only">概况范围</dt>
        <dd className="text-muted-foreground">最近 {tasks.length} 条</dd>
      </div>
      {[
        { label: '成功', value: succeeded, style: 'text-success' },
        { label: '失败', value: failed, style: 'text-danger' },
        { label: '执行中', value: running },
        { label: '成功率', value: rate },
        { label: 'P50 执行耗时', value: formatDurationMs(median) },
      ].map(({ label, value, style }) => (
        <div key={label} className="flex gap-1.5">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className={`font-mono font-semibold tabular-nums ${style ?? ''}`}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function RecentUserTasks({
  userId,
  status,
  onStatusChange,
}: {
  userId: string
  status: string
  onStatusChange: (status: string) => void
}) {
  const navigate = useNavigate()
  const recent = useUserTasks(userId, 'all')
  const query = useUserTasks(userId, status)
  const summary = recent.data?.pages[0]?.tasks
  const tasks = query.data?.pages.flatMap((page) => page.tasks) ?? []
  const refreshing = query.isFetching || recent.isFetching

  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 p-4">
        <CardTitle>最近任务执行情况</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" asChild>
            <Link to="/tasks" search={{ userId, preset: '30d' }}>
              在生成任务页查看 ↗
            </Link>
          </Button>
          <Button
            variant="outline"
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={() => {
              void recent.refetch()
              if (status !== 'all') void query.refetch()
            }}
          >
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
            刷新任务
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {summary?.length ? <ExecutionSummary tasks={summary} /> : null}
        <div className="overflow-x-auto pb-1">
          <SegmentedControl
            options={TASK_FILTERS}
            value={status}
            label="任务状态筛选"
            onChange={onStatusChange}
          />
        </div>
        {query.isPending ? (
          <PendingState label="加载任务" />
        ) : query.isError ? (
          <ErrorState label="加载任务失败" error={query.error} />
        ) : tasks.length === 0 ? (
          <EmptyState label="没有匹配的任务" />
        ) : (
          <div className="overflow-hidden rounded-md border [&>div:first-child]:max-h-[min(60vh,34rem)]">
            <Table className="min-w-[610px] table-fixed">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-[86px]">状态</TableHead>
                  <TableHead className="w-[132px]">模型</TableHead>
                  <TableHead className="w-[64px]">来源</TableHead>
                  <TableHead>提示词 / 错误码</TableHead>
                  <TableHead className="w-[75px] text-right">耗时</TableHead>
                  <TableHead className="w-[90px] text-right">提交时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TableRow
                    key={task.id}
                    className={`cursor-pointer ${task.status === 'failed' ? 'bg-danger/5 hover:bg-danger/10' : ''}`}
                    onClick={() =>
                      void navigate({
                        to: '.',
                        search: (previous) => ({ ...previous, task: task.id }),
                      })
                    }
                  >
                    <TableCell>
                      <StatusBadge status={task.status} />
                    </TableCell>
                    <TableCell className="truncate font-mono text-xs" title={task.model}>
                      {task.model}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {TASK_SOURCE_LABELS[task.source]}
                    </TableCell>
                    <TableCell className="py-0">
                      <Link
                        to="."
                        search={(previous) => ({ ...previous, task: task.id })}
                        className="flex min-h-9 items-center gap-1.5 overflow-hidden rounded-sm text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        title={task.prompt}
                        aria-label={`查看任务 ${task.id}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {task.error_type ? (
                          <span className="max-w-full shrink-0 truncate rounded bg-danger/10 px-1.5 font-mono text-danger">
                            {task.error_type}
                          </span>
                        ) : null}
                        <span className="truncate">
                          {task.prompt || (task.error_type ? '' : '—')}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {duration(task.started_at, task.completed_at)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-xs">
                      <FuzzyTime ts={task.submitted_at} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {query.hasNextPage ? (
              <div className="flex justify-center border-t p-2">
                <Button
                  variant="ghost"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchingNextPage ? '加载中…' : '加载更多'}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
