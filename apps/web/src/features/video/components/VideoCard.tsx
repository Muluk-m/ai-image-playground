import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { useState } from 'react'
import ContextMenu, { ContextMenuItem } from '../../../components/ContextMenu'
import { TrashIcon } from '../../../components/icons'
import { formatElapsed, useElapsed } from '../../../hooks/useElapsed'
import { useStore } from '../../../store'
import { videoAspectLabel, videoFrameAspect } from '../lib/aspect'
import {
  adoptAsFirstFrame,
  captureVideoFrame,
  clockLabel,
  downloadVideoTask,
  videoOutputUrl,
} from '../lib/playback'
import { useVideoStore } from '../store'
import type { VideoTask } from '../types'

const BADGE = 'absolute rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white'
const HOVER_BUTTON =
  'rounded-md bg-black/65 px-1 py-1 text-[11px] text-white transition hover:bg-black/80'
const OVERLAY = 'absolute inset-0 grid place-items-center text-center text-xs'

/** 进度条封顶：跑过典型耗时也不能显示成已完成。 */
const MAX_PROGRESS = 0.95

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function frameBadge(task: VideoTask): string | null {
  if (task.source !== 'image') return null
  return task.lastFrameImageId ? '首帧 · 尾帧' : '首帧'
}

export default function VideoCard({ task, onOpen }: { task: VideoTask; onOpen: () => void }) {
  const showToast = useStore((s) => s.showToast)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const elapsed = useElapsed(task.status === 'running' ? task.createdAt : null)

  const support = VIDEO_MODEL_SUPPORT[task.model]
  const modelLabel = support?.label ?? task.model
  const done = task.status === 'done'
  const playbackUrl = videoOutputUrl(task)
  const badge = frameBadge(task)
  const frameAspect = videoFrameAspect(task)

  const download = async () => {
    try {
      await downloadVideoTask(task)
      showToast('开始下载', 'success')
    } catch (error) {
      showToast(reason(error), 'error')
    }
  }

  const useAsFirstFrame = async () => {
    if (!task.thumbnailDataUrl) {
      showToast('这条还没有可用的首帧', 'error')
      return
    }
    await adoptAsFirstFrame(task.thumbnailDataUrl)
    showToast('已填入首帧', 'success')
  }

  return (
    <li
      data-video-card
      className={`group relative overflow-hidden rounded-xl border bg-white/70 dark:bg-white/[0.02] ${
        task.status === 'error'
          ? 'border-red-400/50'
          : 'border-gray-200/70 dark:border-white/[0.08]'
      }`}
    >
      <div className="relative">
        <button
          type="button"
          onClick={onOpen}
          disabled={!done}
          aria-label={done ? `播放 ${task.prompt}` : task.prompt}
          className="relative block aspect-video w-full overflow-hidden bg-gray-900 disabled:cursor-default dark:bg-black"
        >
          {/* 输出比例的画框居中放进 16:9 容器，竖版与方图自然留出黑边。 */}
          <span className={OVERLAY}>
            {frameAspect ? (
              <span className="block h-full" style={{ aspectRatio: frameAspect }}>
                {task.thumbnailDataUrl && (
                  <img src={task.thumbnailDataUrl} alt="" className="h-full w-full object-cover" />
                )}
              </span>
            ) : (
              task.thumbnailDataUrl && (
                <img
                  src={task.thumbnailDataUrl}
                  alt=""
                  className="max-h-full max-w-full object-contain"
                />
              )
            )}
          </span>

          {done && (
            <span className={OVERLAY}>
              <span className="grid h-9 w-9 place-items-center rounded-full bg-black/55">
                <span className="ml-1 block h-0 w-0 border-y-[8px] border-l-[13px] border-y-transparent border-l-white" />
              </span>
            </span>
          )}

          {task.status === 'running' && (
            <span className={`${OVERLAY} bg-black/50 text-white`}>
              <span>
                <b className="block text-xl font-medium">{formatElapsed(elapsed ?? 0)}</b>
                生成中
                {support && (
                  <small className="block opacity-80">通常 {support.typicalSeconds} 秒</small>
                )}
              </span>
            </span>
          )}
          {task.status === 'queued' && (
            <span className={`${OVERLAY} bg-black/50 text-white`}>排队</span>
          )}
          {task.status === 'error' && (
            <span
              className={`${OVERLAY} bg-gray-100 px-3 text-gray-600 dark:bg-white/[0.04] dark:text-gray-300`}
            >
              <span>
                <b className="block text-sm font-medium text-gray-800 dark:text-gray-100">失败</b>
                {task.error}
                {task.credits !== undefined && (
                  <small className="block">已退 {task.credits} 积分</small>
                )}
              </span>
            </span>
          )}

          {task.status === 'running' && support && (
            <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
              <span
                className="block h-full bg-blue-500"
                style={{
                  width: `${Math.min(MAX_PROGRESS, (elapsed ?? 0) / 1000 / support.typicalSeconds) * 100}%`,
                }}
              />
            </span>
          )}

          {badge && <span className={`${BADGE} left-1.5 top-1.5`}>{badge}</span>}
          {done && (
            <span className={`${BADGE} bottom-1.5 right-1.5`}>{clockLabel(task.duration)}</span>
          )}
        </button>

        {done && (
          <div className="pointer-events-none absolute inset-x-1.5 bottom-1.5 flex gap-1 opacity-0 transition group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
            <button
              type="button"
              className={`${HOVER_BUTTON} flex-1`}
              onClick={() => void download()}
            >
              下载
            </button>
            <button
              type="button"
              className={`${HOVER_BUTTON} flex-1`}
              onClick={() => void useVideoStore.getState().regenerate(task)}
            >
              重生成
            </button>
            <button
              type="button"
              className={`${HOVER_BUTTON} flex-1`}
              onClick={() => void useAsFirstFrame()}
            >
              用作首帧
            </button>
            <button
              type="button"
              aria-label="更多"
              className={`${HOVER_BUTTON} w-7 shrink-0`}
              onClick={(event) => setMenu({ x: event.clientX, y: event.clientY })}
            >
              ⋯
            </button>
          </div>
        )}
      </div>

      <div className="px-2.5 py-2 text-xs text-gray-500 dark:text-gray-400">
        <b
          data-video-card-prompt
          className="block truncate font-medium text-gray-800 dark:text-gray-100"
        >
          {task.prompt}
        </b>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <span>{modelLabel}</span>
          <span>{task.duration} 秒</span>
          <span>{videoAspectLabel(task)}</span>
          {task.credits !== undefined && task.status !== 'error' && (
            <span>{task.credits} 积分</span>
          )}
          {task.status === 'error' && (
            <button
              type="button"
              className="rounded border border-gray-200 px-1.5 text-[11px] text-gray-600 transition hover:border-blue-400 hover:text-blue-600 dark:border-white/[0.12] dark:text-gray-300"
              onClick={() => void useVideoStore.getState().regenerate(task)}
            >
              重试
            </button>
          )}
        </div>
      </div>

      {/* 文生任务没有现成首帧：拉一帧回填，回填后这个 video 不再挂载。 */}
      {done && !task.thumbnailDataUrl && playbackUrl && (
        <video
          src={playbackUrl}
          crossOrigin="use-credentials"
          preload="metadata"
          muted
          hidden
          data-video-thumbnail-probe
          onLoadedData={(event) => {
            const dataUrl = captureVideoFrame(event.currentTarget)
            if (dataUrl) void useVideoStore.getState().setThumbnail(task.id, dataUrl)
          }}
        >
          <track kind="captions" />
        </video>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <ContextMenuItem
            icon={<TrashIcon className="h-4 w-4" />}
            label="删除"
            onClick={() => {
              setMenu(null)
              void useVideoStore.getState().removeTask(task.id)
            }}
          />
        </ContextMenu>
      )}
    </li>
  )
}
