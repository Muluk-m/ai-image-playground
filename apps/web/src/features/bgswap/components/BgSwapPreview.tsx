import { useShallow } from 'zustand/react/shallow'
import { ACTIVE_SEGMENT, CARD, IDLE_SEGMENT, SEGMENT } from '../../../components/panelStyles'
import { useImageThumbnail } from '../../../hooks/useImageThumbnail'
import { useStore } from '../../../store'
import { useBgSwapStore } from '../store'

export default function BgSwapPreview() {
  const images = useBgSwapStore(useShallow((s) => s.draft.images))
  const selectedImageId = useBgSwapStore((s) => s.selectedImageId)
  const previewVersionId = useBgSwapStore((s) => s.previewVersionId)
  const tasks = useStore((s) => s.tasks)

  const { previewVersion } = useBgSwapStore.getState()
  const selected = images.find((image) => image.imageId === selectedImageId)
  const index = images.findIndex((image) => image.imageId === selectedImageId)
  const versions = selected?.versions ?? []
  const previewed = versions.find((version) => version.id === previewVersionId)
  const shownImageId = previewed
    ? tasks.find((task) => task.id === previewed.taskId)?.outputImages[0]
    : selected?.imageId
  const label = previewed ? `第 ${versions.indexOf(previewed) + 1} 版` : `原图 ${index + 1}`
  const thumbnail = useImageThumbnail(shownImageId)

  return (
    <section data-bgswap-column="preview" className={CARD}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          {selected ? label : '预览'}
        </h2>
        <div className="flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-900">
          <button
            type="button"
            onClick={() => previewVersion(null)}
            aria-pressed={previewed === undefined}
            className={`${SEGMENT} ${previewed ? IDLE_SEGMENT : ACTIVE_SEGMENT}`}
          >
            原图
          </button>
          <button
            type="button"
            onClick={() => previewVersion(versions[versions.length - 1]?.id ?? null)}
            disabled={versions.length === 0}
            aria-pressed={previewed !== undefined}
            className={`${SEGMENT} ${previewed ? ACTIVE_SEGMENT : IDLE_SEGMENT}`}
          >
            当前版
          </button>
        </div>
      </div>

      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.02]">
        {thumbnail?.dataUrl ? (
          <img src={thumbnail.dataUrl} alt={label} className="h-full w-full object-contain" />
        ) : (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {previewed ? '这版还没有图' : '暂无原图'}
          </span>
        )}
      </div>
    </section>
  )
}
