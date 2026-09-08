import { videoRateMultiplier } from '@image-playground/shared'
import { useEffect, useMemo, useState } from 'react'
import {
  CARD,
  GHOST_BUTTON,
  OUTLINE_BUTTON,
  PANEL_TITLE,
  SELECT,
} from '../../../../components/panelStyles'
import { firstFrameModelOption } from '../../../../lib/channels/videoChannels'
import { usePrivateSubmissionGuard } from '../../../../lib/privateOverlay'
import { useStore } from '../../../../store'
import VideoLightbox from '../../components/VideoLightbox'
import { useVideoStore } from '../../store'
import { useStoryboardStore } from '../store'
import StoryboardShotCard from './StoryboardShotCard'

export default function StoryboardBoard() {
  const storyboards = useStoryboardStore((s) => s.storyboards)
  const activeId = useStoryboardStore((s) => s.activeId)
  const loading = useStoryboardStore((s) => s.loading)
  const tasks = useStore((s) => s.tasks)
  const videoTasks = useVideoStore((s) => s.tasks)
  const resolution = useVideoStore((s) => s.draft.resolution)
  const model = useVideoStore((s) => s.draft.model)
  const [openVideoTaskId, setOpenVideoTaskId] = useState<string | null>(null)

  const record = storyboards.find((item) => item.id === activeId) ?? null
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const videoTasksById = useMemo(
    () => new Map(videoTasks.map((task) => [task.id, task])),
    [videoTasks],
  )

  const guard = usePrivateSubmissionGuard({
    model: firstFrameModelOption(model)?.modelId ?? model,
    quantity: record?.secondsPerShot ?? 0,
    unitMultiplier: videoRateMultiplier(resolution),
  })

  // 出图任务跑在工作台里，分镜记录只存任务 id，完成后要把图挂回来。
  useEffect(() => {
    useStoryboardStore.getState().adoptShotImages(tasksById)
  }, [tasksById])

  if (!record) return null

  const pending = record.shots.filter((shot) => shot.imageId && !shot.videoTaskId)
  const openVideoTask = openVideoTaskId ? (videoTasksById.get(openVideoTaskId) ?? null) : null
  const allVideosLabel =
    guard.estimatedCredits === undefined
      ? '全部生视频'
      : `全部生视频 · ${guard.estimatedCredits * pending.length} 积分`

  return (
    <section className={`${CARD} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={`${PANEL_TITLE} mr-auto`}>{record.title}</h2>
        {storyboards.length > 1 && (
          <select
            aria-label="最近分镜"
            value={record.id}
            onChange={(event) => useStoryboardStore.getState().select(event.target.value)}
            className={SELECT}
          >
            {storyboards.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          disabled={loading}
          className={GHOST_BUTTON}
          onClick={() => void useStoryboardStore.getState().replan(record.id)}
        >
          重写脚本
        </button>
        <button
          type="button"
          disabled={pending.length === 0}
          className={OUTLINE_BUTTON}
          onClick={() => void useStoryboardStore.getState().generateAllVideos(record.id)}
        >
          {allVideosLabel}
        </button>
        <button
          type="button"
          className={GHOST_BUTTON}
          onClick={() => void useStoryboardStore.getState().exportZip(record.id)}
        >
          导出
        </button>
        <button
          type="button"
          className={GHOST_BUTTON}
          onClick={() => void useStoryboardStore.getState().remove(record.id)}
        >
          删除
        </button>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">{record.summary}</p>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {record.shots.map((shot) => (
          <StoryboardShotCard
            key={shot.no}
            record={record}
            shot={shot}
            imageTask={shot.imageTaskId ? tasksById.get(shot.imageTaskId) : undefined}
            videoTask={shot.videoTaskId ? videoTasksById.get(shot.videoTaskId) : undefined}
            onPlay={() => setOpenVideoTaskId(shot.videoTaskId)}
          />
        ))}
      </ul>

      {openVideoTask && (
        <VideoLightbox task={openVideoTask} onClose={() => setOpenVideoTaskId(null)} />
      )}
    </section>
  )
}
