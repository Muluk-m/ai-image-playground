import { videoRateMultiplier } from '@image-playground/shared'
import { useEffect, useMemo, useState } from 'react'
import {
  CARD,
  FIELD,
  GHOST_BUTTON,
  PANEL_TITLE,
  PRIMARY_BUTTON,
  SELECT,
} from '../../../../components/panelStyles'
import { durationModelOption } from '../../../../lib/channels/videoChannels'
import { usePrivateSubmissionGuard } from '../../../../lib/privateOverlay'
import { useStore } from '../../../../store'
import PlayBadge from '../../components/PlayBadge'
import RunningOverlay from '../../components/RunningOverlay'
import VideoLightbox from '../../components/VideoLightbox'
import { isVideoTaskActive } from '../../lib/feed'
import { unsupportedDurationReason, useVideoStore } from '../../store'
import { useStoryboardStore, wholeVideoFrameId } from '../store'
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
  const [editingPrompt, setEditingPrompt] = useState(false)

  const record = storyboards.find((item) => item.id === activeId) ?? null
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const videoTasksById = useMemo(
    () => new Map(videoTasks.map((task) => [task.id, task])),
    [videoTasks],
  )

  const option = record
    ? durationModelOption(model, record.totalSeconds, Boolean(wholeVideoFrameId(record)))
    : undefined
  const guard = usePrivateSubmissionGuard({
    model: option?.modelId ?? model,
    quantity: record?.totalSeconds ?? 0,
    unitMultiplier: videoRateMultiplier(resolution),
  })

  // 出图任务跑在工作台里，分镜记录只存任务 id，完成后要把图挂回来。
  useEffect(() => {
    useStoryboardStore.getState().adoptShotImages(tasksById)
  }, [tasksById])

  if (!record) return null

  const openVideoTask = openVideoTaskId ? (videoTasksById.get(openVideoTaskId) ?? null) : null
  const wholeTask = record.videoTaskId ? videoTasksById.get(record.videoTaskId) : undefined
  const wholeRunning = wholeTask !== undefined && isVideoTaskActive(wholeTask)
  const missingImages = record.shots.some((shot) => shot.imageTaskId === null)
  const wholeLabel = `生成整条视频 · ${record.totalSeconds} 秒${
    guard.estimatedCredits === undefined ? '' : ` · ${guard.estimatedCredits} 积分`
  }`

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
        {missingImages && (
          <button
            type="button"
            className={GHOST_BUTTON}
            onClick={() => void useStoryboardStore.getState().generateMissingShotImages(record.id)}
          >
            全部出分镜图
          </button>
        )}
        <button
          type="button"
          disabled={!option || wholeRunning || guard.blocked}
          title={guard.disabledReason}
          className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed`}
          onClick={() => void useStoryboardStore.getState().generateWholeVideo(record.id)}
        >
          {wholeLabel}
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

      {!option && (
        <p className="text-[11px] text-red-600 dark:text-red-400">
          {unsupportedDurationReason(record.totalSeconds)}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400">整条视频提示词</div>
        {editingPrompt ? (
          <textarea
            defaultValue={record.videoPrompt}
            aria-label="整条视频提示词"
            rows={record.shots.length + 2}
            onBlur={(event) => {
              setEditingPrompt(false)
              const next = event.target.value.trim()
              if (next !== record.videoPrompt) {
                void useStoryboardStore.getState().updateVideoPrompt(record.id, next)
              }
            }}
            className={`${FIELD} resize-none`}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingPrompt(true)}
            className="whitespace-pre-wrap text-left text-xs leading-relaxed text-gray-600 dark:text-gray-300"
          >
            {record.videoPrompt}
          </button>
        )}
      </div>

      {wholeTask && (
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          {wholeTask.status === 'error' ? (
            <>
              <span className="text-red-600 dark:text-red-400">{wholeTask.error}</span>
              <button
                type="button"
                className={GHOST_BUTTON}
                onClick={() => void useStoryboardStore.getState().generateWholeVideo(record.id)}
              >
                重试
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={wholeRunning}
              onClick={() => setOpenVideoTaskId(wholeTask.id)}
              aria-label="播放整条视频"
              className="relative block aspect-video w-44 overflow-hidden rounded-lg bg-gray-900 disabled:cursor-default"
            >
              {wholeTask.thumbnailDataUrl && (
                <img
                  src={wholeTask.thumbnailDataUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              )}
              {wholeRunning ? (
                <RunningOverlay task={wholeTask} />
              ) : (
                <span className="absolute inset-0 grid place-items-center">
                  <PlayBadge />
                </span>
              )}
            </button>
          )}
        </div>
      )}

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
