import { useShallow } from 'zustand/react/shallow'
import { CARD, OUTLINE_BUTTON } from '../../../components/panelStyles'
import { PRODUCT_ANGLE_LABELS } from '../../../lib/productAngle'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { useProductShotsStore } from '../store'
import ProductPicker from './ProductPicker'

export default function ProductBar() {
  const productAssets = useProductShotsStore(useShallow((s) => s.draft.productAssets))
  const pickerOpen = useProductShotsStore((s) => s.productPickerOpen)
  const assets = useLibraryStore(useShallow((s) => s.assets))

  const { openProductPicker } = useProductShotsStore.getState()

  return (
    <section data-product-shots-product className={`${CARD} mb-4`}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">我的产品</h2>
        {productAssets.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            还没选产品素材，换产品与借创意重做要用它
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {productAssets.map((product) => {
              const asset = assets.find((item) => item.id === product.assetId)
              return (
                <li key={product.assetId} className="w-14">
                  <span className="block h-14 w-14 overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
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
        <button type="button" onClick={openProductPicker} className={`ml-auto ${OUTLINE_BUTTON}`}>
          {productAssets.length === 0 ? '选素材' : '换素材'}
        </button>
      </div>

      {pickerOpen && <ProductPicker />}
    </section>
  )
}
