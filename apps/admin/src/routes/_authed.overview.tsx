import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowDownRight, ArrowUpRight, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { type FilterPreset, presetWindow } from '@/components/FilterBar'
import { AgentCacheCard } from '@/components/overview/AgentCacheCard'
import { AttentionList } from '@/components/overview/AttentionList'
import { HealthStrip } from '@/components/overview/HealthStrip'
import { LazyOverviewTrendChart } from '@/components/overview/LazyOverviewTrendChart'
import { Sparkline } from '@/components/overview/Sparkline'
import { ErrorState, Page, PendingState } from '@/components/Page'
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
import { attentionItems, change, healthTiles, percent } from '@/lib/overview-signals'
import { useClientErrors, useOps, useOverview } from '@/lib/queries'
import { parseDashboardSearch, type Range } from '@/lib/search-params'
import { cn } from '@/lib/utils'
import { todayWindow } from '../../contracts'

export const Route = createFileRoute('/_authed/overview')({
  validateSearch: parseDashboardSearch,
  component: OverviewPage,
  errorComponent: ({ error }) => (
    <Page crumbs={[{ label: '概览' }]}>
      <ErrorState label="概览范围无效" error={error} />
    </Page>
  ),
})

function signalRange(preset: FilterPreset, from?: number, to?: number): Range {
  if (preset === 'today') return '1d'
  if (preset === '30d') return '30d'
  if (preset === '7d' || preset === 'all') return '7d'
  const span = (to ?? 0) - (from ?? 0)
  if (span <= 86_400_000) return '1d'
  return span <= 7 * 86_400_000 ? '7d' : '30d'
}

function OverviewPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [clock, setClock] = useState(() => Date.now())
  const preset = search.preset ?? '7d'
  const compare = search.compare !== '0'
  const window =
    preset === 'custom' && search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : preset === 'today'
        ? todayWindow(clock)
        : preset === '30d'
          ? presetWindow('30d', clock)
          : preset === '7d'
            ? presetWindow('7d', clock)
            : undefined
  const range = signalRange(preset, window?.from, window?.to)
  const custom = preset === 'today' || preset === 'custom' ? window : undefined
  const overview = useOverview(range, custom)
  const ops = useOps('24h', 5 * 60_000)
  const errors = useClientErrors(range)
  const data = overview.data
  const tiles = data
    ? healthTiles({
        overview: data,
        ops: ops.data,
        opsState: ops.isError ? 'failed' : ops.data ? 'ready' : 'loading',
        errors: errors.data,
        errorsState: errors.isError ? 'failed' : errors.data ? 'ready' : 'loading',
      })
    : []
  const attention = data
    ? attentionItems({
        overview: data,
        ops: ops.data,
        opsState: ops.isError ? 'failed' : ops.data ? 'ready' : 'loading',
        errors: errors.data,
        errorsState: errors.isError ? 'failed' : errors.data ? 'ready' : 'loading',
      })
    : []
  return (
    <Page
      crumbs={[{ label: '概览' }]}
      description={
        window
          ? `${formatAt(window.from)} — ${formatAt(window.to)} · 北京时间 · 数据每 5 分钟更新`
          : '数据每 5 分钟更新'
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-8 items-center rounded-md border p-0.5 text-xs">
            {(['today', '7d', '30d', 'custom'] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={cn(
                  'h-7 rounded px-2.5',
                  preset === item ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
                )}
                onClick={() => {
                  if (item === 'custom') {
                    const seed = window ?? presetWindow('7d')
                    void navigate({
                      search: {
                        preset: 'custom',
                        from: seed.from,
                        to: seed.to,
                        compare: search.compare,
                      },
                      replace: true,
                    })
                    return
                  }
                  void navigate({
                    search: { preset: item, compare: search.compare },
                    replace: true,
                  })
                }}
              >
                {item === 'today'
                  ? '今天'
                  : item === '7d'
                    ? '7 天'
                    : item === '30d'
                      ? '30 天'
                      : '自定义'}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigate({
                search: {
                  ...search,
                  compare: compare ? '0' : undefined,
                },
                replace: true,
              })
            }
          >
            {compare ? '对比：上一周期' : '不对比'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={overview.isFetching}
            onClick={() => {
              setClock(Date.now())
              void overview.refetch()
            }}
          >
            <RefreshCw className={overview.isFetching ? 'animate-spin' : undefined} />
            刷新
          </Button>
        </div>
      }
    >
      {data ? (
        <div className="space-y-4">
          <HealthStrip tiles={tiles} range={range} />
          <KpiRow overview={data} compare={compare} />
          <section className="grid gap-4 xl:grid-cols-5">
            <Card className="xl:col-span-3">
              <CardHeader className="flex-row items-center justify-between space-y-0 p-4">
                <CardTitle className="text-sm">生成任务</CardTitle>
                <span className="text-xs text-muted-foreground">成功 · 失败 · 失败率</span>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <LazyOverviewTrendChart
                  metric="tasks"
                  overview={data}
                  bucketUnit={data.volume_bucket}
                />
              </CardContent>
            </Card>
            <Card className="xl:col-span-2">
              <CardHeader className="p-4">
                <CardTitle className="text-sm">Agent 轮次</CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <LazyOverviewTrendChart
                  metric="agent"
                  overview={data}
                  bucketUnit={data.volume_bucket}
                />
              </CardContent>
            </Card>
          </section>
          <section className="grid items-start gap-4 xl:grid-cols-5">
            <ModelTable overview={data} window={window} />
            <Card className="xl:col-span-2">
              <CardHeader className="p-4">
                <CardTitle className="text-sm">需要关注</CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <AttentionList
                  items={attention}
                  pending={ops.isPending || errors.isPending}
                  range={range}
                  taskWindow={window}
                />
              </CardContent>
            </Card>
          </section>
          <AgentCacheCard agent_cache={data.agent_cache} range={range} />
        </div>
      ) : overview.isError ? (
        <ErrorState label="概览加载失败" error={overview.error} />
      ) : (
        <PendingState label="正在读取概览" />
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

function KpiRow({
  overview,
  compare,
}: {
  overview: NonNullable<ReturnType<typeof useOverview>['data']>
  compare: boolean
}) {
  const current = overview.pulse.current
  const previous = overview.pulse.previous
  const failRate = (row: typeof current) => {
    const terminal = row.completed + row.failed
    return terminal ? row.failed / terminal : 0
  }
  const cards = [
    {
      label: '生成任务',
      value: current.tasks.toLocaleString('zh-CN'),
      delta: change(current.tasks, previous.tasks, true),
      series: overview.pulse.series.map((bucket) => bucket.tasks),
    },
    {
      label: '失败率',
      value: percent(failRate(current)),
      delta: change(failRate(current), failRate(previous), false),
      series: overview.volume.map((bucket) => {
        const terminal = bucket.completed + bucket.failed
        return terminal ? bucket.failed / terminal : 0
      }),
    },
    {
      label: '活跃用户',
      value: current.active.toLocaleString('zh-CN'),
      delta: change(current.active, previous.active, true),
      series: overview.pulse.series.map((bucket) => bucket.active),
    },
    {
      label: '新注册',
      value: current.signups.toLocaleString('zh-CN'),
      delta: change(current.signups, previous.signups, true),
      series: overview.pulse.series.map((bucket) => bucket.signups),
    },
  ]
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="概览指标">
      {cards.map((card) => (
        <Card key={card.label} className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground">{card.label}</p>
              <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{card.value}</p>
              {compare ? (
                <p
                  className={cn(
                    'mt-1 inline-flex items-center gap-1 text-xs',
                    card.delta.sentiment === 'good' && 'text-success',
                    card.delta.sentiment === 'bad' && 'text-danger',
                    card.delta.sentiment === 'neutral' && 'text-muted-foreground',
                  )}
                >
                  {card.delta.sentiment === 'good' ? (
                    <ArrowUpRight className="size-3" />
                  ) : card.delta.sentiment === 'bad' ? (
                    <ArrowDownRight className="size-3" />
                  ) : null}
                  {card.delta.text}
                  <span className="text-muted-foreground">较上一周期</span>
                </p>
              ) : null}
            </div>
            <Sparkline values={card.series} className="text-muted-foreground" />
          </div>
        </Card>
      ))}
    </section>
  )
}

function ModelTable({
  overview,
  window,
}: {
  overview: NonNullable<ReturnType<typeof useOverview>['data']>
  window?: { from: number; to: number }
}) {
  return (
    <Card className="min-w-0 xl:col-span-3">
      <CardHeader className="p-4">
        <CardTitle className="text-sm">按模型</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">模型</TableHead>
              <TableHead className="text-right">任务</TableHead>
              <TableHead className="text-right">失败率</TableHead>
              <TableHead className="pr-4 text-right">p95 耗时</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview.models.length ? (
              overview.models.map((model) => {
                const terminal = model.completed + model.failed
                const rate = terminal ? model.failed / terminal : null
                return (
                  <TableRow key={model.model}>
                    <TableCell className="max-w-64 truncate pl-4 font-mono text-xs">
                      <Link
                        to="/tasks"
                        search={{
                          status: 'failed',
                          model: model.model,
                          ...(window ?? {}),
                        }}
                        className="hover:underline"
                      >
                        {model.model}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {model.count}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-mono tabular-nums',
                        rate !== null && rate >= 0.1 && 'text-danger',
                      )}
                    >
                      {percent(rate)}
                    </TableCell>
                    <TableCell className="pr-4 text-right font-mono text-xs tabular-nums">
                      {model.run_p95_ms === null ? '—' : `${(model.run_p95_ms / 1000).toFixed(1)}s`}
                    </TableCell>
                  </TableRow>
                )
              })
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                  这个时间范围里没有生成任务
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
