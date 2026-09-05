import AssetThumb from '../features/library/components/AssetThumb'
import type { TaskRecord } from '../types'

const PREVIEW_LIMIT = 4

/** 历史里一组同源任务折起来的卡：复刻套与换背景任务共用。 */
export default function SetHistoryCard({
  name,
  kindLabel,
  tasks,
  expanded,
  onToggle,
}: {
  name: string
  kindLabel: string
  tasks: readonly TaskRecord[]
  expanded: boolean
  onToggle: () => void
}) {
  const done = tasks.filter((task) => task.status === 'done').length
  const failed = tasks.filter((task) => task.status === 'error').length
  const previews = tasks.flatMap((task) => task.outputImages).slice(0, PREVIEW_LIMIT)

  return (
    <div
      data-set-history-card
      className="flex h-full flex-col gap-3 rounded-2xl border border-gray-200/70 bg-white/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.02]"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{name}</p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {kindLabel} · 完成 {done}/{tasks.length}
            {failed > 0 ? ` · 失败 ${failed}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="shrink-0 rounded-lg px-2 py-1 text-xs text-blue-600 transition hover:bg-blue-500/10 dark:text-blue-300"
        >
          {expanded ? '收起' : '展开查看'}
        </button>
      </div>

      {previews.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5">
          {previews.map((imageId) => (
            <div
              key={imageId}
              className="aspect-square overflow-hidden rounded-lg border border-gray-200 dark:border-white/[0.08]"
            >
              <AssetThumb imageId={imageId} alt={`${name} 结果`} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
