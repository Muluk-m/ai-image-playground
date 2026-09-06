import { useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CloseIcon } from '../../../components/icons'
import Pending from '../../../components/Pending'
import {
  CARD,
  FIELD,
  LABEL,
  NOTICE,
  OUTLINE_BUTTON,
  PRIMARY_BUTTON,
} from '../../../components/panelStyles'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import AssetThumb from '../../library/components/AssetThumb'
import { DIAGRAM_LABEL, isDiagram } from '../lib/scene'
import { useBgSwapStore } from '../store'

export default function BgSwapSources() {
  const images = useBgSwapStore(useShallow((s) => s.draft.images))
  const selectedImageId = useBgSwapStore((s) => s.selectedImageId)
  const listingUrl = useBgSwapStore((s) => s.listingUrl)
  const listingLoading = useBgSwapStore((s) => s.listingLoading)
  const listingStartedAt = useBgSwapStore((s) => s.listingStartedAt)
  const listingNotice = useBgSwapStore((s) => s.listingNotice)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { setListingUrl, fetchListing, importFiles, removeImage, selectImage } =
    useBgSwapStore.getState()

  return (
    <section data-bgswap-column="sources" className={CARD}>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">原图</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">{images.length} 张</span>
      </div>

      {isClientCapabilityEnabled('remix:listing') && (
        <>
          <label className={LABEL} htmlFor="bgswap-listing-url">
            商品链接
          </label>
          <div className="mt-1.5 flex flex-col gap-2">
            <input
              id="bgswap-listing-url"
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
        </>
      )}

      {listingNotice && <p className={`mt-2 ${NOTICE}`}>{listingNotice}</p>}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={`w-full ${OUTLINE_BUTTON}`}
        >
          上传原图
        </button>
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
      </div>

      {images.length > 0 && (
        <ul className="mt-3 flex max-h-96 flex-col gap-1.5 overflow-y-auto">
          {images.map((image, index) => (
            <li key={image.imageId} data-bgswap-source className="relative">
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
    </section>
  )
}
