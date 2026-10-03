import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { Kpi } from '@/components/Kpi'
import { AgentCacheCard } from '@/components/overview/AgentCacheCard'
import { AttentionList } from '@/components/overview/AttentionList'
import { HealthStrip } from '@/components/overview/HealthStrip'
import {
  LazyClientErrorTrendChart,
  LazyOverviewTrendChart,
} from '@/components/overview/LazyOverviewTrendChart'
import { Sparkline } from '@/components/overview/Sparkline'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { RangeToggle } from '@/components/RangeToggle'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { adminSessionQueryOptions } from '@/lib/admin-session'
import { elapsed } from '@/lib/format'
import {
  type AttentionItem,
  attentionItems,
  type Change,
  change,
  healthTiles,
  percent,
  type SourceState,
} from '@/lib/overview-signals'
import { PrivateAdminOverviewPanel } from '@/lib/private-overlay'
import { useClientErrors, useOps, useOverview } from '@/lib/queries'
import {
  DEFAULT_OPS_RANGE,
  parseOverviewSearch,
  RANGE_LABEL,
  type Range,
} from '@/lib/search-params'
import type { ClientErrorsResult, OpsSnapshot, OverviewResult } from '@/lib/types'
import { useRangeSearch } from '@/lib/useRangeSearch'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_authed/overview')({
  validateSearch: parseOverviewSearch,
  component: OverviewPage,
})

/**
 * 指挥台：一个首页回答「现在好不好」。所有业务数字同一个时间窗，并和紧挨着的上一个同长度窗口比；
 * 健康灯与「需要处理」复用运维看板与前端错误页的判断，点进去就是对应的详情页。
 */
function OverviewPage() {
  const [range, setRange] = useRangeSearch()
  const overview = useOverview(range)
  // 运维快照与前端错误各自取、各自失败：哪一块没到，就只有那几盏灯显示读取中。
  const ops = useOps(DEFAULT_OPS_RANGE, 60_000)
  const errors = useClientErrors(range)

  return (
    <Page
      crumbs={[{ label: '概览' }]}
      description={`所有数字统计近 ${RANGE_LABEL[range]}，并与上一个同长度时段对比`}
      actions={<RangeToggle value={range} onChange={setRange} />}
    >
      {overview.isPending ? (
        <PendingState label="正在汇总" />
      ) : overview.isError ? (
        <ErrorState label="概览加载失败" error={overview.error} />
      ) : (
        <CommandCenter
          overview={overview.data}
          ops={ops.data}
          errors={errors.data}
          opsState={sourceState(ops)}
          errorsState={sourceState(errors)}
          range={range}
        />
      )}
    </Page>
  )
}

/** 有数据就当到了：一次后台刷新失败不该把还能用的读数整块撤掉。 */
function sourceState(query: { data: unknown; isError: boolean }): SourceState {
  if (query.data !== undefined) return 'ready'
  return query.isError ? 'failed' : 'loading'
}

function CommandCenter({
  overview,
  ops,
  errors,
  opsState,
  errorsState,
  range,
}: {
  overview: OverviewResult
  ops: OpsSnapshot | undefined
  errors: ClientErrorsResult | undefined
  opsState: SourceState
  errorsState: SourceState
  range: Range
}) {
  const signals = { overview, ops, opsState, errors, errorsState }
  const tiles = healthTiles(signals)
  const items = attentionItems(signals)
  const pending = opsState === 'loading' || errorsState === 'loading'
  return (
    <>
      <HealthStrip tiles={tiles} range={range} />
      <PulseKpis overview={overview} />
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <TrendCard overview={overview} errors={errors} errorsState={errorsState} />
        <AttentionCard items={items} pending={pending} range={range} />
      </section>
      <section className="grid gap-4 xl:grid-cols-2">
        <ModelsCard overview={overview} />
        <FailuresCard overview={overview} />
      </section>
      <PrivateAdminOverviewPanel />
      <AgentCacheCard agent_cache={overview.agent_cache} range={range} />
    </>
  )
}

