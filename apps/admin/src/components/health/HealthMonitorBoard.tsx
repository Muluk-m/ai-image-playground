import { AlertTriangle, ChevronUp, CircleCheck, MinusCircle, XCircle } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { Kpi } from '@/components/Kpi'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { HEALTH_RANGE_META } from '@/lib/search-params'
import type {
  HealthBucket,
  HealthComponent,
  HealthGroup,
  HealthMonitorSnapshot,
  HealthRange,
  HealthStatus,
} from '@/lib/types'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<HealthStatus, string> = {
  healthy: '正常',
  degraded: '降级',
  outage: '异常',
  idle: '无流量',
}

const OVERALL_LABEL: Record<HealthStatus, string> = {
  healthy: '全部组件运行正常',
  degraded: '部分组件存在波动或延迟升高',
  outage: '检测到组件可用率异常',
  idle: '当前窗口暂无活跃样本',
}

const PILL_BG: Record<HealthStatus, string> = {
  healthy: 'bg-success',
  degraded: 'bg-warning',
  outage: 'bg-danger',
  idle: 'bg-muted-foreground/20',
}

const STATUS_TONE: Record<HealthStatus, 'default' | 'success' | 'warning' | 'danger'> = {
  healthy: 'success',
  degraded: 'warning',
  outage: 'danger',
  idle: 'default',
}

/** 浮层展开所需顶部净空（吸顶页头 ~110px + 浮层最大高度 ~190px）。 */
const POPOVER_FLIP_TOP_THRESHOLD_PX = 310

export function formatAvailability(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—'
  const pct = ratio * 100
  if (pct >= 99.995) return '100%'
  return `${pct.toFixed(2)}%`
}

export function formatLatencyMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatBucketWindow(startAt: number, endAt: number, range: HealthRange): string {
  const s = new Date(startAt)
  const e = new Date(endAt)
  const sDate = `${pad2(s.getMonth() + 1)}/${pad2(s.getDate())}`
  const eDate = `${pad2(e.getMonth() + 1)}/${pad2(e.getDate())}`
  const sTime = `${pad2(s.getHours())}:${pad2(s.getMinutes())}`
  const eTime = `${pad2(e.getHours())}:${pad2(e.getMinutes())}`
  if (range === '7d' && sDate !== eDate) {
    return `${sDate} ${sTime} - ${eDate} ${eTime}`
  }
  return `${sDate} ${sTime} - ${eTime}`
}

function StatusIcon({ status, className }: { status: HealthStatus; className?: string }) {
  if (status === 'healthy') {
    return (
      <CircleCheck className={cn('size-4 shrink-0 text-success', className)} aria-hidden="true" />
    )
  }
  if (status === 'degraded') {
    return (
      <AlertTriangle className={cn('size-4 shrink-0 text-warning', className)} aria-hidden="true" />
    )
  }
  if (status === 'outage') {
    return <XCircle className={cn('size-4 shrink-0 text-danger', className)} aria-hidden="true" />
  }
  return (
    <MinusCircle
      className={cn('size-4 shrink-0 text-muted-foreground/70', className)}
      aria-hidden="true"
    />
  )
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium tabular-nums">{value}</span>
    </div>
  )
}

