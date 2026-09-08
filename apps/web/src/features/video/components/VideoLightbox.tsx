import { VIDEO_MODEL_SUPPORT, VIDEO_RESOLUTION_LABELS } from '@image-playground/shared'
import { useRef } from 'react'
import Overlay from '../../../components/Overlay'
import { LABEL, OUTLINE_BUTTON } from '../../../components/panelStyles'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../lib/clipboard'
import { useStore } from '../../../store'
import { videoAspectLabel, videoFrameAspect } from '../lib/aspect'
import {
  adoptAsFirstFrame,
  captureVideoFrame,
  downloadVideoTask,
  videoOutputUrl,
} from '../lib/playback'
import { useVideoStore } from '../store'
import type { VideoTask } from '../types'

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function timing(task: VideoTask): string {
  const at = new Date(task.createdAt).toLocaleString('zh-CN')
  if (!task.completedAt) return at
  return `${at} · 用时 ${Math.max(0, Math.round((task.completedAt - task.createdAt) / 1000))} 秒`
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-gray-800 dark:text-gray-100">{children}</dd>
    </>
  )
}

export default function VideoLightbox({ task, onClose }: { task: VideoTask; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const showToast = useStore((s) => s.showToast)
  const playbackUrl = videoOutputUrl(task)
  const modelLabel = VIDEO_MODEL_SUPPORT[task.model]?.label ?? task.model
  const firstFrame = task.firstFrameImageId
  const frameAspect = videoFrameAspect(task)

  const copyPrompt = async () => {
    try {
      await copyTextToClipboard(task.prompt)
      showToast('已复制描述', 'success')
    } catch (error) {
      showToast(getClipboardFailureMessage('复制失败', error), 'error')
    }
  }

  const download = async () => {
    try {
      await downloadVideoTask(task)
      showToast('开始下载', 'success')
    } catch (error) {
      showToast(reason(error), 'error')
    }
  }

  const useAsFirstFrame = async () => {
    const video = videoRef.current
    const dataUrl = (video && captureVideoFrame(video)) ?? task.thumbnailDataUrl
    if (!dataUrl) {
      showToast('这一帧取不到，先播放一下再试', 'error')
      return
    }
    await adoptAsFirstFrame(dataUrl)
    showToast('已填入首帧', 'success')
    onClose()
  }

  return (
    <Overlay onClose={onClose} tier="raised">
      <div
        data-video-lightbox
        className="relative z-10 grid max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-white/50 bg-white shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 dark:ring-white/10 lg:grid-cols-[minmax(0,1fr)_20rem]"
      >
        <div className="grid min-h-[16rem] place-items-center bg-black p-4">
          {playbackUrl ? (
            <video
              ref={videoRef}
              src={playbackUrl}
              crossOrigin="use-credentials"
              controls
              autoPlay
              playsInline
              // 宽高都留给内容自己撑：给定宽度会让两个上限一起把画面压扁。
              className="max-h-[70vh] max-w-full rounded"
              style={{ aspectRatio: frameAspect }}
              onLoadedMetadata={(event) => {
                if (task.width && task.height) return
                const { videoWidth, videoHeight } = event.currentTarget
                if (!videoWidth || !videoHeight) return
                void useVideoStore.getState().setDimensions(task.id, videoWidth, videoHeight)
              }}
              onLoadedData={(event) => {
                if (task.thumbnailDataUrl) return
                const dataUrl = captureVideoFrame(event.currentTarget)
                if (dataUrl) void useVideoStore.getState().setThumbnail(task.id, dataUrl)
              }}
            >
              <track kind="captions" />
            </video>
          ) : (
            <p className="text-sm text-gray-400">这条还没有可播放的视频</p>
          )}
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto border-t border-gray-200/70 p-4 text-sm dark:border-white/[0.08] lg:border-l lg:border-t-0">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className={LABEL}>描述</span>
              <span className="text-[11px] text-gray-400 dark:text-gray-500">点击复制</span>
            </div>
            <button
              type="button"
              onClick={() => void copyPrompt()}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-left text-xs text-gray-700 transition hover:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            >
              {task.prompt}
            </button>
          </div>

          <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
            <Row label="模型">{modelLabel}</Row>
            <Row label="参数">
              {task.duration} 秒 · {videoAspectLabel(task)} ·{' '}
              {VIDEO_RESOLUTION_LABELS[task.resolution]}
            </Row>
            {firstFrame && (
              <Row label="首帧">
                <button
                  type="button"
                  className="text-blue-600 transition hover:underline dark:text-blue-300"
                  onClick={() => useStore.getState().setLightboxImageId(firstFrame, [firstFrame])}
                >
                  查看原图
                </button>
              </Row>
            )}
            {task.credits !== undefined && <Row label="积分">{task.credits}</Row>}
            <Row label="时间">{timing(task)}</Row>
          </dl>

          <div className="grid grid-cols-2 gap-2">
            <button type="button" className={OUTLINE_BUTTON} onClick={() => void download()}>
              下载 mp4
            </button>
            <button
              type="button"
              className={OUTLINE_BUTTON}
              onClick={() => {
                void useVideoStore.getState().regenerate(task)
                onClose()
              }}
            >
              重生成
            </button>
            <button type="button" className={OUTLINE_BUTTON} onClick={() => void useAsFirstFrame()}>
              用作首帧
            </button>
            <button
              type="button"
              className={OUTLINE_BUTTON}
              onClick={() => {
                useVideoStore.getState().loadDraft(task)
                onClose()
              }}
            >
              相同参数再来一条
            </button>
          </div>

          <button
            type="button"
            className="mt-auto self-start rounded-lg px-2 py-1 text-xs text-gray-500 transition hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
            onClick={() => {
              void useVideoStore.getState().removeTask(task.id)
              onClose()
            }}
          >
            删除
          </button>
        </div>
      </div>
    </Overlay>
  )
}
