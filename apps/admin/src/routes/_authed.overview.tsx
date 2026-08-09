import { createFileRoute } from '@tanstack/react-router'
import { Activity, CircleCheck, Clock3, Loader2, TriangleAlert } from 'lucide-react'

import { TaskVolumeChart } from '@/components/TaskVolumeChart'
import { PrivateAdminOverviewPanel } from '@/lib/private-overlay'
import { useOverview } from '@/lib/queries'
import { parseOverviewSearch } from '@/lib/search-params'

export const Route = createFileRoute('/_authed/overview')({
  validateSearch: parseOverviewSearch,
  component: OverviewPage,
})

function formatDuration(value: number | null): string {
  if (value === null) return '—'
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
}

function Metric({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string
  value: string
  note: string
  icon: typeof Activity
}) {
  return (
    <article className="group relative overflow-hidden rounded-lg border bg-card p-4 shadow-sm transition-colors hover:border-foreground/20">
      <div className="absolute right-0 top-0 h-16 w-16 translate-x-5 -translate-y-5 rounded-full bg-primary/[0.04]" />
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
        <Icon className="h-4 w-4 text-foreground/60" />
      </div>
      <div className="mt-5 font-mono text-3xl font-semibold tabular-nums tracking-tight">
        {value}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{note}</p>
    </article>
  )
}

function OverviewPage() {
  const search = Route.useSearch()
  const range = search.range ?? '7d'
  const query = useOverview(range)

  if (query.isPending) {
    return (
      <div className="flex h-48 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在汇总任务数据
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
        概览加载失败：{(query.error as Error).message}
      </div>
    )
  }

  const { summary, volume, failures, models } = query.data
  const successPercent = Math.round(summary.success_rate * 1000) / 10
  const topModelCount = models[0]?.count ?? 0

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b pb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            System pulse / {range}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">运行概览</h1>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]" />
          数据库在线
        </span>
      </div>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="关键指标">
        <Metric
          label="任务总量"
          value={String(summary.total)}
          note="当前时间窗提交"
          icon={Activity}
        />
        <Metric
          label="成功率"
          value={`${successPercent}%`}
          note={`${summary.completed} 成功 / ${summary.failed} 失败`}
          icon={CircleCheck}
        />
        <Metric
          label="中位耗时"
          value={formatDuration(summary.p50_duration_ms)}
          note="P50 上游处理耗时"
          icon={Clock3}
        />
        <Metric
          label="慢请求"
          value={formatDuration(summary.p95_duration_ms)}
          note="P95 上游处理耗时"
          icon={TriangleAlert}
        />
      </section>

      <PrivateAdminOverviewPanel />

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(280px,1fr)]">
        <div className="rounded-xl border bg-card/40 p-4">
          <div className="mb-4 flex items-baseline justify-between">
            <div>
              <h2 className="text-sm font-semibold">任务脉冲</h2>
              <p className="mt-1 text-xs text-muted-foreground">成功与失败随时间变化</p>
            </div>
            <span className="font-mono text-xs text-muted-foreground">{volume.length} buckets</span>
          </div>
          <TaskVolumeChart buckets={volume} label="系统任务量" />
        </div>

        <div className="rounded-xl border bg-card/40 p-4">
          <h2 className="text-sm font-semibold">模型用量</h2>
          <p className="mt-1 text-xs text-muted-foreground">成本结构的第一层信号</p>
          <div className="mt-5 space-y-4">
            {models.length ? (
              models.map((model) => (
                <div key={model.model}>
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate font-mono">{model.model}</span>
                    <span className="tabular-nums text-muted-foreground">{model.count}</span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-foreground/70"
                      style={{
                        width: `${topModelCount ? (model.count / topModelCount) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">当前范围内无任务</p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-xl border bg-card/40 p-4">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-sm font-semibold">失败分布</h2>
            <p className="mt-1 text-xs text-muted-foreground">先处理数量最多的失败类型</p>
          </div>
          <span className="font-mono text-xs text-muted-foreground">{summary.failed} failed</span>
        </div>
        {failures.length ? (
          <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {failures.map((failure) => (
              <div
                key={failure.error_type}
                className="flex items-center justify-between rounded-md border border-rose-500/15 bg-rose-500/[0.035] px-3 py-2"
              >
                <code className="text-xs">{failure.error_type}</code>
                <span className="font-mono text-sm font-semibold tabular-nums">
                  {failure.count}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-4 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            当前范围内没有失败任务
          </p>
        )}
      </section>
    </div>
  )
}
