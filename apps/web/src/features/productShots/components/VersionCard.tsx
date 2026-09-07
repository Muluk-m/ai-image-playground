import type { ExportPreset } from '@image-playground/shared'
import type { SVGProps } from 'react'
import { DownloadIcon, ZoomIcon } from '../../../components/icons'
import { useImageThumbnail } from '../../../hooks/useImageThumbnail'
import { downloadExportedImage, type ExportFit } from '../../../lib/imageExport'
import { useStore } from '../../../store'
import AssetThumb from '../../library/components/AssetThumb'
import { actionLabel } from '../lib/actions'
import { type GalleryVersion, shotFileName } from '../lib/gallery'
import { VERSION_STATE_LABELS } from '../lib/versionProgress'
import { useProductShotsStore } from '../store'
import MatteTag from './MatteTag'

/** 图标操作行：指针悬停或键盘聚焦才露出，触摸屏没有 hover，常显。 */
const ACTION_ROW =
  'mt-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100'

const ICON_BUTTON =
  'flex h-6 w-6 items-center justify-center rounded-md text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/[0.08] dark:hover:text-gray-100'

function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
    </svg>
  )
}

function PlanIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9h6m-6 4h4"
      />
    </svg>
  )
}

function MatteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 3l9 5-9 5-9-5 9-5zm9 9l-9 5-9-5m18 4l-9 5-9-5"
      />
    </svg>
  )
}

function RetryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 00-14.7-2.7M4 15a8 8 0 0014.7 2.7"
      />
    </svg>
  )
}

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
  const overlay = useImageThumbnail(overlaid ? matte : undefined)

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
            <>
              <AssetThumb imageId={item.imageId} alt={label} />
              {overlay?.dataUrl && (
                <img
                  src={overlay.dataUrl}
                  alt="蒙版"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
            </>
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

      <span
        data-product-shots-version-title
        className="flex items-center gap-1 overflow-hidden whitespace-nowrap text-xs text-gray-700 dark:text-gray-200"
      >
        <span className="shrink-0 font-medium">第 {item.versionIndex + 1} 版</span>
        <span className="truncate rounded bg-violet-500/10 px-1 text-[11px] text-violet-700 dark:text-violet-300">
          {actionLabel(item.version.mode, item.version.level)}
        </span>
      </span>

      <span
        data-product-shots-version-tags
        className="flex items-center gap-1 overflow-hidden whitespace-nowrap text-[11px] text-gray-500 dark:text-gray-400"
      >
        {item.state !== 'done' && (
          <span className="shrink-0">{VERSION_STATE_LABELS[item.state]}</span>
        )}
        <MatteTag version={item.version} className="truncate px-1" />
        {item.version.promptEdited && (
          <span className="shrink-0 rounded bg-amber-500/10 px-1 text-amber-700 dark:text-amber-300">
            手改
          </span>
        )}
      </span>

      <div className={ACTION_ROW}>
        <button
          type="button"
          onClick={() => openPlanDrawer(item.version.id)}
          title="查看方案"
          aria-label="查看方案"
          className={ICON_BUTTON}
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
            className={`${ICON_BUTTON} ${overlaid ? 'bg-blue-500/10 text-blue-600 dark:text-blue-300' : ''}`}
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
            className={ICON_BUTTON}
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
            className={ICON_BUTTON}
          >
            <RetryIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  )
}
