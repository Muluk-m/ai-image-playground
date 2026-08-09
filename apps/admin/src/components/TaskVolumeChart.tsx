import type { TaskVolumeBucket } from '@/lib/types'

interface TaskVolumeChartProps {
  buckets: TaskVolumeBucket[]
  label: string
}

export function TaskVolumeChart({ buckets, label }: TaskVolumeChartProps) {
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.total))

  return (
    <div
      className="relative h-44 overflow-hidden rounded-lg border border-border/70 bg-card/70 px-3 pb-7 pt-4"
      role="img"
      aria-label={`${label}，峰值每个时间段 ${peak} 个任务`}
    >
      <div className="pointer-events-none absolute inset-x-3 bottom-7 top-4 flex flex-col justify-between">
        {[0, 1, 2, 3].map((line) => (
          <span key={line} className="block border-t border-dashed border-border/60" />
        ))}
      </div>
      <div className="relative flex h-full items-end gap-1">
        {buckets.map((bucket) => {
          const totalHeight = (bucket.total / peak) * 100
          const completedShare = bucket.total === 0 ? 0 : bucket.completed / bucket.total
          const failedShare = bucket.total === 0 ? 0 : bucket.failed / bucket.total
          const date = new Date(bucket.bucket_at)
          return (
            <div
              key={bucket.bucket_at}
              className="group relative flex h-full min-w-0 flex-1 items-end"
              title={`${date.toLocaleString()} · ${bucket.total} 个任务 · ${bucket.completed} 成功 · ${bucket.failed} 失败`}
            >
              <div
                className="flex w-full min-w-[2px] flex-col-reverse overflow-hidden rounded-t-[2px] bg-muted transition-opacity group-hover:opacity-75"
                style={{ height: `${Math.max(totalHeight, bucket.total > 0 ? 3 : 0)}%` }}
              >
                <span
                  className="block bg-emerald-500/80"
                  style={{ height: `${completedShare * 100}%` }}
                />
                <span
                  className="block bg-rose-500/80"
                  style={{ height: `${failedShare * 100}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
      <div className="absolute inset-x-3 bottom-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{buckets[0] ? new Date(buckets[0].bucket_at).toLocaleDateString() : '—'}</span>
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <i className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 成功
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="h-1.5 w-1.5 rounded-full bg-rose-500" /> 失败
          </span>
        </span>
        <span>{buckets.length ? new Date(buckets[buckets.length - 1]!.bucket_at).toLocaleDateString() : '—'}</span>
      </div>
    </div>
  )
}
