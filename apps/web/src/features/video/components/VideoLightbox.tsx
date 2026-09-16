import { VIDEO_MODEL_SUPPORT, VIDEO_RESOLUTION_LABELS } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import Credits from '../../../components/Credits'
import Overlay from '../../../components/Overlay'
import { LABEL, OUTLINE_BUTTON } from '../../../components/panelStyles'
import { i18next, useTranslation } from '../../../i18n'
import { formatDateTime } from '../../../i18n/format'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../lib/clipboard'
import { useStore } from '../../../store'
import { videoAspectLabel, videoFrameAspect } from '../lib/aspect'
import { deriveOptions, type VideoDeriveOption } from '../lib/derive'
import { videoDeriveLabel } from '../lib/labels'
import { adoptAsFirstFrame, captureVideoFrame, videoOutputUrl } from '../lib/playback'
import { cancelVideoDownload } from '../lib/useVideoDownload'
import { useVideoStore } from '../store'
import type { VideoTask } from '../types'
import DeriveVideoPopover from './DeriveVideoPopover'
import VideoDownloadButton from './VideoDownloadButton'

function timing(task: VideoTask): string {
  const at = formatDateTime(task.createdAt)
  if (!task.completedAt) return at
  return i18next.t('lightbox.timing', {
    ns: 'video',
    at,
    seconds: Math.max(0, Math.round((task.completedAt - task.createdAt) / 1000)),
  })
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
  const { t } = useTranslation(['video', 'common'])
  const videoRef = useRef<HTMLVideoElement>(null)
  const [derive, setDerive] = useState<VideoDeriveOption | null>(null)
  const showToast = useStore((s) => s.showToast)
  const playbackUrl = videoOutputUrl(task)
  const modelLabel = VIDEO_MODEL_SUPPORT[task.model]?.label ?? task.model
  const firstFrame = task.firstFrameImageId
  const frameAspect = videoFrameAspect(task)
  const derivations = deriveOptions(task)

  // 灯箱关掉后还在拉流就是白读几 MB；卡片不这么做，它会被搜索框一个字符卸载掉。
  useEffect(() => () => cancelVideoDownload(task.id), [task.id])

  const copyPrompt = async () => {
    try {
      await copyTextToClipboard(task.prompt)
      showToast(t('lightbox.copied'), 'success')
    } catch (error) {
      showToast(getClipboardFailureMessage(t('common:toast.copyFailed'), error), 'error')
    }
  }

  const useAsFirstFrame = async () => {
    const video = videoRef.current
    const dataUrl = (video && captureVideoFrame(video)) ?? task.thumbnailDataUrl
    if (!dataUrl) {
      showToast(t('lightbox.frameUnavailable'), 'error')
      return
    }
    await adoptAsFirstFrame(dataUrl)
    showToast(t('toast.firstFrameAdopted'), 'success')
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
            <p className="text-sm text-gray-400">{t('lightbox.noPlayback')}</p>
          )}
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto border-t border-gray-200/70 p-4 text-sm dark:border-white/[0.08] lg:border-l lg:border-t-0">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className={LABEL}>{t('field.description')}</span>
              <span className="text-[11px] text-gray-400 dark:text-gray-500">
                {t('lightbox.copyHint')}
              </span>
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
            <Row label={t('field.model')}>{modelLabel}</Row>
            <Row label={t('lightbox.rowParams')}>
              {t('lightbox.params', {
                duration: task.duration,
                aspect: videoAspectLabel(task),
                resolution: VIDEO_RESOLUTION_LABELS[task.resolution],
              })}
            </Row>
            {firstFrame && (
              <Row label={t('frameSlot.first')}>
                <button
                  type="button"
                  className="text-blue-600 transition hover:underline dark:text-blue-300"
                  onClick={() => useStore.getState().setLightboxImageId(firstFrame, [firstFrame])}
                >
                  {t('lightbox.viewOriginal')}
                </button>
              </Row>
            )}
            {task.credits !== undefined && (
              <Row label={t('lightbox.rowCredits')}>
                <Credits credits={task.credits} />
              </Row>
            )}
            <Row label={t('lightbox.rowTime')}>{timing(task)}</Row>
          </dl>

          <div className="grid grid-cols-2 gap-2">
            <VideoDownloadButton
              task={task}
              className={OUTLINE_BUTTON}
              idleLabel={t('lightbox.downloadMp4')}
            />
            <button
              type="button"
              className={OUTLINE_BUTTON}
              onClick={() => {
                void useVideoStore.getState().regenerate(task)
                onClose()
              }}
            >
              {t('action.regenerate')}
            </button>
            <button type="button" className={OUTLINE_BUTTON} onClick={() => void useAsFirstFrame()}>
              {t('action.useAsFirstFrame')}
            </button>
            <button
              type="button"
              className={OUTLINE_BUTTON}
              onClick={() => {
                useVideoStore.getState().loadDraft(task)
                onClose()
              }}
            >
              {t('lightbox.sameParams')}
            </button>
            {derivations.map((option) => (
              <button
                key={option.mode}
                type="button"
                className={`${OUTLINE_BUTTON} disabled:cursor-not-allowed disabled:opacity-40`}
                disabled={!option.modelId}
                title={option.disabledReason}
                onClick={() => setDerive(option)}
              >
                {videoDeriveLabel(option.mode)}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="mt-auto self-start rounded-lg px-2 py-1 text-xs text-gray-500 transition hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
            onClick={() => {
              void useVideoStore.getState().removeTask(task.id)
              onClose()
            }}
          >
            {t('common:action.delete')}
          </button>
        </div>
      </div>

      {derive?.modelId && (
        <DeriveVideoPopover
          task={task}
          mode={derive.mode}
          modelId={derive.modelId}
          tier="alert"
          onClose={() => setDerive(null)}
        />
      )}
    </Overlay>
  )
}
