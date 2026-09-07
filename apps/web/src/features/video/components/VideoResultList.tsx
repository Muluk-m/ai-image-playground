import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { CARD, GHOST_BUTTON, PANEL_TITLE } from '../../../components/panelStyles'
import { useVideoStore } from '../store'
import { VIDEO_TASK_STATUS_LABELS, type VideoTask } from '../types'

function summary(task: VideoTask): string {
  const label = VIDEO_MODEL_SUPPORT[task.model]?.label ?? task.model
  return `${label} · ${task.duration} 秒 · ${task.aspectRatio} · ${task.resolution}`
}

export default function VideoResultList() {
  const tasks = useVideoStore((s) => s.tasks)

  return (
    <div className={`${CARD} flex flex-col gap-3`}>
      <h2 className={PANEL_TITLE}>结果</h2>
      {tasks.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">还没有生成过视频</p>
      ) : (
        <ul className="flex flex-col divide-y divide-gray-200/70 dark:divide-white/[0.08]">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-baseline gap-3 py-2 text-sm">
              <span className="w-12 shrink-0 text-xs text-gray-500 dark:text-gray-400">
                {VIDEO_TASK_STATUS_LABELS[task.status]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-gray-800 dark:text-gray-100">
                  {task.prompt}
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {summary(task)}
                  {task.status === 'error' && task.error ? ` · ${task.error}` : ''}
                  {task.status === 'error' && task.credits ? ` · 已退 ${task.credits} 积分` : ''}
                </span>
              </span>
              <button
                type="button"
                className={GHOST_BUTTON}
                onClick={() => void useVideoStore.getState().regenerate(task)}
              >
                重生成
              </button>
              <button
                type="button"
                className={GHOST_BUTTON}
                onClick={() => void useVideoStore.getState().removeTask(task.id)}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
