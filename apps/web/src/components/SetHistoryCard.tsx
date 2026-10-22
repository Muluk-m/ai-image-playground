import AssetThumb from '../features/library/components/AssetThumb'
import { useTranslation } from '../i18n'
import { retryTask } from '../store'
import type { TaskRecord } from '../types'
import { Button } from './ui/button'

const PREVIEW_LIMIT = 4

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
}: {
  name: string
  actions: readonly string[]
  tasks: readonly TaskRecord[]
  expanded: boolean
  onToggle: () => void
  batch?: boolean
}) {
  const { t } = useTranslation(['task', 'common'])
  const done = tasks.filter((task) => task.status === 'done').length
  const running = tasks.filter((task) => task.status === 'running').length
  const failedTasks = tasks.filter((task) => task.status === 'error')
  const failed = failedTasks.length
  const previews = tasks.flatMap((task) => task.outputImages).slice(0, PREVIEW_LIMIT)

  return (
    <div
      data-set-history-card
      className="flex h-full flex-col gap-3 rounded-2xl border border-border/70 bg-card/70 p-4"
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
            {failed > 0 ? ` · ${t('set.failedCount', { failed })}` : ''}
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

      {previews.length > 0 && (
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
