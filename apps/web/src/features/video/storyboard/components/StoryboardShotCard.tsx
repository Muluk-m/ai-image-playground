import { useState } from 'react'
import Pending from '../../../../components/Pending'
import { FIELD, GHOST_BUTTON } from '../../../../components/panelStyles'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../../lib/clipboard'
import { useStore } from '../../../../store'
import type { TaskRecord } from '../../../../types'
import AssetThumb from '../../../library/components/AssetThumb'
import type { VideoTask } from '../../types'
import { useStoryboardStore } from '../store'
import type { StoryboardRecord, StoryboardShotPatch, StoryboardShotRecord } from '../types'

const BADGE = 'absolute rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white'
const ACTION = 'rounded-md px-1.5 py-1 text-[11px] transition disabled:opacity-40'

function statusLabel(shot: StoryboardShotRecord, imageTask?: TaskRecord): string | null {
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
  const imagePending = !shot.imageId && imageTask?.status !== 'error' && shot.imageTaskId !== null
  const videoDone = videoTask?.status === 'done'
  const videoPending = videoTask?.status === 'queued' || videoTask?.status === 'running'

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
            <span className="grid h-9 w-9 place-items-center rounded-full bg-black/55">
              <span className="ml-1 block h-0 w-0 border-y-[8px] border-l-[13px] border-y-transparent border-l-white" />
            </span>
          </button>
        )}

        {imagePending && !videoTask && (
          <span className="absolute inset-0 grid place-items-center text-xs text-gray-500 dark:text-gray-400">
            <Pending label="分镜图生成中" startedAt={imageTask?.createdAt ?? null} />
          </span>
        )}

        <span className={`${BADGE} left-1.5 top-1.5`}>镜 {shot.no}</span>
        <span className={`${BADGE} right-1.5 top-1.5`}>
          {videoDone
            ? '视频 ✓'
            : videoPending
              ? '视频生成中'
              : videoTask?.status === 'error'
                ? '视频失败'
                : statusLabel(shot, imageTask)}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 px-2.5 py-2 text-xs text-gray-500 dark:text-gray-400">
        {editing ? (
          <div className="flex flex-col gap-1.5">
            {editing === 'all' && (
              <input
                defaultValue={shot.title}
                aria-label="标题"
                onBlur={(event) => patch('title', event.target.value.trim())}
                className={FIELD}
              />
            )}
            <textarea
              defaultValue={shot.description}
              aria-label="画面"
              rows={3}
              onBlur={(event) => patch('description', event.target.value.trim())}
              className={`${FIELD} resize-none`}
            />
            {editing === 'all' && (
              <>
                <input
                  defaultValue={shot.camera}
                  aria-label="运镜"
                  onBlur={(event) => patch('camera', event.target.value.trim())}
                  className={FIELD}
                />
                <input
                  defaultValue={shot.line}
                  aria-label="台词"
                  onBlur={(event) => patch('line', event.target.value.trim())}
                  className={FIELD}
                />
                <textarea
                  defaultValue={shot.videoPrompt}
                  aria-label="视频提示词"
                  rows={3}
                  onBlur={(event) => patch('videoPrompt', event.target.value.trim())}
                  className={`${FIELD} resize-none`}
                />
              </>
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
