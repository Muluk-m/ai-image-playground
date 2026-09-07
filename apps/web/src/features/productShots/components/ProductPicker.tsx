import { useShallow } from 'zustand/react/shallow'
import DropOverlay from '../../../components/DropOverlay'
import Overlay from '../../../components/Overlay'
import { PRIMARY_BUTTON } from '../../../components/panelStyles'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import ProductAssetPicker from '../../library/components/ProductAssetPicker'
import { useLibraryStore } from '../../library/store'
import { useProductShotsStore } from '../store'

export default function ProductPicker() {
  const productAssets = useProductShotsStore(useShallow((s) => s.draft.productAssets))
  const assets = useLibraryStore(
    useShallow((s) => [...s.assets].sort((a, b) => b.lastUsedAt - a.lastUsedAt)),
  )

  const { closeProductPicker, toggleProductAsset, setProductAngle, importProductFiles } =
    useProductShotsStore.getState()
  const upload = (files: File[]) => void importProductFiles(files)
  const { dragging, dropZoneProps } = useImageDropZone(upload)

  return (
    <Overlay onClose={closeProductPicker}>
      <div
        {...dropZoneProps}
        data-product-shots-product-picker
        className="relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-white/50 bg-white p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 dark:ring-white/10"
      >
        <h3 className="mb-3 text-base font-semibold text-gray-800 dark:text-gray-100">产品素材</h3>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <ProductAssetPicker
            assets={assets}
            selected={productAssets}
            uploadLabel="上传产品素材"
            onToggle={toggleProductAsset}
            onAngleChange={setProductAngle}
            onUpload={upload}
          />
        </div>

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={closeProductPicker} className={PRIMARY_BUTTON}>
            完成
          </button>
        </div>

        {dragging && <DropOverlay label="松开即上传" />}
      </div>
    </Overlay>
  )
}
