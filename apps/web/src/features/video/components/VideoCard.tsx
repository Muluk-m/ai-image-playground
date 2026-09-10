import { VIDEO_DERIVE_LABELS, VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { useState } from 'react'
import ContextMenu, { ContextMenuItem } from '../../../components/ContextMenu'
import { TrashIcon } from '../../../components/icons'
import { useStore } from '../../../store'
import { videoAspectLabel, videoFrameAspect } from '../lib/aspect'
import { deriveOptions, type VideoDeriveOption } from '../lib/derive'
import { isVideoTaskActive } from '../lib/feed'
import { adoptAsFirstFrame, captureVideoFrame, clockLabel, videoOutputUrl } from '../lib/playback'
import { useVideoStore } from '../store'
import type { VideoTask } from '../types'
import { BADGE, OVERLAY } from './chipStyles'
import DeriveVideoPopover from './DeriveVideoPopover'
import PlayBadge from './PlayBadge'
import RunningOverlay from './RunningOverlay'
import VideoDownloadButton from './VideoDownloadButton'

const LINEAGE_CHIP =
  'rounded border border-gray-200 px-1 text-[10px] text-gray-500 dark:border-white/[0.12] dark:text-gray-400'
const HOVER_BUTTON =
  'rounded-md bg-black/65 px-1 py-1 text-[11px] text-white transition hover:bg-black/80'

function frameBadge(task: VideoTask): string | null {
  if (task.source !== 'image') return null
  return task.lastFrameImageId ? '首帧 · 尾帧' : '首帧'
}

export default function VideoCard({ task, onOpen }: { task: VideoTask; onOpen: () => void }) {
  const showToast = useStore((s) => s.showToast)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [derive, setDerive] = useState<VideoDeriveOption | null>(null)
  const support = VIDEO_MODEL_SUPPORT[task.model]
  const modelLabel = support?.label ?? task.model
  const done = task.status === 'done'
  const playbackUrl = videoOutputUrl(task)
  const sourceIndex = task.storyboardVersion?.content.shots.findIndex(
    (shot) => shot.no === task.shotNo,
  )
  const displayShotNo =
    sourceIndex !== undefined && sourceIndex >= 0 ? sourceIndex + 1 : task.shotNo
  const badge = frameBadge(task)
  const frameAspect = videoFrameAspect(task)
  // 未完成的卡片按钮条根本不渲染，别为它扫频道列表。
  const derivations = done ? deriveOptions(task) : []

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
              <PlayBadge />
            </span>
          )}

          {isVideoTaskActive(task) && <RunningOverlay task={task} />}
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

          {badge && <span className={`${BADGE} left-1.5 top-1.5`}>{badge}</span>}
          {task.shotNo !== undefined && (
            <span className={`${BADGE} left-1.5 top-7`}>镜 {displayShotNo}</span>
          )}
          {done && (
            <span className={`${BADGE} bottom-1.5 right-1.5`}>{clockLabel(task.duration)}</span>
          )}
        </button>

        {done && (
          <div className="pointer-events-none absolute inset-x-1.5 bottom-1.5 grid grid-cols-3 gap-1 opacity-0 transition group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
            <VideoDownloadButton task={task} className={HOVER_BUTTON} idleLabel="下载" />
            <button
              type="button"
              className={HOVER_BUTTON}
              onClick={() => void useVideoStore.getState().regenerate(task)}
            >
              重生成
            </button>
            <button type="button" className={HOVER_BUTTON} onClick={() => void useAsFirstFrame()}>
              用作首帧
            </button>
            {derivations.map((option) => (
              <button
                key={option.mode}
                type="button"
                className={`${HOVER_BUTTON} disabled:opacity-40`}
                disabled={!option.modelId}
                title={option.disabledReason}
                onClick={() => setDerive(option)}
              >
                {VIDEO_DERIVE_LABELS[option.mode]}
              </button>
            ))}
            <button
              type="button"
              aria-label="更多"
              className={HOVER_BUTTON}
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
        {task.storyboardVersion && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer">
              来源：{task.storyboardVersion.content.title} · v{task.storyboardVersion.number}
            </summary>
            <p className="mt-2">
              {task.storyboardVersion.name} ·{' '}
              {new Date(task.storyboardVersion.savedAt).toLocaleString()}
            </p>
            <ol className="mt-2 space-y-2">
              {task.storyboardVersion.content.shots.map((shot, index) => (
                <li key={shot.no}>
                  <strong>
                    {index + 1}. {shot.title} · {shot.seconds} 秒
                  </strong>
                  <p>{shot.description}</p>
                </li>
              ))}
            </ol>
          </details>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          {task.derived && (
            <span className={LINEAGE_CHIP}>{VIDEO_DERIVE_LABELS[task.derived.mode]}</span>
          )}
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

      {derive?.modelId && (
        <DeriveVideoPopover
          task={task}
          mode={derive.mode}
          modelId={derive.modelId}
          onClose={() => setDerive(null)}
        />
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
