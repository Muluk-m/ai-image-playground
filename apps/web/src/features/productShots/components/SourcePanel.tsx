import { useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import DropOverlay from '../../../components/DropOverlay'
import { CloseIcon } from '../../../components/icons'
import Pending from '../../../components/Pending'
import {
  CARD,
  FIELD,
  LABEL,
  NOTICE,
  OUTLINE_BUTTON,
  PANEL_TITLE,
  PRIMARY_BUTTON,
} from '../../../components/panelStyles'
import Segmented from '../../../components/Segmented'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { usePasteImageFiles } from '../../../hooks/usePasteImageFiles'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import AssetThumb from '../../library/components/AssetThumb'
import { DIAGRAM_LABEL, isDiagram } from '../lib/scene'
import { useProductShotsStore } from '../store'
import { SOURCE_MODE_LABELS, SOURCE_MODES } from '../types'
import SourceLibraryPicker from './SourceLibraryPicker'

export default function SourcePanel() {
  const images = useProductShotsStore(useShallow((s) => s.draft.images))
  const selectedImageId = useProductShotsStore((s) => s.selectedImageId)
  const sourcePickerOpen = useProductShotsStore((s) => s.sourcePickerOpen)
  const listingUrl = useProductShotsStore((s) => s.listingUrl)
  const listingLoading = useProductShotsStore((s) => s.listingLoading)
  const listingStartedAt = useProductShotsStore((s) => s.listingStartedAt)
  const listingNotice = useProductShotsStore((s) => s.listingNotice)
  const requested = useProductShotsStore((s) => s.sourceMode)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const {
    setSourceMode,
    setListingUrl,
    fetchListing,
    importFiles,
    openSourcePicker,
    removeImage,
    selectImage,
  } = useProductShotsStore.getState()

  const openFilePicker = () => fileInputRef.current?.click()
  const { dragging, dropZoneProps } = useImageDropZone((files) => void importFiles(files))
  usePasteImageFiles('product', (files) => void importFiles(files))

  // 抓图能力关掉时链接这一档整个不出现，选中它的老状态回落到上传。
  const offered = SOURCE_MODES.filter(
    (mode) => mode !== 'listing' || isClientCapabilityEnabled('remix:listing'),
  )
  const sourceMode = offered.includes(requested) ? requested : 'upload'

  return (
    <section data-product-shots-column="sources" className={CARD}>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className={PANEL_TITLE}>原图</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">{images.length} 张</span>
      </div>

      <Segmented
        label="图片来源"
        options={offered}
        labels={SOURCE_MODE_LABELS}
        value={sourceMode}
        onChange={setSourceMode}
      />

      {sourceMode === 'listing' && (
        <div className="mt-3">
          <label className={LABEL} htmlFor="product-shots-listing-url">
            商品链接
          </label>
          <div className="mt-1.5 flex flex-col gap-2">
            <input
              id="product-shots-listing-url"
              value={listingUrl}
              onChange={(e) => setListingUrl(e.target.value)}
              placeholder="https://www.amazon.com/dp/..."
              className={FIELD}
            />
            <button
              type="button"
              onClick={() => void fetchListing()}
              disabled={listingLoading}
              className={PRIMARY_BUTTON}
            >
              {listingLoading ? (
                <Pending label="抓取中" startedAt={listingStartedAt} />
              ) : (
                '抓取图集'
              )}
            </button>
          </div>
          {listingNotice && <p className={`mt-2 ${NOTICE}`}>{listingNotice}</p>}
        </div>
      )}

      {sourceMode === 'upload' && (
        <div className="mt-3">
          <button type="button" onClick={openFilePicker} className={`w-full ${OUTLINE_BUTTON}`}>
            上传原图
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="上传原图"
        onChange={(e) => {
          void importFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />

      {sourceMode === 'library' && (
        <div className="mt-3">
          <button type="button" onClick={openSourcePicker} className={`w-full ${OUTLINE_BUTTON}`}>
            从素材库选原图
          </button>
        </div>
      )}

      {sourcePickerOpen && <SourceLibraryPicker />}

      <div {...dropZoneProps} className="relative mt-3">
        {images.length === 0 ? (
          <button
            type="button"
            onClick={openFilePicker}
            className="w-full rounded-xl border border-dashed border-gray-300 px-3 py-8 text-xs text-gray-500 transition hover:border-blue-400 hover:text-blue-600 dark:border-white/[0.15] dark:text-gray-400 dark:hover:border-blue-500/50"
          >
            拖入图片，或点击上传
          </button>
        ) : (
          <ul className="flex max-h-96 flex-col gap-1.5 overflow-y-auto">
            {images.map((image, index) => (
              <li key={image.imageId} data-product-shots-source className="relative">
                <button
                  type="button"
                  onClick={() => selectImage(image.imageId)}
                  aria-pressed={selectedImageId === image.imageId}
                  className={`flex w-full items-center gap-2 rounded-xl border p-1.5 pr-8 text-left transition ${
                    selectedImageId === image.imageId
                      ? 'border-blue-400 bg-blue-500/5 dark:border-blue-500/50'
                      : 'border-gray-200 hover:border-blue-300 dark:border-white/[0.08]'
                  }`}
                >
                  <span className="block h-10 w-10 shrink-0 overflow-hidden rounded-lg">
                    <AssetThumb imageId={image.imageId} alt={`原图 ${index + 1}`} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-xs text-gray-700 dark:text-gray-200">
                      原图 {index + 1}
                    </span>
                    {isDiagram(image.sceneType) && (
                      <span className="truncate rounded bg-amber-500/10 px-1 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                        {DIAGRAM_LABEL}
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => removeImage(image.imageId)}
                  aria-label={`移除原图 ${index + 1}`}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full bg-black/45 p-1 text-white transition hover:bg-black/65"
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {dragging && <DropOverlay label="松开即上传" />}
      </div>
    </section>
  )
}