const SENTIMENT_CLASS: Record<Change['sentiment'], string> = {
  good: 'text-success',
  bad: 'text-danger',
  neutral: 'text-muted-foreground',
}

function PulseKpis({ overview }: { overview: OverviewResult }) {
  const { data: session } = useQuery(adminSessionQueryOptions)
  const { current, previous, series } = overview.pulse
  const kpis = [
    {
      label: '提交任务',
      now: current.tasks,
      before: previous.tasks,
      series: series.map((b) => b.tasks),
    },
    {
      label: '活跃用户',
      now: current.active,
      before: previous.active,
      series: series.map((b) => b.active),
      hint: '账号与匿名设备',
    },
    {
      label: '出图张数',
      now: current.images,
      before: previous.images,
      series: series.map((b) => b.images),
    },
    // 没开账号登录的部署没有注册这回事，换成 Agent 轮次。
    session?.accounts_login === false
      ? {
          label: 'Agent 轮次',
          now: current.agent_turns,
          before: previous.agent_turns,
          series: series.map((b) => b.agent_completed + b.agent_failed + b.agent_aborted),
        }
      : {
          label: '新注册',
          now: current.signups,
          before: previous.signups,
          series: series.map((b) => b.signups),
        },
  ]
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="业务指标">
      {kpis.map((kpi) => {
        const delta = change(kpi.now, kpi.before)
        return (
          <Card key={kpi.label}>
            <CardContent className="flex items-end justify-between gap-3 p-4">
              <div className="min-w-0 flex-1">
                <Kpi
                  variant="inline"
                  label={kpi.label}
                  value={kpi.now.toLocaleString('zh-CN')}
                  note={
                    <>
                      <span
                        className={cn('font-mono font-semibold', SENTIMENT_CLASS[delta.sentiment])}
                      >
                        {delta.text}
                      </span>{' '}
                      上期 {kpi.before.toLocaleString('zh-CN')}
                      {'hint' in kpi && kpi.hint ? ` · ${kpi.hint}` : ''}
                    </>
                  }
                />
              </div>
              <Sparkline values={kpi.series} className={SENTIMENT_CLASS[delta.sentiment]} />
            </CardContent>
          </Card>
        )
      })}
    </section>
  )
}

type TrendTab = 'tasks' | 'agent' | 'errors'
const TREND_OPTIONS: ReadonlyArray<{ value: TrendTab; label: string }> = [
  { value: 'tasks', label: '生成任务' },
  { value: 'agent', label: 'Agent 轮次' },
  { value: 'errors', label: '前端错误' },
]

