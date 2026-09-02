import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'

import { PageHeader } from '@/components/PageHeader'
import { RANGE_LABEL, RangeToggle } from '@/components/RangeToggle'
import { TaskVolumeChart } from '@/components/TaskVolumeChart'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PrivateAdminOverviewPanel } from '@/lib/private-overlay'
import { useOverview } from '@/lib/queries'
import { parseOverviewSearch, type Range } from '@/lib/search-params'

export const Route = createFileRoute('/_authed/overview')({
  validateSearch: parseOverviewSearch,
  component: OverviewPage,
})

function formatDuration(value: number | null): string {
  if (value === null) return '—'
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </p>
        <p className="mt-3 font-mono text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  )
}

function OverviewPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const range = search.range ?? '7d'
  const query = useOverview(range)

  function setRange(next: Range): void {
    void navigate({
      to: '.',
      search: (previous) => ({ ...previous, range: next }),
      replace: true,
    })
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: '概览' }]}
        title="概览"
        description="运行状态与任务趋势"
        actions={
          <span className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]" />
            数据库在线
          </span>
        }
      />

      <div className="flex-1 space-y-4 px-4 py-5 md:px-6">
        {query.isPending ? (
          <div className="flex h-48 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在汇总任务数据
          </div>
        ) : query.isError ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
            概览加载失败：{(query.error as Error).message}
          </div>
        ) : (
          <OverviewContent data={query.data} range={range} onRangeChange={setRange} />
        )}
      </div>
    </>
  )
}

function OverviewContent({
  data,
  range,
  onRangeChange,
}: {
  data: NonNullable<ReturnType<typeof useOverview>['data']>
  range: Range
  onRangeChange: (next: Range) => void
}) {
  const { summary, volume, failures, models } = data
  const successPercent = Math.round(summary.success_rate * 1000) / 10
  const multiplier = summary.total === 0 ? null : summary.upstream_invocations / summary.total

  return (
    <>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5" aria-label="关键指标">
        <Kpi
          label={`任务总量 · ${RANGE_LABEL[range]}`}
          value={String(summary.total)}
          note={`${volume.length} 个时间桶`}
        />
        <Kpi
          label="上游调用"
          value={String(summary.upstream_invocations)}
          note={multiplier === null ? '暂无任务' : `平均 ${multiplier.toFixed(2)} 次 / 任务`}
        />
        <Kpi
          label="成功率"
          value={`${successPercent}%`}
          note={`${summary.completed} 成功 · ${summary.failed} 失败`}
        />
        <Kpi
          label="中位耗时 P50"
          value={formatDuration(summary.p50_duration_ms)}
          note="上游处理耗时中位数"
        />
        <Kpi
          label="慢请求 P95"
          value={formatDuration(summary.p95_duration_ms)}
          note="上游处理耗时 95 分位"
        />
      </section>

      <PrivateAdminOverviewPanel />

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 p-4">
          <CardTitle className="text-sm">任务脉冲</CardTitle>
          <RangeToggle value={range} onChange={onRangeChange} />
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <TaskVolumeChart
            buckets={volume}
            label="系统任务量"
            bucketUnit={range === '1d' ? 'hour' : 'day'}
          />
        </CardContent>
      </Card>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">模型用量</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {models.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">模型</TableHead>
                    <TableHead className="text-right">任务</TableHead>
                    <TableHead className="text-right">上游调用</TableHead>
                    <TableHead className="pr-4 text-right">倍率</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {models.map((model) => (
                    <TableRow key={model.model}>
                      <TableCell className="max-w-[220px] truncate pl-4 font-mono text-xs">
                        {model.model}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {model.count}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {model.upstream_invocations}
                      </TableCell>
                      <TableCell className="pr-4 text-right font-mono tabular-nums">
                        {model.average_multiplier === null
                          ? '—'
                          : model.average_multiplier.toFixed(2)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="p-10 text-center text-sm text-muted-foreground">当前范围内无任务</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 p-4">
            <CardTitle className="text-sm">失败分布</CardTitle>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {summary.failed}
            </span>
          </CardHeader>
          <CardContent className="p-0">
            {failures.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">错误类型</TableHead>
                    <TableHead className="pr-4 text-right">次数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {failures.map((failure) => (
                    <TableRow key={failure.error_type}>
                      <TableCell className="pl-4 font-mono text-xs">{failure.error_type}</TableCell>
                      <TableCell className="pr-4 text-right font-mono tabular-nums">
                        {failure.count}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="p-10 text-center text-sm text-muted-foreground">
                当前范围内没有失败任务
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    </>
  )
}
