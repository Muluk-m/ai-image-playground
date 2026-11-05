import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DateTimePicker } from '@/components/DateTimePicker'
import { beijingInput, parseBeijingInput } from '@/components/FilterBar'
import { OverviewActivity } from '@/components/overview/OverviewActivity'
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
import {
  GENERATION_PRESETS,
  type GenerationSelection,
  generationRefreshInterval,
  generationWindow,
  parseGenerationSearch,
  readGenerationSelection,
  saveGenerationSelection,
} from '@/lib/generation-overview'
import { useGenerationOverview } from '@/lib/queries'
import { cn } from '@/lib/utils'
import {
  type GenerationActor,
  type GenerationUsersOverview,
  parseTimeWindow,
  type TimeWindow,
} from '../../contracts'

export const Route = createFileRoute('/_authed/overview')({
  validateSearch: parseGenerationSearch,
  beforeLoad: ({ search }) => {
    if (!search.preset)
      throw redirect({ to: '/overview', search: readGenerationSelection(), replace: true })
  },
  component: OverviewPage,
  errorComponent: ({ error }) => (
    <Page crumbs={[{ label: '概览' }]}>
      <ErrorState label="概览范围无效" error={error} />
      <Button variant="outline" asChild>
        <Link to="/overview" search={{ preset: '24h' }}>
          查看最近 24 小时
        </Link>
      </Button>
    </Page>
  ),
})

function OverviewPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const selection = search.preset ? search : { preset: '24h' as const }
  const query = useGenerationOverview(selection)
  useEffect(() => saveGenerationSelection(selection), [selection])
  const window = query.data?.window ?? generationWindow(selection)
  const apply = (next: GenerationSelection) => void navigate({ search: next, replace: true })
  return (
    <Page
      crumbs={[{ label: '概览' }]}
      description={`${formatAt(window.from)} — ${formatAt(window.to)} · 北京时间 · ${generationRefreshInterval(selection) ? '每 30 秒刷新' : '手动刷新'}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="生成时间范围"
            className="flex flex-wrap items-center rounded-md border p-0.5 text-xs"
          >
            {GENERATION_PRESETS.map((item) => (
              <Button
                key={item.value}
                size="sm"
                variant={selection.preset === item.value ? 'default' : 'ghost'}
                aria-pressed={selection.preset === item.value}
                onClick={() => apply({ preset: item.value })}
              >
                {item.label}
              </Button>
            ))}
            <Button
              size="sm"
              variant={selection.preset === 'custom' ? 'default' : 'ghost'}
              aria-pressed={selection.preset === 'custom'}
              onClick={() => apply({ preset: 'custom', ...window })}
            >
              自定义
            </Button>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw className={query.isFetching ? 'animate-spin' : undefined} />
            刷新
          </Button>
        </div>
      }
    >
      {selection.preset === 'custom' ? (
        <CustomRange key={`${selection.from}:${selection.to}`} window={selection} onApply={apply} />
      ) : null}
      {query.data ? (
        <>
          {query.isError ? (
            <p role="status" className="text-sm text-danger">
              任务刷新失败，下面是上次成功读取的记录。
            </p>
          ) : null}
          <GenerationUsers overview={query.data} />
          <OverviewActivity key={JSON.stringify(selection)} data={query.data.activity} />
        </>
      ) : query.isError ? (
        <ErrorState label="生成记录加载失败" error={query.error} />
      ) : (
        <PendingState label="正在读取生成用户" />
      )}
    </Page>
  )
}

function formatAt(at: number): string {
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
  window,
  onApply,
}: {
  window: TimeWindow
  onApply: (selection: GenerationSelection) => void
}) {
  const [start, setStart] = useState(beijingInput(window.from))
  const [end, setEnd] = useState(beijingInput(window.to))
  const [error, setError] = useState('')
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const next = parseTimeWindow({
          from: parseBeijingInput(start),
          to: parseBeijingInput(end, true),
        })
        if (!next) {
          setError('时间范围无效，最多 31 天')
          return
        }
        setError('')
        onApply({ preset: 'custom', ...next })
      }}
    >
      <DateTimePicker aria-label="开始时间" value={start} onChange={setStart} className="w-auto" />
      <span className="text-muted-foreground">—</span>
      <DateTimePicker aria-label="结束时间" value={end} onChange={setEnd} className="w-auto" />
      <Button type="submit" variant="outline" size="sm">
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

function actorSearch(actor: GenerationActor, window: TimeWindow) {
  return {
    ...window,
    ...(actor.kind === 'user'
      ? { userId: actor.id ?? undefined }
      : actor.kind === 'device'
        ? { deviceId: actor.id ?? undefined }
        : { unassigned: '1' as const }),
  }
}

function GenerationUsers({ overview }: { overview: GenerationUsersOverview }) {
  const { summary, window } = overview
  return (
    <>
      <section aria-label="生成概况" className="flex flex-wrap items-baseline gap-x-8 gap-y-3 px-1">
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
      </section>
      <Card className="min-w-0">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 p-4">
          <CardTitle className="text-sm">谁在生图</CardTitle>
          <Button variant="outline" size="sm" asChild>
            <Link to="/tasks" search={window}>
              全部任务 →
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {overview.actors.length ? (
            <Table className="min-w-[640px]">
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
                            ? `匿名设备 ${shortId(actor.id ?? '')}`
                            : actor.kind === 'user'
                              ? `用户 ${shortId(actor.id ?? '')}`
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
                      <Link
                        to="/tasks"
                        search={{ ...actorSearch(actor, window), status: 'in_progress' }}
                        className="hover:underline"
                      >
                        {actor.in_progress}
                      </Link>
                      {' / '}
                      <Link
                        to="/tasks"
                        search={{ ...actorSearch(actor, window), status: 'queued' }}
                        className="hover:underline"
                      >
                        {actor.queued}
                      </Link>
                      {actor.reconciling ? (
                        <Link
                          to="/tasks"
                          search={{ ...actorSearch(actor, window), status: 'reconciling' }}
                          className="ml-2 text-warning hover:underline"
                        >
                          {actor.reconciling} 待核查
                        </Link>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {formatAt(actor.last_submitted_at)}
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
              <EmptyState label="这个时间范围内没有生成任务" />
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
