import { useRef } from 'react'
import { FIELD, OUTLINE_BUTTON } from '../../../components/panelStyles'
import {
  PRODUCT_ANGLE_LABELS,
  PRODUCT_ANGLES,
  type ProductAngle,
  type ProductAsset,
} from '../../../lib/productAngle'
import type { AssetRecord } from '../types'
import AssetThumb from './AssetThumb'

interface ProductAssetPickerProps {
  assets: readonly AssetRecord[]
  selected: readonly ProductAsset[]
  /** 上传按钮与隐藏 input 的名字，两处 UI 各自不同。 */
  uploadLabel: string
  onToggle: (assetId: string) => void
  onAngleChange: (assetId: string, angle: ProductAngle) => void
  onUpload: (files: File[]) => void
}

/** 素材多选加角度标注：复刻套图的产品素材与换背景的素材弹层共用这一份。 */
export default function ProductAssetPicker({
  assets,
  selected,
  uploadLabel,
  onToggle,
  onAngleChange,
  onUpload,
}: ProductAssetPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const angleOf = (assetId: string): ProductAngle | null =>
    selected.find((product) => product.assetId === assetId)?.angle ?? null

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={OUTLINE_BUTTON}
        >
          {uploadLabel}
        </button>
        <span className="text-xs text-gray-400 dark:text-gray-500">已选 {selected.length} 张</span>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label={uploadLabel}
          onChange={(e) => {
            onUpload([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
      </div>

      {assets.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">素材库还是空的</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {assets.map((asset) => {
            const angle = angleOf(asset.id)
            return (
              <li key={asset.id} className="flex flex-col gap-1.5">
                <button
                  type="button"
                  onClick={() => onToggle(asset.id)}
                  aria-pressed={angle !== null}
                  className={`overflow-hidden rounded-xl border transition ${
                    angle !== null
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
                {angle !== null && (
                  <select
                    value={angle}
                    data-angle-for={asset.id}
                    aria-label={`${asset.name} 角度`}
                    onChange={(e) => onAngleChange(asset.id, e.target.value as ProductAngle)}
                    className={FIELD}
                  >
                    {PRODUCT_ANGLES.map((option) => (
                      <option key={option} value={option}>
                        {PRODUCT_ANGLE_LABELS[option]}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
