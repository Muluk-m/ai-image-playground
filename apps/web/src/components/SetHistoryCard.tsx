import { useEffect, useState } from 'react'
import AssetThumb from '../features/library/components/AssetThumb'
import { useTranslation } from '../i18n'
import { retryTask } from '../store'
import type { TaskRecord } from '../types'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

const PREVIEW_LIMIT = 4
/** 逐张生成的卡上最多摆两行格子，多出来的收进最后一格的「+N」。 */
const BATCH_TILE_LIMIT = 8

function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** 有在跑的格子时每秒走一次表。 */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/** 逐张生成的一格：出了图就是图，在跑的转圈计时，排队的写「排队中」。 */
function BatchTile({ task, now, name }: { task: TaskRecord; now: number; name: string }) {
  const { t } = useTranslation('task')
  const imageId = task.outputImages[0]
  if (task.status === 'done' && imageId)
    return (
      <div className="aspect-square overflow-hidden rounded-lg border border-border">
        <AssetThumb imageId={imageId} alt={t('set.resultAlt', { name })} />
      </div>
    )
  const queued = task.batchQueued === true
  return (
    <div
      data-batch-tile={queued ? 'queued' : 'running'}
      className={`flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border bg-muted/60 text-xs text-muted-foreground ${
        queued ? 'border-dashed border-border' : 'border-primary/50'
      }`}
    >
      {queued ? (
        t('card.batchQueued')
      ) : (
        <>
          <Icon
            name="loading"
            className="size-4 animate-spin text-primary motion-reduce:animate-none"
          />
          <span className="tabular-nums">
            {formatClock(now - (task.batchStartedAt ?? task.createdAt))}
          </span>
        </>
      )}
    </div>
  )
}

/**
 * 历史里一组同源任务折起来的卡。逐张生成（`batch`）的一组还在卡上逐条列出失败的图：
 * 哪一张、为什么失败、单独重试。
 */
export default function SetHistoryCard({
  name,
  actions,
  tasks,
  expanded,
  onToggle,
  batch = false,
  attended = false,
}: {
  name: string
  actions: readonly string[]
  tasks: readonly TaskRecord[]
  expanded: boolean
  onToggle: () => void
  batch?: boolean
  /** 这次主动发送的那一批：卡片滚进视野并闪一下（见 lib/submittedTaskAttention）。 */
  attended?: boolean
}) {
  const { t } = useTranslation(['task', 'common'])
  const done = tasks.filter((task) => task.status === 'done').length
  const queued = tasks.filter((task) => task.status === 'running' && task.batchQueued).length
  const running = tasks.filter((task) => task.status === 'running').length - queued
  // 排队中被撤回的那几张记成「已取消」：积分已退，不是失败，不进失败清单、不给重试。
  const cancelled = tasks.filter((task) => task.status === 'error' && task.cancelled).length
  const failedTasks = tasks.filter((task) => task.status === 'error' && !task.cancelled)
  const failed = failedTasks.length
  const previews = tasks.flatMap((task) => task.outputImages).slice(0, PREVIEW_LIMIT)
  // 失败的那几张单独列在下面，格子里只摆出了图的、在跑的和排队的。
  const tiles = batch ? tasks.filter((task) => task.status !== 'error') : []
  const shownTiles = tiles.length > BATCH_TILE_LIMIT ? tiles.slice(0, BATCH_TILE_LIMIT - 1) : tiles
  const hiddenTiles = tiles.length - shownTiles.length
  const now = useClock(batch && running > 0)

  return (
    <div
      data-set-history-card
      data-set-task-ids={tasks.map((task) => task.id).join(' ')}
      tabIndex={attended ? -1 : undefined}
      className={`flex h-full scroll-my-4 flex-col gap-3 rounded-2xl border border-border/70 bg-card/70 p-4 ${
        attended ? 'task-submitted-attention' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{name}</p>
          {actions.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {actions.map((action) => (
                <span
                  key={action}
                  data-set-history-action
                  className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
                >
                  {action}
                </span>
              ))}
            </div>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {t('set.doneCount', { done, total: tasks.length })}
            {batch && running > 0 ? ` · ${t('set.runningCount', { running })}` : ''}
            {batch && queued > 0 ? ` · ${t('set.queuedCount', { queued })}` : ''}
            {failed > 0 ? ` · ${t('set.failedCount', { failed })}` : ''}
            {cancelled > 0 ? ` · ${t('set.cancelledCount', { cancelled })}` : ''}
          </p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="shrink-0 text-primary"
        >
          {expanded ? t('common:action.collapse') : t('set.expandToView')}
        </Button>
      </div>

      {batch && tiles.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5">
          {shownTiles.map((task) => (
            <BatchTile key={task.id} task={task} now={now} name={name} />
          ))}
          {hiddenTiles > 0 && (
            <div className="flex aspect-square items-center justify-center rounded-lg border border-border bg-muted/60 text-xs text-muted-foreground">
              +{hiddenTiles}
            </div>
          )}
        </div>
      )}

      {!batch && previews.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5">
          {previews.map((imageId) => (
            <div
              key={imageId}
              className="aspect-square overflow-hidden rounded-lg border border-border"
            >
              <AssetThumb imageId={imageId} alt={t('set.resultAlt', { name })} />
            </div>
          ))}
        </div>
      )}

      {batch && failed > 0 && (
        <ul
          aria-label={t('set.failedList')}
          className="flex max-h-48 flex-col gap-2 overflow-y-auto border-t border-border/70 pt-3"
        >
          {failedTasks.map((task) => (
            <li key={task.id} data-set-history-failure className="flex items-center gap-3">
              <div className="size-10 shrink-0 overflow-hidden rounded-lg border border-border">
                {task.inputImageIds[0] && <AssetThumb imageId={task.inputImageIds[0]} alt="" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground">
                  {t('set.failedItem', { index: task.origin?.shotId ?? '' })}
                </p>
                <p
                  className="line-clamp-2 text-xs text-destructive"
                  title={task.error ?? undefined}
                >
                  {task.error?.split('\n')[0] || t('common:state.failed')}
                </p>
              </div>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                className="shrink-0"
                onClick={() => void retryTask(task)}
              >
                {t('common:action.retry')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
