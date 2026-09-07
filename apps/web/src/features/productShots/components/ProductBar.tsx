import { useShallow } from 'zustand/react/shallow'
import { LABEL, OUTLINE_BUTTON } from '../../../components/panelStyles'
import Segmented from '../../../components/Segmented'
import { PRODUCT_ANGLE_LABELS } from '../../../lib/productAngle'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { useProductShotsStore } from '../store'
import {
  LEGACY_PRODUCT_SOURCE_LABELS,
  LEGACY_PRODUCT_SOURCES,
  LEGACY_TARGET_LABELS,
  LEGACY_TARGETS,
} from '../types'
import ProductPicker from './ProductPicker'

export default function ProductBar() {
  const productSource = useProductShotsStore((s) => s.draft.productSource)
  const target = useProductShotsStore((s) => s.draft.target)
  const productAssets = useProductShotsStore(useShallow((s) => s.draft.productAssets))
  const pickerOpen = useProductShotsStore((s) => s.productPickerOpen)
  const assets = useLibraryStore(useShallow((s) => s.assets))

  const { setProductSource, setSwapTarget, openProductPicker } = useProductShotsStore.getState()

  return (
    <div data-product-shots-product className="flex flex-col gap-3">
      <div>
        <span className={LABEL}>产品来源</span>
        <div className="mt-1.5">
          <Segmented
            label="产品来源"
            options={LEGACY_PRODUCT_SOURCES}
            labels={LEGACY_PRODUCT_SOURCE_LABELS}
            value={productSource}
            onChange={setProductSource}
          />
        </div>
      </div>

      {productSource === 'asset' && (
        <>
          <div>
            <span className={LABEL}>目标</span>
            <div className="mt-1.5">
              <Segmented
                label="目标"
                options={LEGACY_TARGETS}
                labels={LEGACY_TARGET_LABELS}
                value={target}
                onChange={setSwapTarget}
              />
            </div>
          </div>

          <div>
            <span className={LABEL}>产品素材</span>
            {productAssets.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-2">
                {productAssets.map((product) => {
                  const asset = assets.find((item) => item.id === product.assetId)
                  return (
                    <li key={product.assetId} className="w-16">
                      <span className="block h-16 w-16 overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
                        <AssetThumb imageId={asset?.imageId ?? ''} alt={asset?.name ?? ''} />
                      </span>
                      <span className="mt-0.5 block truncate text-center text-[10px] text-gray-500 dark:text-gray-400">
                        {PRODUCT_ANGLE_LABELS[product.angle]}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            <button
              type="button"
              onClick={openProductPicker}
              className={`mt-1.5 ${OUTLINE_BUTTON}`}
            >
              选素材
            </button>
          </div>
        </>
      )}

      {pickerOpen && <ProductPicker />}
    </div>
  )
}
