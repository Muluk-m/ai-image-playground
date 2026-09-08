import type { ExportPreset } from '@image-playground/shared'
import { DownloadIcon, ZoomIcon } from '../../../components/icons'
import { downloadExportedImage, type ExportFit } from '../../../lib/imageExport'
import { useStore } from '../../../store'
import AssetThumb from '../../library/components/AssetThumb'
import { type GalleryVersion, shotFileName } from '../lib/gallery'
import { VERSION_STATE_LABELS } from '../lib/versionProgress'
import { useProductShotsStore } from '../store'
import MattedThumb from './MattedThumb'
import {
  CheckIcon,
  MatteIcon,
  PlanIcon,
  RetryIcon,
  VERSION_ACTION_ROW,
  VERSION_ICON_BUTTON,
  VersionTags,
  VersionTitle,
} from './versionParts'

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function VersionCard({
  item,
  fit,
  preset,
  onOpen,
  onChoose,
  onRetry,
}: {
  item: GalleryVersion
  fit: ExportFit
  preset: ExportPreset
  /** 打开大图查看器，翻页范围由总览给。 */
  onOpen: (imageId: string) => void
  onChoose: () => void
  onRetry: () => void
}) {
  const showToast = useStore((s) => s.showToast)
  const matteOverlayVersionId = useProductShotsStore((s) => s.matteOverlayVersionId)
  const toggleMatteOverlay = useProductShotsStore((s) => s.toggleMatteOverlay)
  const openPlanDrawer = useProductShotsStore((s) => s.openPlanDrawer)
  const selectImage = useProductShotsStore((s) => s.selectImage)
  const previewVersion = useProductShotsStore((s) => s.previewVersion)
  const [first] = item.outputImageIds
  const label = `原图 ${item.imageIndex + 1} 第 ${item.versionIndex + 1} 版`
  const matte = item.version.mattePreviewImageId
  const overlaid = matte !== undefined && matteOverlayVersionId === item.version.id

  const preview = () => {
    // selectImage 会清掉预览，先切原图再落这一版。
    selectImage(item.imageId)
    previewVersion(item.version.id)
  }

  return (
    <li
      data-product-shots-gallery-item
      className={`group flex flex-col gap-1 rounded-xl border p-1.5 transition ${
        item.chosen
          ? 'border-blue-400 bg-blue-500/5 dark:border-blue-500/50'
          : 'border-gray-200 dark:border-white/[0.08]'
      }`}
    >
      <div className="relative aspect-square overflow-hidden rounded-lg border border-gray-200 dark:border-white/[0.08]">
        <button
          type="button"
          data-product-shots-preview
          onClick={preview}
          onDoubleClick={() => first && onOpen(first)}
          aria-label={`预览${label}`}
          className="block h-full w-full"
        >
          {overlaid ? (
            <MattedThumb imageId={item.imageId} overlayImageId={matte} alt={label} />
          ) : first ? (
            <AssetThumb imageId={first} alt={label} />
          ) : (
            <span className="flex h-full items-center justify-center text-xs text-gray-400 dark:text-gray-500">
              {VERSION_STATE_LABELS[item.state]}
            </span>
          )}
        </button>
        {first && (
          <>
            <button
              type="button"
              data-product-shots-choose
              onClick={onChoose}
              aria-pressed={item.chosen}
              title={item.chosen ? '取消选用' : '用这版'}
              aria-label={item.chosen ? '取消选用' : '用这版'}
              className={`absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border transition ${
                item.chosen
                  ? 'border-blue-500 bg-blue-500 text-white'
                  : 'border-white/80 bg-black/35 text-transparent hover:text-white/70'
              }`}
            >
              <CheckIcon className="h-3 w-3" />
            </button>
            <button
              type="button"
              data-product-shots-zoom
              onClick={() => onOpen(first)}
              title="放大查看"
              aria-label="放大查看"
              className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition hover:bg-black/70 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <ZoomIcon className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      <VersionTitle index={item.versionIndex} version={item.version} />
      <VersionTags version={item.version} state={item.state} />

      <div className={`mt-auto ${VERSION_ACTION_ROW}`}>
        <button
          type="button"
          onClick={() => openPlanDrawer(item.version.id)}
          title="查看方案"
          aria-label="查看方案"
          className={VERSION_ICON_BUTTON}
        >
          <PlanIcon className="h-4 w-4" />
        </button>
        {matte && (
          <button
            type="button"
            onClick={() => toggleMatteOverlay(item.version.id)}
            aria-pressed={overlaid}
            title="看蒙版"
            aria-label="看蒙版"
            className={`${VERSION_ICON_BUTTON} ${overlaid ? 'bg-blue-500/10 text-blue-600 dark:text-blue-300' : ''}`}
          >
            <MatteIcon className="h-4 w-4" />
          </button>
        )}
        {first && (
          <button
            type="button"
            onClick={() => {
              downloadExportedImage(
                shotFileName(item.imageIndex, item.versionIndex),
                first,
                fit,
                preset,
              ).catch((error: unknown) => showToast(`下载失败：${reasonOf(error)}`, 'error'))
            }}
            title="下载"
            aria-label="下载"
            className={VERSION_ICON_BUTTON}
          >
            <DownloadIcon className="h-4 w-4" />
          </button>
        )}
        {item.state === 'error' && (
          <button
            type="button"
            onClick={onRetry}
            title="重跑"
            aria-label="重跑"
            className={VERSION_ICON_BUTTON}
          >
            <RetryIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  )
}
