import { useState } from 'react'
import Pending from '../../../../components/Pending'
import { FIELD, GHOST_BUTTON } from '../../../../components/panelStyles'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../../lib/clipboard'
import { useStore } from '../../../../store'
import type { TaskRecord } from '../../../../types'
import AssetThumb from '../../../library/components/AssetThumb'
import { BADGE } from '../../components/chipStyles'
import PlayBadge from '../../components/PlayBadge'
import type { VideoTask } from '../../types'
import { useStoryboardStore } from '../store'
import type { StoryboardRecord, StoryboardShotPatch, StoryboardShotRecord } from '../types'

const ACTION = 'rounded-md px-1.5 py-1 text-[11px] transition disabled:opacity-40'

const EDIT_FIELDS = [
  { key: 'title', label: '标题' },
  { key: 'description', label: '画面', rows: 3 },
  { key: 'camera', label: '运镜' },
  { key: 'line', label: '台词' },
  { key: 'videoPrompt', label: '视频提示词', rows: 3 },
] as const satisfies ReadonlyArray<{ key: keyof StoryboardShotPatch; label: string; rows?: number }>

function badgeLabel(
  shot: StoryboardShotRecord,
  imageTask?: TaskRecord,
  videoTask?: VideoTask,
): string | null {
  if (videoTask?.status === 'done') return '视频 ✓'
  if (videoTask?.status === 'error') return '视频失败'
  if (videoTask) return '视频生成中'
  if (shot.imageId) return '分镜图'
  if (imageTask?.status === 'error') return '出图失败'
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
  const [editing, setEditing] = useState<'description' | 'all' | null>(null)
  const showToast = useStore((s) => s.showToast)
  const imagePending = !shot.imageId && shot.imageTaskId !== null && imageTask?.status !== 'error'
  const videoDone = videoTask?.status === 'done'
  const label = badgeLabel(shot, imageTask, videoTask)

  const patch = (field: keyof StoryboardShotPatch, value: string) => {
    if (shot[field] === value) return
    const change: StoryboardShotPatch = { [field]: value }
    void useStoryboardStore.getState().updateShot(record.id, shot.no, change)
  }

  const copyPrompt = async () => {
    try {
      await copyTextToClipboard(shot.videoPrompt)
      showToast('已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制失败', err), 'error')
    }
  }

  const thumbnail = videoDone ? videoTask?.thumbnailDataUrl : undefined

  return (
    <li className="overflow-hidden rounded-xl border border-gray-200/70 bg-white/70 dark:border-white/[0.08] dark:bg-white/[0.02]">
      <div className="relative aspect-video bg-gray-100 dark:bg-white/[0.04]">
        {thumbnail ? (
          <img src={thumbnail} alt={shot.title} className="h-full w-full object-cover" />
        ) : (
          shot.imageId && <AssetThumb imageId={shot.imageId} alt={shot.title} />
        )}

        {videoDone && (
          <button
            type="button"
            onClick={onPlay}
            aria-label={`播放 镜 ${shot.no}`}
            className="absolute inset-0 grid place-items-center"
          >
            <PlayBadge />
          </button>
        )}

        {imagePending && !videoTask && (
          <span className="absolute inset-0 grid place-items-center text-xs text-gray-500 dark:text-gray-400">
            <Pending label="分镜图生成中" startedAt={imageTask?.createdAt ?? null} />
          </span>
        )}

        <span className={`${BADGE} left-1.5 top-1.5`}>镜 {shot.no}</span>
        {label && <span className={`${BADGE} right-1.5 top-1.5`}>{label}</span>}
      </div>

      <div className="flex flex-col gap-1.5 px-2.5 py-2 text-xs text-gray-500 dark:text-gray-400">
        {editing ? (
          <div className="flex flex-col gap-1.5">
            {EDIT_FIELDS.filter((field) => editing === 'all' || field.key === 'description').map(
              (field) =>
                'rows' in field ? (
                  <textarea
                    key={field.key}
                    defaultValue={shot[field.key]}
                    aria-label={field.label}
                    rows={field.rows}
                    onBlur={(event) => patch(field.key, event.target.value.trim())}
                    className={`${FIELD} resize-none`}
                  />
                ) : (
                  <input
                    key={field.key}
                    defaultValue={shot[field.key]}
                    aria-label={field.label}
                    onBlur={(event) => patch(field.key, event.target.value.trim())}
                    className={FIELD}
                  />
                ),
            )}
            <button type="button" className={GHOST_BUTTON} onClick={() => setEditing(null)}>
              完成
            </button>
          </div>
        ) : (
          <>
            <b className="block truncate font-medium text-gray-800 dark:text-gray-100">
              {shot.title}
            </b>
            <button
              type="button"
              onClick={() => setEditing('description')}
              className="text-left leading-relaxed"
            >
              {shot.description}
            </button>
            <div className="flex flex-wrap items-center gap-2">
              <span>{shot.camera}</span>
              <span>{shot.seconds} 秒</span>
              {shot.line && <span className="truncate">「{shot.line}」</span>}
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={ACTION} onClick={() => setEditing('all')}>
            改文案
          </button>
          <button
            type="button"
            className={ACTION}
            onClick={() =>
              void useStoryboardStore.getState().regenerateShotImage(record.id, shot.no)
            }
          >
            重出图
          </button>
          <button type="button" className={ACTION} onClick={() => void copyPrompt()}>
            复制提示词
          </button>
          <button
            type="button"
            disabled={!shot.imageId || Boolean(videoTask)}
            className={`${ACTION} font-medium text-blue-600 dark:text-blue-300`}
            onClick={() => void useStoryboardStore.getState().generateShotVideo(record.id, shot.no)}
          >
            生视频
          </button>
        </div>
      </div>
    </li>
  )
}
