import { storyboardRangeLabel } from '@image-playground/shared'
import { useState } from 'react'
import Pending from '../../../../components/Pending'
import { FIELD, GHOST_BUTTON } from '../../../../components/panelStyles'
import { i18next, useTranslation } from '../../../../i18n'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../../lib/clipboard'
import { useStore } from '../../../../store'
import type { TaskRecord } from '../../../../types'
import AssetThumb from '../../../library/components/AssetThumb'
import { BADGE } from '../../components/chipStyles'
import PlayBadge from '../../components/PlayBadge'
import RunningOverlay from '../../components/RunningOverlay'
import { isVideoTaskActive } from '../../lib/feed'
import type { VideoTask } from '../../types'
import { useStoryboardStore } from '../store'
import type { StoryboardRecord, StoryboardShotPatch, StoryboardShotRecord } from '../types'

const ACTION = 'rounded-md px-1.5 py-1 text-[11px] transition disabled:opacity-40'

const EDIT_FIELDS = [
  { key: 'title', labelKey: 'shotCard.fieldTitle' },
  { key: 'description', labelKey: 'shotCard.fieldDescription', rows: 3 },
  { key: 'camera', labelKey: 'shotCard.fieldCamera' },
  { key: 'line', labelKey: 'shotCard.fieldLine' },
  { key: 'videoPrompt', labelKey: 'shotCard.fieldVideoPrompt', rows: 3 },
] as const satisfies ReadonlyArray<{
  key: keyof StoryboardShotPatch
  labelKey: string
  rows?: number
}>

function badgeLabel(
  shot: StoryboardShotRecord,
  imageTask?: TaskRecord,
  videoTask?: VideoTask,
): string | null {
  if (videoTask?.status === 'done') return i18next.t('shotCard.badgeVideoDone', { ns: 'video' })
  if (videoTask?.status === 'error') return i18next.t('shotCard.badgeVideoFailed', { ns: 'video' })
  // 还在跑的视频由读秒遮罩说明状态。
  if (videoTask) return null
  if (shot.imageId) return i18next.t('shotCard.badgeFrame', { ns: 'video' })
  if (imageTask?.status === 'error') return i18next.t('shotCard.badgeImageFailed', { ns: 'video' })
  return null
}

/** 一镜的三态：出图中 → 分镜图 → 视频。视频一旦提交就盖过图的状态。 */
export default function StoryboardShotCard({
  record,
  shot,
  imageTask,
  videoTask,
  onPlay,
}: {
  record: StoryboardRecord
  shot: StoryboardShotRecord
  imageTask?: TaskRecord
  videoTask?: VideoTask
  onPlay: () => void
}) {
  const { t } = useTranslation(['video', 'common'])
  const [editing, setEditing] = useState<'description' | 'all' | null>(null)
  const showToast = useStore((s) => s.showToast)
  const imagePending = !shot.imageId && shot.imageTaskId !== null && imageTask?.status !== 'error'
  const videoDone = videoTask?.status === 'done'
  const videoPending = videoTask && isVideoTaskActive(videoTask) ? videoTask : undefined
  const label = badgeLabel(shot, imageTask, videoTask)

  const patch = (field: keyof StoryboardShotPatch, value: string) => {
    if (shot[field] === value) return
    const change: StoryboardShotPatch = { [field]: value }
    void useStoryboardStore.getState().updateShot(record.id, shot.no, change)
  }

  const copyPrompt = async () => {
    try {
      await copyTextToClipboard(shot.videoPrompt)
      showToast(t('shotCard.copied'), 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage(t('common:toast.copyFailed'), err), 'error')
    }
  }

  const thumbnail = videoDone ? videoTask?.thumbnailDataUrl : undefined

  return (
    <li className="overflow-hidden rounded-xl border border-border/70 bg-card/70">
      <div className="relative aspect-video bg-muted">
        {thumbnail ? (
          <img src={thumbnail} alt={shot.title} className="h-full w-full object-cover" />
        ) : (
          shot.imageId && <AssetThumb imageId={shot.imageId} alt={shot.title} />
        )}

        {videoDone && (
          <button
            type="button"
            onClick={onPlay}
            aria-label={t('shotCard.playAria', { no: shot.no })}
            className="absolute inset-0 grid place-items-center"
          >
            <PlayBadge />
          </button>
        )}

        {imagePending && !videoTask && (
          <span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            <Pending
              label={t('shared.shotImagePending')}
              startedAt={imageTask?.createdAt ?? null}
            />
          </span>
        )}

        {videoPending && <RunningOverlay task={videoPending} />}

        <span className={`${BADGE} left-1.5 top-1.5`}>
          {t('shared.shotBadge', { no: shot.no })}
        </span>
        {label && <span className={`${BADGE} right-1.5 top-1.5`}>{label}</span>}
      </div>

      <div className="flex flex-col gap-1.5 px-2.5 py-2 text-xs text-muted-foreground">
        {editing ? (
          <div className="flex flex-col gap-1.5">
            {EDIT_FIELDS.filter((field) => editing === 'all' || field.key === 'description').map(
              (field) =>
                'rows' in field ? (
                  <textarea
                    key={field.key}
                    defaultValue={shot[field.key]}
                    aria-label={t(field.labelKey)}
                    rows={field.rows}
                    onBlur={(event) => patch(field.key, event.target.value.trim())}
                    className={`${FIELD} resize-none`}
                  />
                ) : (
                  <input
                    key={field.key}
                    defaultValue={shot[field.key]}
                    aria-label={t(field.labelKey)}
                    onBlur={(event) => patch(field.key, event.target.value.trim())}
                    className={FIELD}
                  />
                ),
            )}
            <button type="button" className={GHOST_BUTTON} onClick={() => setEditing(null)}>
              {t('common:state.done')}
            </button>
          </div>
        ) : (
          <>
            <b className="block truncate font-medium text-foreground">{shot.title}</b>
            <button
              type="button"
              onClick={() => setEditing('description')}
              className="text-left leading-relaxed"
            >
              {shot.description}
            </button>
            <div className="flex flex-wrap items-center gap-2">
              <span>{shot.camera}</span>
              <span>{t('shared.seconds', { seconds: storyboardRangeLabel(shot) })}</span>
              {shot.line && (
                <span className="truncate">{t('shotCard.line', { line: shot.line })}</span>
              )}
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={ACTION} onClick={() => setEditing('all')}>
            {t('shotCard.edit')}
          </button>
          <button
            type="button"
            className={ACTION}
            onClick={() =>
              void useStoryboardStore.getState().regenerateShotImage(record.id, shot.no)
            }
          >
            {shot.imageTaskId ? t('shotCard.regenerateImage') : t('shotCard.generateImage')}
          </button>
          <button type="button" className={ACTION} onClick={() => void copyPrompt()}>
            {t('shotCard.copyPrompt')}
          </button>
          <button
            type="button"
            disabled={!shot.imageId || Boolean(videoTask)}
            className={ACTION}
            onClick={() => void useStoryboardStore.getState().generateShotVideo(record.id, shot.no)}
          >
            {t('shotCard.generateVideo')}
          </button>
        </div>
      </div>
    </li>
  )
}