function BucketPopover({
  id,
  component,
  bucket,
  range,
  anchorPercent,
  placement,
}: {
  id: string
  component: HealthComponent
  bucket: HealthBucket
  range: HealthRange
  anchorPercent: number
  placement: 'top' | 'bottom'
}) {
  return (
    <div
      id={id}
      role="tooltip"
      className={cn(
        'pointer-events-none absolute z-20 w-64 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg',
        placement === 'top' ? 'bottom-[calc(100%+10px)]' : 'top-[calc(100%+10px)]',
      )}
      style={{
        left: `clamp(8rem, ${anchorPercent}%, calc(100% - 8rem))`,
      }}
    >
      <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatBucketWindow(bucket.start_at, bucket.end_at, range)}
      </p>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <StatusIcon status={bucket.status} className="size-3.5" />
          {STATUS_LABEL[bucket.status]}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {bucket.total > 0 ? `成功率 ${formatAvailability(bucket.success_rate)}` : '无样本'}
        </span>
      </div>

      {bucket.total > 0 || (bucket.policy_blocked ?? 0) > 0 ? (
        <div className="mt-2.5 space-y-1 text-xs">
          {component.kind === 'agent' ? (
            <>
              <MetricRow label="首 Token 中位数" value={formatLatencyMs(bucket.ttft_p50_ms)} />
              {bucket.ttft_p95_ms != null ? (
                <MetricRow label="首 Token P95" value={formatLatencyMs(bucket.ttft_p95_ms)} />
              ) : null}
              <MetricRow label="总耗时中位数" value={formatLatencyMs(bucket.duration_p50_ms)} />
              <MetricRow label="调用成功 / 总计" value={`${bucket.succeeded} / ${bucket.total}`} />
            </>
          ) : component.kind === 'generation' ? (
            <>
              <MetricRow label="生成耗时中位数" value={formatLatencyMs(bucket.duration_p50_ms)} />
              {bucket.duration_p95_ms != null ? (
                <MetricRow label="生成耗时 P95" value={formatLatencyMs(bucket.duration_p95_ms)} />
              ) : null}
              <MetricRow label="排队等待中位数" value={formatLatencyMs(bucket.queue_wait_p50_ms)} />
              <MetricRow label="任务成功 / 总计" value={`${bucket.succeeded} / ${bucket.total}`} />
              {bucket.policy_blocked ? (
                <MetricRow label="内容策略拒图" value={`${bucket.policy_blocked} 次`} />
              ) : null}
            </>
          ) : (
            <>
              <MetricRow label="分钟 P50 中位数" value={formatLatencyMs(bucket.duration_p50_ms)} />
              <MetricRow label="分钟 P95 峰值" value={formatLatencyMs(bucket.duration_p95_ms)} />
              <MetricRow
                label="请求 / 5xx"
                value={`${bucket.total.toLocaleString('zh-CN')} / ${bucket.failed}`}
              />
            </>
          )}
        </div>
      ) : null}

      <div className="mt-2.5 truncate border-t pt-2 text-[11px] text-muted-foreground">
        {component.name}
        {component.badge ? ` · ${component.badge}` : ''}
      </div>
    </div>
  )
}

function ComponentLatencySummary({ component }: { component: HealthComponent }) {
  if (component.kind === 'agent') {
    return (
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        TTFT {formatLatencyMs(component.ttft_p50_ms)} · 总耗时{' '}
        {formatLatencyMs(component.duration_p50_ms)}
      </span>
    )
  }
  if (component.kind === 'generation') {
    return (
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        耗时 P50 {formatLatencyMs(component.duration_p50_ms)}
        {component.queue_wait_p50_ms != null && component.queue_wait_p50_ms >= 500
          ? ` · 排队 ${formatLatencyMs(component.queue_wait_p50_ms)}`
          : ''}
      </span>
    )
  }
  return (
    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
      分钟 P50 {formatLatencyMs(component.duration_p50_ms)} · 分钟 P95 峰值{' '}
      {formatLatencyMs(component.duration_p95_ms)}
    </span>
  )
}

