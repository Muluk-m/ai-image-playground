import { createFileRoute, Link } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { OpsHealthCard } from '@/components/overview/OpsHealthCard'
import { TodayErrorsCard } from '@/components/overview/TodayErrorsCard'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
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
import { shortId } from '@/lib/format'
import { useTodayOverview } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { GenerationActor, TimeWindow, TodayOverviewResult } from '../../contracts'

export const Route = createFileRoute('/_authed/overview')({ component: OverviewPage })

export function beijingTime(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

function actorSearch(actor: GenerationActor, window: TimeWindow) {
  return {
    ...window,
    ...(actor.kind === 'user'
      ? { userId: actor.id! }
      : actor.kind === 'device'
        ? { deviceId: actor.id! }
        : { unassigned: '1' as const }),
  }
}

function OverviewPage() {
  const query = useTodayOverview()
  return (
    <Page
      crumbs={[{ label: '概览' }]}
      title="今天"
      description="北京时间 00:00 至现在 · 每 30 秒刷新"
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw className={query.isFetching ? 'animate-spin' : undefined} />
          刷新今日任务
        </Button>
      }
    >
      {query.data ? (
        <>
          {query.isError ? (
            <p role="status" className="text-sm text-danger">
              今日任务刷新失败，下面是之前的记录。
            </p>
          ) : null}
          <TodayUsers overview={query.data} />
        </>
      ) : query.isError ? (
        <ErrorState label="今日任务加载失败" error={query.error} />
      ) : (
        <PendingState label="正在读取今天的生成用户" />
      )}
      <section className="grid items-start gap-4 xl:grid-cols-2">
        <OpsHealthCard />
        <TodayErrorsCard />
      </section>
    </Page>
  )
}

function TodayUsers({ overview }: { overview: TodayOverviewResult }) {
  const { summary, window } = overview
  return (
    <>
      <section aria-label="今日生成" className="flex flex-wrap items-baseline gap-x-8 gap-y-3 px-1">
        <span>
          <strong className="mr-2 font-mono text-2xl tabular-nums">{summary.users}</strong>
          <span className="text-sm text-muted-foreground">位生成用户</span>
        </span>
        {summary.devices ? (
          <span>
            <strong className="mr-2 font-mono text-2xl tabular-nums">{summary.devices}</strong>
            <span className="text-sm text-muted-foreground">台匿名设备</span>
          </span>
        ) : null}
        <Link to="/tasks" search={window} className="text-sm hover:underline">
          <strong className="mr-2 font-mono text-2xl tabular-nums">{summary.tasks}</strong>个任务
        </Link>
        <Link
          to="/tasks"
          search={{ ...window, status: 'failed' }}
          className={cn('text-sm hover:underline', summary.failed > 0 && 'text-danger')}
        >
          <strong className="mr-2 font-mono text-2xl tabular-nums">{summary.failed}</strong>失败
        </Link>
        <span className="ml-auto text-xs text-muted-foreground">截至 {beijingTime(window.to)}</span>
      </section>
      <Card className="min-w-0">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 p-4">
          <CardTitle className="text-sm">今天谁在生成</CardTitle>
          <Button variant="outline" size="sm" asChild>
            <Link to="/tasks" search={window}>
              全部任务 →
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {overview.actors.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">用户</TableHead>
                  <TableHead className="text-right">任务</TableHead>
                  <TableHead className="text-right">成功</TableHead>
                  <TableHead className="text-right">失败</TableHead>
                  <TableHead>执行 / 排队</TableHead>
                  <TableHead>最近提交</TableHead>
                  <TableHead className="pr-4 text-right">明细</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.actors.map((actor) => (
                  <TableRow key={`${actor.kind}:${actor.id ?? ''}`}>
                    <TableCell className="max-w-64 pl-4">
                      <Link
                        className="block truncate font-medium hover:underline"
                        to="/tasks"
                        search={actorSearch(actor, window)}
                      >
                        {actor.note ||
                          actor.username ||
                          (actor.kind === 'device'
                            ? `匿名设备 ${shortId(actor.id!)}`
                            : actor.kind === 'user'
                              ? `用户 ${shortId(actor.id!)}`
                              : '未关联用户或设备')}
                      </Link>
                      {actor.note && actor.username ? (
                        <p className="truncate text-xs text-muted-foreground">{actor.username}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {actor.tasks}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {actor.completed}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {actor.failed ? (
                        <Link
                          to="/tasks"
                          search={{ ...actorSearch(actor, window), status: 'failed' }}
                          className="text-danger hover:underline"
                          aria-label={`${actor.note || actor.username || actor.id || '未关联用户'}的失败任务`}
                        >
                          {actor.failed}
                        </Link>
                      ) : (
                        '0'
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {actor.in_progress} / {actor.queued}
                      {actor.reconciling ? (
                        <span className="ml-2 text-warning">{actor.reconciling} 待核查</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {beijingTime(actor.last_submitted_at)}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <Link
                        to="/tasks"
                        search={actorSearch(actor, window)}
                        className="whitespace-nowrap text-sm text-success hover:underline"
                      >
                        看任务 →
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-6">
              <EmptyState label="今天还没有生成任务" />
            </div>
          )}
          {overview.truncated ? (
            <p className="px-4 pb-4 text-xs text-warning">
              显示最近提交的 500 位用户与设备；上方总数包含全部任务。
            </p>
          ) : null}
        </CardContent>
      </Card>
    </>
  )
}