function TrendCard({
  overview,
  errors,
  errorsState,
}: {
  overview: OverviewResult
  errors: ClientErrorsResult | undefined
  errorsState: SourceState
}) {
  const [tab, setTab] = useState<TrendTab>('tasks')
  const { summary } = overview
  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 p-4">
        <CardTitle className="text-sm">趋势</CardTitle>
        <SegmentedControl options={TREND_OPTIONS} value={tab} onChange={setTab} label="趋势口径" />
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {tab === 'errors' ? (
          errors ? (
            <LazyClientErrorTrendChart buckets={errors.trend} bucketUnit={errors.bucket_unit} />
          ) : errorsState === 'failed' ? (
            <p className="flex h-52 items-center justify-center text-sm text-muted-foreground">
              前端错误没有读到，稍后点侧栏「刷新」重试
            </p>
          ) : (
            <PendingState label="正在读取前端错误" className="h-52" />
          )
        ) : (
          <LazyOverviewTrendChart
            metric={tab}
            overview={overview}
            bucketUnit={overview.volume_bucket}
          />
        )}
        {tab === 'tasks' ? (
          <div className="grid grid-cols-3 gap-4 border-t pt-3">
            <Kpi
              variant="inline"
              label="成功率"
              value={percent(summary.success_rate)}
              note={`${summary.completed} 成功 · ${summary.failed} 失败`}
            />
            <Kpi
              variant="inline"
              label="排队 P50"
              value={summary.queue_p50_ms === null ? '—' : elapsed(summary.queue_p50_ms)}
              note="提交到开始执行"
            />
            <Kpi
              variant="inline"
              label="生成 P50 / P95"
              value={
                summary.p50_duration_ms === null
                  ? '—'
                  : `${elapsed(summary.p50_duration_ms)} / ${elapsed(summary.p95_duration_ms ?? 0)}`
              }
              note="开始执行到完成"
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function AttentionCard({
  items,
  pending,
  range,
}: {
  items: readonly AttentionItem[]
  pending: boolean
  range: Range
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 p-4">
        <CardTitle className="text-sm">需要处理</CardTitle>
        <span className="text-xs text-muted-foreground">
          {items.length ? `${items.length} 项 · 运维、生成、前端` : '运维、生成、前端'}
        </span>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <AttentionList items={items} pending={pending} range={range} />
      </CardContent>
    </Card>
  )
}

function ModelsCard({ overview }: { overview: OverviewResult }) {
  const { models } = overview
  return (
    <Card className="min-w-0">
      <CardHeader className="p-4">
        <CardTitle className="text-sm">模型</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {models.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">模型</TableHead>
                <TableHead className="text-right">任务</TableHead>
                <TableHead className="w-[30%]">成功率</TableHead>
                <TableHead className="text-right">排队 P50</TableHead>
                <TableHead className="text-right">生成 P95</TableHead>
                <TableHead className="pr-4 text-right">倍率</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => {
                const terminal = model.completed + model.failed
                const rate = terminal > 0 ? model.completed / terminal : null
                return (
                  <TableRow key={model.model}>
                    <TableCell className="max-w-[200px] truncate pl-4 font-mono text-xs">
                      {model.model}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {model.count.toLocaleString('zh-CN')}
                    </TableCell>
                    <TableCell>
                      <RateBar rate={rate} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {model.queue_p50_ms === null ? '—' : elapsed(model.queue_p50_ms)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {model.run_p95_ms === null ? '—' : elapsed(model.run_p95_ms)}
                    </TableCell>
                    <TableCell className="pr-4 text-right font-mono tabular-nums">
                      {model.average_multiplier === null
                        ? '—'
                        : model.average_multiplier.toFixed(2)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : (
          <div className="p-4">
            <EmptyState label="当前范围内无任务" />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** 成功率条：低于 90% 标红，一眼看出哪个模型拖后腿。 */
function RateBar({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-xs text-muted-foreground">—</span>
  const low = rate < 0.9
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full', low ? 'bg-danger' : 'bg-success')}
          style={{ width: `${Math.max(2, rate * 100)}%` }}
        />
      </div>
      <span className={cn('w-12 text-right font-mono text-xs tabular-nums', low && 'text-danger')}>
        {percent(rate)}
      </span>
    </div>
  )
}

function FailuresCard({ overview }: { overview: OverviewResult }) {
  const { failures, summary } = overview
  const total = failures.reduce((sum, failure) => sum + failure.count, 0)
  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 p-4">
        <CardTitle className="text-sm">失败原因</CardTitle>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          共 {summary.failed}
        </span>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {failures.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">原因</TableHead>
                <TableHead className="w-[34%]">占比</TableHead>
                <TableHead className="text-right">次数</TableHead>
                <TableHead className="pr-4 text-right">较上期</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failures.map((failure) => {
                const diff = failure.count - failure.previous_count
                return (
                  <TableRow key={failure.error_type}>
                    <TableCell className="max-w-[200px] truncate pl-4 font-mono text-xs">
                      {failure.error_type}
                    </TableCell>
                    <TableCell>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-danger/80"
                          style={{ width: `${total ? (failure.count / total) * 100 : 0}%` }}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {failure.count}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'pr-4 text-right font-mono text-xs tabular-nums',
                        diff > 0
                          ? 'text-danger'
                          : diff < 0
                            ? 'text-success'
                            : 'text-muted-foreground',
                      )}
                    >
                      {diff === 0 ? '持平' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)}`}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="p-10 text-center text-sm text-muted-foreground">当前范围内没有失败任务</p>
        )}
      </CardContent>
    </Card>
  )
}
