import { createFileRoute } from '@tanstack/react-router'

import { Kpi } from '@/components/Kpi'
import { LazyTaskVolumeChart } from '@/components/LazyTaskVolumeChart'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { RangeToggle } from '@/components/RangeToggle'
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
import { parseOverviewSearch, RANGE_LABEL, type Range } from '@/lib/search-params'
import type { OverviewResult } from '@/lib/types'
import { useRangeSearch } from '@/lib/useRangeSearch'

export const Route = createFileRoute('/_authed/overview')({
  validateSearch: parseOverviewSearch,
  component: OverviewPage,
})

function formatDuration(value: number | null): string {
  if (value === null) return '—'
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
}

function OverviewPage() {
  const [range, setRange] = useRangeSearch()
  const query = useOverview(range)

  return (
    <Page crumbs={[{ label: '概览' }]} description="运行状态与任务趋势">
      {query.isPending ? (
        <PendingState label="正在汇总任务数据" />
      ) : query.isError ? (
        <ErrorState label="概览加载失败" error={query.error} />
      ) : (
        <OverviewContent data={query.data} range={range} onRangeChange={setRange} />
      )}
    </Page>
  )
}

function OverviewContent({
  data,
  range,
  onRangeChange,
}: {
  data: OverviewResult
  range: Range
  onRangeChange: (next: Range) => void
}) {
  const { summary, volume, volume_bucket, failures, models } = data
  const successPercent = Math.round(summary.success_rate * 1000) / 10
  const multiplier = summary.total === 0 ? null : summary.upstream_invocations / summary.total

  return (
    <>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5" aria-label="关键指标">
        <Kpi label={`任务总量 · ${RANGE_LABEL[range]}`} value={String(summary.total)} />
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
          <LazyTaskVolumeChart buckets={volume} bucketUnit={volume_bucket} label="系统任务量" />
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
              <div className="p-4">
                <EmptyState label="当前范围内无任务" />
              </div>
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
