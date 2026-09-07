import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import Overlay from '../../../components/Overlay'
import { PRIMARY_BUTTON } from '../../../components/panelStyles'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { useProductShotsStore } from '../store'

export default function SourceLibraryPicker() {
  const assets = useLibraryStore(
    useShallow((s) => [...s.assets].sort((a, b) => b.lastUsedAt - a.lastUsedAt)),
  )
  const [picked, setPicked] = useState<string[]>([])

  const { closeSourcePicker, addImagesFromAssets } = useProductShotsStore.getState()
  const toggle = (assetId: string) =>
    setPicked((ids) =>
      ids.includes(assetId) ? ids.filter((id) => id !== assetId) : [...ids, assetId],
    )

  return (
    <Overlay onClose={closeSourcePicker}>
      <div
        data-product-shots-source-picker
        className="relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-white/50 bg-white p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 dark:ring-white/10"
      >
        <h3 className="mb-3 text-base font-semibold text-gray-800 dark:text-gray-100">
          从素材库选原图
        </h3>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {assets.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">素材库还是空的</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {assets.map((asset) => (
                <li key={asset.id}>
                  <button
                    type="button"
                    onClick={() => toggle(asset.id)}
                    aria-pressed={picked.includes(asset.id)}
                    className={`w-full overflow-hidden rounded-xl border transition ${
                      picked.includes(asset.id)
                        ? 'border-blue-400 ring-2 ring-blue-400/30'
                        : 'border-gray-200 hover:border-blue-300 dark:border-white/[0.08]'
                    }`}
                  >
                    <span className="block aspect-square">
                      <AssetThumb imageId={asset.imageId} alt={asset.name} />
                    </span>
                    <span className="block truncate px-2 py-1 text-xs text-gray-700 dark:text-gray-200">
                      {asset.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            disabled={picked.length === 0}
            onClick={() => {
              void addImagesFromAssets(picked)
              closeSourcePicker()
            }}
            className={PRIMARY_BUTTON}
          >
            加入 {picked.length} 张
          </button>
        </div>
      </div>
    </Overlay>
  )
}