function HealthComponentRow({
  component,
  range,
}: {
  component: HealthComponent
  range: HealthRange
}) {
  const tooltipId = useId()
  const stripRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])
  // 按桶身份 start_at 追踪选中与焦点，轮询跨桶推进时固定浮层仍锁定同一时间段；移出窗口或切时间范围时自动收起。
  const [activeStartAt, setActiveStartAt] = useState<number | null>(null)
  const [pinned, setPinned] = useState(false)
  const [focusStartAt, setFocusStartAt] = useState<number | null>(
    () => component.buckets[component.buckets.length - 1]?.start_at ?? null,
  )
  const [placement, setPlacement] = useState<'top' | 'bottom'>('top')

  useEffect(() => {
    void range
    setActiveStartAt(null)
    setPinned(false)
  }, [range])

  const totalBuckets = component.buckets.length
  const activeIndex =
    activeStartAt === null
      ? -1
      : component.buckets.findIndex((bucket) => bucket.start_at === activeStartAt)
  const focusFound =
    focusStartAt === null
      ? -1
      : component.buckets.findIndex((bucket) => bucket.start_at === focusStartAt)
  const safeFocusIndex = focusFound >= 0 ? focusFound : Math.max(0, totalBuckets - 1)
  const activeBucket = activeIndex >= 0 ? (component.buckets[activeIndex] ?? null) : null
  const anchorPercent =
    activeIndex >= 0 && totalBuckets > 0 ? ((activeIndex + 0.5) / totalBuckets) * 100 : 50

  // 固定查看的桶滚出当前时间窗口时自动清理固定态。
  useEffect(() => {
    if (activeStartAt !== null && activeIndex === -1) {
      setActiveStartAt(null)
      setPinned(false)
    }
  }, [activeStartAt, activeIndex])

  const measurePlacement = () => {
    const rect = stripRef.current?.getBoundingClientRect()
    if (!rect || rect.height === 0) {
      setPlacement('top')
      return
    }
    setPlacement(rect.top < POPOVER_FLIP_TOP_THRESHOLD_PX ? 'bottom' : 'top')
  }

  const activate = (idx: number, pin = false) => {
    const bucket = component.buckets[idx]
    if (!bucket) return
    measurePlacement()
    setActiveStartAt(bucket.start_at)
    setFocusStartAt(bucket.start_at)
    if (pin) setPinned(true)
  }

  const dismiss = () => {
    setActiveStartAt(null)
    setPinned(false)
  }

  useEffect(() => {
    if (activeIndex < 0) return
    const onPointerDown = (event: PointerEvent) => {
      if (
        stripRef.current &&
        event.target instanceof Node &&
        !stripRef.current.contains(event.target)
      ) {
        setActiveStartAt(null)
        setPinned(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [activeIndex])

  const onPillKeyDown = (event: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      dismiss()
      return
    }
    let next: number | null = null
    if (event.key === 'ArrowRight') next = Math.min(totalBuckets - 1, idx + 1)
    else if (event.key === 'ArrowLeft') next = Math.max(0, idx - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = totalBuckets - 1
    if (next !== null && next !== idx) {
      event.preventDefault()
      activate(next, pinned)
      buttonRefs.current[next]?.focus()
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusIcon status={component.status} />
          <span className="truncate font-mono text-sm font-medium">{component.name}</span>
          {component.badge ? (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {component.badge}
            </span>
          ) : null}
          <ComponentLatencySummary component={component} />
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground">
          <span>{component.total.toLocaleString('zh-CN')} 次</span>
          <span className="font-medium text-foreground">
            {component.availability !== null
              ? `${formatAvailability(component.availability)} 可用率`
              : '暂无样本'}
          </span>
        </div>
      </div>

      <div
        ref={stripRef}
        className="relative"
        onMouseLeave={() => {
          if (!pinned) setActiveStartAt(null)
        }}
      >
        {activeBucket ? (
          <BucketPopover
            id={tooltipId}
            component={component}
            bucket={activeBucket}
            range={range}
            anchorPercent={anchorPercent}
            placement={placement}
          />
        ) : null}
        <div
          role="group"
          aria-label={`${component.name} 健康状态时间线`}
          className="flex h-7 w-full items-stretch gap-[2px] sm:gap-[3px]"
        >
          {component.buckets.map((bucket, idx) => {
            const selected = activeIndex === idx
            return (
              <button
                key={bucket.start_at}
                ref={(el) => {
                  buttonRefs.current[idx] = el
                }}
                type="button"
                tabIndex={idx === safeFocusIndex ? 0 : -1}
                aria-label={`${component.name} ${formatBucketWindow(bucket.start_at, bucket.end_at, range)} ${STATUS_LABEL[bucket.status]} ${bucket.total > 0 ? `成功率 ${formatAvailability(bucket.success_rate)}` : '无样本'}`}
                aria-describedby={selected ? tooltipId : undefined}
                onMouseEnter={() => {
                  if (!pinned) activate(idx)
                }}
                onClick={() => {
                  if (pinned && activeIndex === idx) dismiss()
                  else activate(idx, true)
                }}
                onFocus={() => activate(idx)}
                onBlur={() => {
                  if (!pinned) setActiveStartAt((prev) => (prev === bucket.start_at ? null : prev))
                }}
                onKeyDown={(event) => onPillKeyDown(event, idx)}
                className={cn(
                  'min-w-0 flex-1 rounded-[3px] transition-transform duration-100 motion-reduce:transition-none focus-visible:outline-none',
                  PILL_BG[bucket.status],
                  selected &&
                    'z-10 scale-y-[1.14] ring-2 ring-foreground/60 ring-offset-1 ring-offset-card',
                )}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function HealthGroupCard({ group, range }: { group: HealthGroup; range: HealthRange }) {
  const [open, setOpen] = useState(true)
  const meta = HEALTH_RANGE_META[range]
  const panelId = `health-group-${group.id}`

  return (
    <Card className="overflow-visible">
      <CardHeader className="p-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((prev) => !prev)}
          className="flex w-full items-center justify-between gap-3 rounded-xl px-5 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate text-base font-semibold tracking-tight">{group.name}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {group.components.length} 个组件
            </span>
            <ChevronUp
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
                !open && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </div>
          <span
            className={cn(
              'shrink-0 text-sm font-medium tabular-nums',
              group.status === 'outage'
                ? 'text-danger'
                : group.status === 'degraded'
                  ? 'text-warning'
                  : 'text-muted-foreground',
            )}
          >
            {group.availability !== null
              ? `${formatAvailability(group.availability)} 可用率`
              : '暂无样本'}
          </span>
        </button>
      </CardHeader>

      {open ? (
        <CardContent id={panelId} className="space-y-5 px-5 pb-5 pt-1">
          {group.components.length === 0 ? (
            <p className="rounded-lg bg-muted/30 px-3.5 py-3 text-xs text-muted-foreground">
              近 {meta.label} 暂无样本数据。
            </p>
          ) : (
            <>
              <div className="space-y-5">
                {group.components.map((component) => (
                  <HealthComponentRow key={component.id} component={component} range={range} />
                ))}
              </div>
              <div className="flex items-center justify-between border-t pt-2.5 text-[11px] tabular-nums text-muted-foreground">
                <span>{meta.startLabel}</span>
                <span>每格 {meta.bucketLabel}</span>
                <span>现在</span>
              </div>
            </>
          )}
        </CardContent>
      ) : null}
    </Card>
  )
}

export function HealthMonitorBoard({ snapshot }: { snapshot: HealthMonitorSnapshot }) {
  const { summary, range } = snapshot
  const meta = HEALTH_RANGE_META[range]

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="综合可用率"
          value={formatAvailability(summary.availability)}
          tone={STATUS_TONE[summary.status]}
          note={`按最弱维度取底 · ${OVERALL_LABEL[summary.status]}`}
        />
        <Kpi
          label="生成任务"
          value={formatAvailability(summary.generation_availability)}
          note={`耗时 P50 ${formatLatencyMs(summary.generation_p50_ms)} · ${summary.generation_total.toLocaleString('zh-CN')} 次`}
        />
        <Kpi
          label="Agent 模型"
          value={formatAvailability(summary.agent_availability)}
          note={`TTFT 中位数 ${formatLatencyMs(summary.agent_ttft_p50_ms)} · ${summary.agent_total.toLocaleString('zh-CN')} 次`}
        />
        <Kpi
          label="后端接口"
          value={formatAvailability(summary.api_availability)}
          note={`分钟 P95 峰值 ${formatLatencyMs(summary.api_p95_ms)} · ${summary.api_total.toLocaleString('zh-CN')} 次`}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-4">
          {(['healthy', 'degraded', 'outage', 'idle'] as const).map((status) => (
            <span key={status} className="flex items-center gap-1.5">
              <span
                className={cn('inline-block h-3 w-1.5 rounded-[2px]', PILL_BG[status])}
                aria-hidden="true"
              />
              {STATUS_LABEL[status]}
            </span>
          ))}
        </div>
        <span className="tabular-nums">
          近 {meta.label} · {meta.bucketLabel}（{snapshot.bucket_count} 格）
          {snapshot.include_policy ? ' · 含内容安全拒图' : ' · 已排除内容安全拒图'}
        </span>
      </div>

      <div className="space-y-4">
        {snapshot.groups.map((group) => (
          <HealthGroupCard key={group.id} group={group} range={range} />
        ))}
      </div>
    </div>
  )
}
