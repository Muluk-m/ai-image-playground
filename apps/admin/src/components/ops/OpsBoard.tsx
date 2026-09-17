import { OPS_THRESHOLDS } from '@image-playground/shared'
import { Link } from '@tanstack/react-router'

import { Kpi } from '@/components/Kpi'
import { OpsBlockCard } from '@/components/ops/OpsBlockCard'
import { bytes, elapsed, shortId } from '@/lib/format'
import type { OpsDatabase, OpsQueue, OpsSnapshot } from '@/lib/types'

function queueProblems(queue: OpsQueue): string[] {
  const problems: string[] = []
  if (
    queue.oldest_queued_wait_ms !== null &&
    queue.oldest_queued_wait_ms > OPS_THRESHOLDS.QUEUE_WAIT_MS
  ) {
    problems.push(`最老的排队任务已经等了 ${elapsed(queue.oldest_queued_wait_ms)}`)
  }
  if (queue.stuck.length > 0) {
    problems.push(`${queue.stuck.length} 个任务卡住：运行超过 ${elapsed(queue.stale_after_ms)}`)
  }
  return problems
}

function QueueBody({ queue, now }: { queue: OpsQueue; now: number }) {
  return (
    <>
      <div className="grid grid-cols-3 gap-4">
        <Kpi variant="inline" label="排队" value={String(queue.queued)} />
        <Kpi variant="inline" label="运行中" value={String(queue.in_progress)} />
        <Kpi
          variant="inline"
          label="最老的等了"
          value={
            queue.oldest_queued_wait_ms === null
              ? '没有在等的任务'
              : elapsed(queue.oldest_queued_wait_ms)
          }
        />
      </div>
      {queue.stuck.length > 0 ? (
        <ul className="space-y-1 border-t pt-3 text-xs">
          {queue.stuck.map((task) => (
            <li key={task.id} className="flex items-center justify-between gap-3">
              <Link
                to="/tasks/$taskId"
                params={{ taskId: task.id }}
                className="font-mono text-foreground underline-offset-2 hover:underline"
                title={task.id}
              >
                {shortId(task.id, 14)}
              </Link>
              <span className="truncate text-muted-foreground">{task.model}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                已运行 {elapsed(now - task.started_at)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

function DatabaseBody({ database }: { database: OpsDatabase }) {
  return (
    <>
      <Kpi variant="inline" label="总大小" value={bytes(database.size_bytes)} />
      <ul className="space-y-1 border-t pt-3 text-xs">
        {database.tables.map((table) => (
          <li key={table.name} className="flex items-center justify-between gap-3">
            <span className="truncate font-mono">{table.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {bytes(table.bytes)}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

/** 回答「这套部署现在有没有出事」。业务跑得怎么样是概览页的事，这里不重复。 */
export function OpsBoard({ snapshot }: { snapshot: OpsSnapshot }) {
  return (
    <section className="grid gap-4 xl:grid-cols-2">
      <OpsBlockCard title="队列" block={snapshot.queue} problems={queueProblems}>
        {(queue) => <QueueBody queue={queue} now={snapshot.generated_at} />}
      </OpsBlockCard>
      <OpsBlockCard title="数据库" block={snapshot.database} problems={() => []}>
        {(database) => <DatabaseBody database={database} />}
      </OpsBlockCard>
    </section>
  )
}
