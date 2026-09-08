import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { formatElapsed, useElapsed } from '../../../hooks/useElapsed'
import { VIDEO_TASK_STATUS_LABELS, type VideoTask } from '../types'
import { OVERLAY } from './chipStyles'

/** 进度条封顶：跑过典型耗时也不能显示成已完成。 */
const MAX_PROGRESS = 0.95

/** 未完成视频的读秒遮罩：已用时长 + 队列状态 + 该模型的典型耗时。 */
export default function RunningOverlay({ task }: { task: VideoTask }) {
  const elapsed = useElapsed(task.createdAt) ?? 0
  const support = VIDEO_MODEL_SUPPORT[task.model]

  return (
    <>
      <span className={`${OVERLAY} bg-black/50 text-white`}>
        <span>
          <b className="block text-xl font-medium">{formatElapsed(elapsed)}</b>
          {VIDEO_TASK_STATUS_LABELS[task.status]}
          {support && <small className="block opacity-80">通常 {support.typicalSeconds} 秒</small>}
        </span>
      </span>

      {task.status === 'running' && support && (
        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
          <span
            className="block h-full bg-blue-500"
            style={{
              width: `${Math.min(MAX_PROGRESS, elapsed / 1000 / support.typicalSeconds) * 100}%`,
            }}
          />
        </span>
      )}
    </>
  )
}
