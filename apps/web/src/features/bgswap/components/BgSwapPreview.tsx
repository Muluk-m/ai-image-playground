import { useShallow } from 'zustand/react/shallow'
import { CARD } from '../../../components/panelStyles'
import { useImageThumbnail } from '../../../hooks/useImageThumbnail'
import { useBgSwapStore } from '../store'

const SEGMENT = 'rounded-md px-2.5 py-1 text-xs transition'

export default function BgSwapPreview() {
  const images = useBgSwapStore(useShallow((s) => s.draft.images))
  const selectedImageId = useBgSwapStore((s) => s.selectedImageId)
  const selected = images.find((image) => image.imageId === selectedImageId)
  const index = images.findIndex((image) => image.imageId === selectedImageId)
  const thumbnail = useImageThumbnail(selected?.imageId)

  return (
    <section data-bgswap-column="preview" className={CARD}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          {selected ? `原图 ${index + 1}` : '预览'}
        </h2>
        <div className="flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-900">
          <button
            type="button"
            aria-pressed="true"
            className={`${SEGMENT} bg-white font-medium text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-50`}
          >
            原图
          </button>
          <button
            type="button"
            disabled={(selected?.versions.length ?? 0) === 0}
            className={`${SEGMENT} text-gray-500 disabled:opacity-50 dark:text-gray-400`}
          >
            当前版
          </button>
        </div>
      </div>

      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.02]">
        {thumbnail?.dataUrl ? (
          <img
            src={thumbnail.dataUrl}
            alt={`原图 ${index + 1}`}
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="text-xs text-gray-400 dark:text-gray-500">暂无原图</span>
        )}
      </div>
    </section>
  )
}
